// B3: historical cohort recovery (dry run, digest-confirmed emulator execution, credential-free Cloud Shell dry run).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");

let store = createMemoryFirestore({ projectId: "demo-recovery" }); // replaced for each test; refs are plain paths
const transactions = [];
const proxy = { get projectId() { return store.projectId; }, get databaseId() { return store.databaseId; }, collection: name => store.collection(name),
  runTransaction: (run, options) => { transactions.push(options?.readOnly === true ? "read" : "write"); return store.runTransaction(run, options); } };
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: proxy } };
const { planRecovery, executeRecovery } = require("../src/services/historicalCohortRecovery.service");
const { cohortIdFor } = require("../src/services/verifiedPlantingCohortEligibility");
const { ensureCohortForAuthoritativeReportInTransaction: ensure } = require("../src/services/verifiedPlantingCohort.service");
const cli = require("../scripts/recoverHistoricalCohorts");
const { PRODUCTION_PROJECT } = require("../src/services/monitoringLifecycleBackfill.service");
const { REQUIRED_READ_PERMISSIONS } = require("../scripts/cloudShellMonitoringPreflight");

const FLAGS = ["VERIFIED_PLANTING_COHORT_ENABLED", "PERMANENT_SAMPLE_WRITE_PAUSED", "PERMANENT_SAMPLE_PILOT_ENABLED", "PERMANENT_SAMPLE_PILOT_USER_IDS", "PERMANENT_SAMPLE_PILOT_COHORT_IDS"];
const clear = () => FLAGS.forEach(name => delete process.env[name]);
const PRIVATE = { requesterName: "PRIVATE-NAME", participantId: "PRIVATE-PARTICIPANT", photos: ["PRIVATE-PHOTO"], latitude: 12.3456, contactNumber: "PRIVATE-PHONE", remarks: "PRIVATE-REMARKS" };
const REPORT = { ...PRIVATE, reportNumber: "RPT-2026-001", reportType: "parent", reportingProgress: "Completed", acceptedQuantity: 25, eventId: "event", siteId: "site", requestId: "request",
  plantingDate: "2026-09-01", reportingPolicy: { monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "PERMANENT_SAMPLE" }, policyVersion: 1, approvedBy: "PRIVATE-ADMIN", sampling: { percentage: 10, minimum: null } } };
function seed(id, change = {}, omit = []) {
  const row = { ...structuredClone(REPORT), ...structuredClone(change) };
  omit.forEach(key => delete row[key]);
  store.seed("plantingReports", id, row);
}
test.beforeEach(() => {
  store = createMemoryFirestore({ projectId: "demo-recovery" }); transactions.length = 0; clear();
  process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true";
  store.seed("sites", "site", { siteName: "PRIVATE-SITE", status: "Active", latitude: 12.6 });
  store.seed("sites", "other-site", { status: "active" });
  store.seed("sites", "closed", { status: "Inactive" });
  store.seed("events", "event", { ...PRIVATE, plantingSiteId: "site", sourceRequestId: "request", seedlingItems: [{ inventoryId: "inv", species: "Narra", quantity: 25 }] });
  store.seed("events", "siteless", { seedlingItems: [] });
  store.seed("monitoringRecords", "MON-1", { plantingReportId: "r", monitoringNumber: "MON-2026-001", history: [{ v: 1 }] });
  store.seed("verifiedPlantingCohorts", "VPC-unrelated", { source: { plantingReportId: "unrelated" }, samplingPlan: { version: 3 }, baseline: { approvalStatus: "APPROVED" } });
});
test.after(clear);
const dump = () => JSON.stringify(["plantingReports", "events", "sites", "monitoringRecords", "sampleMonitoringVisits", "verifiedPlantingCohorts"]
  .map(name => store.ids(name).sort().filter(id => id !== cohortIdFor("r")).map(id => [name, id, store.read(name, id)])));
const one = async id => (await planRecovery({ db: proxy, reportIds: [id] })).reports[0];
const policy = value => ({ reportingPolicy: value });

const DECISIONS = [
  ["ELIGIBLE_MISSING_COHORT", "matching flat and nested policy", {}],
  ["ELIGIBLE_MISSING_COHORT", "nested-only policy", policy({ definition: { monitoring: "PERMANENT_SAMPLE" } })],
  ["ELIGIBLE_MISSING_COHORT", "flat-only policy", policy({ monitoring: "PERMANENT_SAMPLE" })],
  ["ELIGIBLE_MISSING_COHORT", "standalone Approved report", { reportType: "final", verificationStatus: "Approved", quantityPlanted: 12 }],
  ["ELIGIBLE_MISSING_COHORT", "site only on the event", {}, ["siteId"]],
  ["ELIGIBLE_MISSING_COHORT", "no event at all", {}, ["eventId"]],
  ["INCOMPATIBLE_POLICY", "spot check", policy({ monitoring: "STAFF_SPOT_CHECK" })],
  ["INCOMPATIBLE_POLICY", "nested none", policy({ definition: { monitoring: "NONE" } })],
  ["CONFLICTING_POLICY", "flat and nested differ", policy({ monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "STAFF_SPOT_CHECK" } })],
  ["REQUIRES_MENRO_APPROVAL", "no snapshot", {}, ["reportingPolicy"]],
  ["REQUIRES_MENRO_APPROVAL", "empty snapshot", policy({})],
  ["REQUIRES_MENRO_APPROVAL", "blank snapshot", policy({ monitoring: "  " })],
  ["REQUIRES_MENRO_APPROVAL", "pending MENRO policy", policy({ monitoring: "PENDING_MENRO_POLICY", definition: { monitoring: "PENDING_MENRO_POLICY" } })],
  ["REQUIRES_MENRO_APPROVAL", "pending policy status", policy({ monitoring: "PERMANENT_SAMPLE", policyStatus: "PENDING_MENRO_POLICY" })],
  ["REQUIRES_MENRO_APPROVAL", "unknown method", policy({ monitoring: "PRIVATE-UNKNOWN-VALUE" })],
  ["REQUIRES_MENRO_APPROVAL", "stored text LEGACY", policy({ monitoring: "LEGACY" })],
  ["REQUIRES_MENRO_APPROVAL", "a list instead of a method", policy({ monitoring: ["PERMANENT_SAMPLE"] })],
  ["UNVERIFIED_REPORT", "parent not completed", { reportingProgress: "In Progress" }],
  ["UNVERIFIED_REPORT", "standalone not approved", { reportType: "final", verificationStatus: "Pending", quantityPlanted: 12 }],
  ["MISSING_AUTHORITATIVE_QUANTITY", "zero accepted quantity", { acceptedQuantity: 0 }],
  ["MISSING_AUTHORITATIVE_QUANTITY", "fractional quantity", { acceptedQuantity: 2.5 }],
  ["MISSING_AUTHORITATIVE_QUANTITY", "absent quantity", {}, ["acceptedQuantity"]],
  ["INVALID_SITE", "missing on report and event", { eventId: "siteless" }, ["siteId"]],
  ["INVALID_SITE", "site not found", { siteId: "gone" }, ["eventId"]],
  ["INVALID_SITE", "inactive site", { siteId: "closed" }, ["eventId"]],
  ["INVALID_SITE", "report and event disagree", { siteId: "other-site" }],
  ["INVALID_SITE", "unsafe site reference", { siteId: "a/b" }, ["eventId"]],
  ["INVALID_SITE", "unsafe event reference", { eventId: "a/b" }],
  ["INVALID_SITE", "padded event reference (provisioning would read a different event)", { eventId: " event " }],
  ["INVALID_SITE", "event reference that is not text", { eventId: 5 }],
  ["INVALID_SITE", "padded site reference", { siteId: " site " }],
  ["REPORT_ARCHIVED", "archived", { archived: true }],
];
for (const [decision, label, change, omit] of DECISIONS) {
  test(`decision ${decision}: ${label}`, async () => {
    seed("r", change, omit);
    const before = dump();
    const row = await one("r");
    assert.equal(row.decision, decision);
    assert.equal(row.reportNumber, "RPT-2026-001");
    assert.equal(row.expectedCohortId, cohortIdFor("r"));
    if (decision === "ELIGIBLE_MISSING_COHORT") { assert.deepEqual(row.reasons, []); assert.ok(row.quantity > 0); } else assert.ok(row.reasons.includes(decision));
    assert.deepEqual(transactions, ["read"]); assert.deepEqual(store.appliedWrites, []); assert.equal(dump(), before);
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE|12\.3456/);
  });
}

test("decisions REPORT_NOT_FOUND, ALREADY_PROVISIONED and both COHORT_IDENTITY_CONFLICT cases", async () => {
  assert.deepEqual([(await one("r")).decision, (await one("r")).reportNumber], ["REPORT_NOT_FOUND", null]);
  seed("r");
  store.seed("verifiedPlantingCohorts", cohortIdFor("r"), { source: { plantingReportId: "r" } });
  assert.equal((await one("r")).decision, "ALREADY_PROVISIONED");
  store.seed("verifiedPlantingCohorts", "VPC-second", { source: { plantingReportId: "r" } });
  assert.equal((await one("r")).decision, "COHORT_IDENTITY_CONFLICT", "a second cohort claims the report");
  seed("claimed"); store.seed("verifiedPlantingCohorts", "VPC-claims", { source: { plantingReportId: "claimed" } });
  assert.equal((await one("claimed")).decision, "COHORT_IDENTITY_CONFLICT", "another cohort already claims the report");
  seed("occupied"); store.seed("verifiedPlantingCohorts", cohortIdFor("occupied"), { source: { plantingReportId: "someone-else" } });
  assert.equal((await one("occupied")).decision, "COHORT_IDENTITY_CONFLICT", "the deterministic ID belongs to another report");
});

test("several problems are all listed; multi-species and a missing planting date are notes only", async () => {
  seed("r", { acceptedQuantity: 0, siteId: "gone", reportingPolicy: { monitoring: "NONE" } }, ["eventId"]);
  assert.deepEqual((await one("r")).reasons, ["MISSING_AUTHORITATIVE_QUANTITY", "INCOMPATIBLE_POLICY", "INVALID_SITE"]);
  store.seed("events", "event", { plantingSiteId: "site", seedlingItems: [{ inventoryId: "a", species: "Narra", quantity: 10 }, { inventoryId: "b", species: "Molave", quantity: 15 }] });
  seed("multi", {}, ["plantingDate"]);
  const row = await one("multi");
  assert.equal(row.decision, "ELIGIBLE_MISSING_COHORT");
  assert.deepEqual(row.notes, ["MULTI_SPECIES", "MISSING_PLANTING_DATE"]);
});

test("only 1-20 explicit, distinct, valid report IDs are accepted, before any transaction", async () => {
  const many = n => Array.from({ length: n }, (_, i) => `r${i}`);
  for (const reportIds of [undefined, [], "r", many(21), ["r", "r"], [""], ["a/b"], ["*"], [" r"], [5], [null], ["x".repeat(201)], ["__reserved__"], ["r", "____"]]) {
    await assert.rejects(planRecovery({ db: proxy, reportIds }), /\[reports\]/, JSON.stringify(reportIds));
    await assert.rejects(executeRecovery({ db: proxy, reportIds, confirmDigest: "0".repeat(16), ensure }), /\[reports\]/);
  }
  assert.deepEqual(transactions, []);
  assert.equal((await planRecovery({ db: proxy, reportIds: many(20) })).reports.length, 20);
});

test("the digest is stable and changes with any field the decision or the future cohort depends on", async () => {
  seed("r"); seed("s");
  const digest = async (ids = ["r"]) => (await planRecovery({ db: proxy, reportIds: ids })).digest;
  const base = await digest();
  assert.match(base, /^[0-9a-f]{16}$/); assert.equal(await digest(), base);
  assert.notEqual(await digest(["r", "s"]), await digest(["s", "r"]), "order is part of the reviewed plan");
  for (const change of [{ acceptedQuantity: 26 }, { siteId: "other-site" }, { archived: true }, { plantingDate: "2026-09-02" }, { requestId: "other" }, { species: "Molave" },
    policy({ ...REPORT.reportingPolicy, sampling: { percentage: 20, minimum: null } }), policy({ ...REPORT.reportingPolicy, policyVersion: 2 }), policy({ monitoring: "NONE" })]) {
    seed("r", change); assert.notEqual(await digest(), base, JSON.stringify(change));
  }
  seed("r", { requesterName: "Other", remarks: "Other" }); assert.equal(await digest(), base, "unrelated personal fields are not read");
  store.seed("sites", "site", { status: "inactive" }); assert.notEqual(await digest(), base);
  store.seed("sites", "site", { status: "Active", siteName: "Renamed" }); assert.equal(await digest(), base);
  store.seed("events", "event", { plantingSiteId: "site", sourceRequestId: "request", seedlingItems: [{ inventoryId: "inv", species: "Narra", quantity: 24 }] }); assert.notEqual(await digest(), base);
});

const plan = (reportIds = ["r"]) => planRecovery({ db: proxy, reportIds });
const run = async (reportIds = ["r"], options = {}) => executeRecovery({ db: proxy, reportIds, confirmDigest: (await plan(reportIds)).digest, ensure, ...options });

test("execute provisions only the eligible reports, writes one cohort document each and leaves everything else byte-identical", async () => {
  seed("r"); seed("none", policy({ monitoring: "NONE" })); seed("pending", {}, ["reportingPolicy"]);
  const before = dump();
  const result = await run(["none", "r", "pending", "missing"]);
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.results.map(row => [row.reportId, row.status]), [["none", "INCOMPATIBLE_POLICY"], ["r", "PROVISIONED"], ["pending", "REQUIRES_MENRO_APPROVAL"], ["missing", "REPORT_NOT_FOUND"]]);
  assert.deepEqual(store.appliedWrites, [`create verifiedPlantingCohorts/${cohortIdFor("r")}`]);
  assert.equal(dump(), before);
  const cohort = store.read("verifiedPlantingCohorts", cohortIdFor("r"));
  assert.deepEqual([cohort.source.plantingReportId, cohort.source.siteId, cohort.verifiedPlantedQuantity, cohort.baselineStatus], ["r", "site", 25, "NOT_STARTED"]);
  assert.deepEqual(cohort.samplingPolicySnapshot, { percentage: 10, minimum: null, policyVersion: 1, approvedBy: "PRIVATE-ADMIN" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("execute is idempotent: a reviewed repeat reports ALREADY_PROVISIONED and a stale digest stops before any write", async () => {
  seed("r");
  const { digest } = await plan();
  await run(); transactions.length = 0;
  await assert.rejects(executeRecovery({ db: proxy, reportIds: ["r"], confirmDigest: digest, ensure }), error => /\[confirmation\]/.test(error.message) && error.details.digest !== digest);
  assert.deepEqual(transactions, ["read"]);
  assert.deepEqual((await run()).results.map(row => row.status), ["ALREADY_PROVISIONED"]);
  assert.equal(store.appliedWrites.length, 1);
});

test("a missing, malformed or mismatched digest, or a report changed since the dry run, stops before any write transaction", async () => {
  seed("r");
  const { digest } = await plan(); transactions.length = 0;
  for (const confirmDigest of [undefined, "", "xyz", digest.toUpperCase() + "0"]) await assert.rejects(executeRecovery({ db: proxy, reportIds: ["r"], confirmDigest, ensure }), /\[confirmation\]/);
  assert.deepEqual(transactions, []);
  seed("r", { acceptedQuantity: 24 });
  await assert.rejects(executeRecovery({ db: proxy, reportIds: ["r"], confirmDigest: digest, ensure }), /\[confirmation\]/);
  assert.deepEqual(transactions, ["read"]); assert.deepEqual(store.appliedWrites, []);
});

// Applies a change after the digest check (the first, read-only transaction) and before the report's own transaction.
const changedAfterReview = change => ({ ...proxy, projectId: "demo-recovery", collection: proxy.collection, runTransaction: async (runTx, options) => {
  const result = await store.runTransaction(runTx, options); if (options?.readOnly) change(); return result; } });
test("a report, event, site or cohort changed after the digest check is re-decided inside the transaction and not provisioned", async () => {
  for (const [change, status] of [
    [() => seed("r", { acceptedQuantity: 30 }), "REPORT_CHANGED"], [() => seed("r", { archived: true }), "REPORT_CHANGED"],
    [() => seed("r", policy({ monitoring: "NONE" })), "REPORT_CHANGED"], [() => store.seed("sites", "site", { status: "inactive" }), "REPORT_CHANGED"],
    [() => store.seed("verifiedPlantingCohorts", cohortIdFor("r"), { source: { plantingReportId: "r" } }), "ALREADY_PROVISIONED"],
    [() => store.seed("verifiedPlantingCohorts", "VPC-x", { source: { plantingReportId: "r" } }), "COHORT_IDENTITY_CONFLICT"]]) {
    store = createMemoryFirestore({ projectId: "demo-recovery" });
    store.seed("sites", "site", { status: "Active" }); store.seed("events", "event", { plantingSiteId: "site" }); seed("r");
    const { digest } = await plan();
    const result = await executeRecovery({ db: changedAfterReview(change), reportIds: ["r"], confirmDigest: digest, ensure });
    assert.deepEqual(result.results.map(row => row.status), [status]);
    assert.deepEqual(store.appliedWrites, []);
  }
});

test("paused, pilot and flag-off execution reports PROVISIONING_GATED and writes nothing", async () => {
  seed("r");
  for (const env of [{ PERMANENT_SAMPLE_WRITE_PAUSED: "true" }, { VERIFIED_PLANTING_COHORT_ENABLED: "false" }, { VERIFIED_PLANTING_COHORT_ENABLED: "" },
    { PERMANENT_SAMPLE_PILOT_ENABLED: "true", PERMANENT_SAMPLE_PILOT_USER_IDS: '["u"]', PERMANENT_SAMPLE_PILOT_COHORT_IDS: JSON.stringify([cohortIdFor("r")]) }]) {
    clear(); Object.assign(process.env, { VERIFIED_PLANTING_COHORT_ENABLED: "true" }, env);
    assert.deepEqual((await run()).results.map(row => row.status), ["PROVISIONING_GATED"], JSON.stringify(env));
  }
  assert.deepEqual(store.appliedWrites, []);
});

test("created:false maps to ALREADY_PROVISIONED; any write other than the expected cohort is refused", async () => {
  seed("r");
  assert.deepEqual((await run(["r"], { ensure: async () => ({ id: cohortIdFor("r"), created: false }) })).results.map(row => row.status), ["ALREADY_PROVISIONED"]);
  const report = { kind: "doc", collection: "plantingReports", id: "r", path: "plantingReports/r" };
  const other = { kind: "doc", collection: "verifiedPlantingCohorts", id: "VPC-other", path: "verifiedPlantingCohorts/VPC-other" };
  for (const rogue of [tx => tx.update(report, { archived: true }), tx => tx.set(report, {}), tx => tx.delete(report), tx => tx.create(other, {})]) {
    const result = await run(["r"], { ensure: async tx => { rogue(tx); return { id: cohortIdFor("r"), created: true }; } });
    assert.equal(result.status, "STOPPED"); assert.equal(result.failedReportId, "r"); assert.deepEqual(result.results, []);
  }
  assert.deepEqual(store.appliedWrites, []);
});

test("unusual sampling values recover normally and an unsafe event never stops the rest of the batch", async () => {
  seed("text-delay", policy({ ...REPORT.reportingPolicy, sampling: { percentage: 10, minimum: null, firstVisitDelayWeeks: "two" } }));
  seed("huge-delay", policy({ ...REPORT.reportingPolicy, sampling: { percentage: 10, minimum: null, firstVisitDelayWeeks: 1e9 } }));
  seed("number-event", { eventId: 5 }); seed("path-event", { eventId: "a/b" }); seed("r");
  const result = await run(["text-delay", "huge-delay", "number-event", "path-event", "r"]);
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.results.map(row => row.status), ["PROVISIONED", "PROVISIONED", "INVALID_SITE", "INVALID_SITE", "PROVISIONED"]);
});

test("executeRecovery itself refuses a project that is not a demo project, before any transaction", async () => {
  seed("r");
  const { digest } = await plan(); transactions.length = 0;
  for (const projectId of [PRODUCTION_PROJECT, "", undefined]) {
    const db = { projectId, collection: proxy.collection, runTransaction: proxy.runTransaction };
    await assert.rejects(executeRecovery({ db, reportIds: ["r"], confirmDigest: digest, ensure }), /\[environment\].*separate approved plan/);
  }
  assert.deepEqual(transactions, []);
});

test("CLI failures print a bounded, sanitized message", () => {
  const error = new Error("bad ya29.secret-token value\n    at stack line", { cause: new Error("x -----BEGIN PRIVATE KEY-----abc") });
  assert.equal(cli.failureText(error), "RECOVERY STOPPED bad [redacted token] value <- x [redacted key]");
});

test("a failed commit stops the run, reports what completed and leaves the failed report untouched", async () => {
  seed("r"); seed("s");
  const { digest } = await plan(["r", "s"]);
  store.failWriteTransaction(2);
  const result = await executeRecovery({ db: proxy, reportIds: ["r", "s"], confirmDigest: digest, ensure });
  assert.equal(result.status, "STOPPED"); assert.equal(result.failedReportId, "s");
  assert.deepEqual(result.results.map(row => row.status), ["PROVISIONED"]);
  assert.equal(store.read("verifiedPlantingCohorts", cohortIdFor("s")), undefined);
});

// ---- CLI ------------------------------------------------------------------------------------------------------------
const DEMO = "demo-menro-legacy-monitoring-20261106";
const EMULATOR_ENV = Object.freeze({ NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS: "true", GCLOUD_PROJECT: DEMO, FIREBASE_PROJECT_ID: DEMO,
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8381", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9399", FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9398", FIREBASE_STORAGE_BUCKET: `${DEMO}.firebasestorage.app` });
const CLOUD_ENV = Object.freeze({ NODE_ENV: "production", FIREBASE_PROJECT_ID: PRODUCTION_PROJECT });
const CLOUD_ARGS = [`--expected-project=${PRODUCTION_PROJECT}`, "--expected-principal=operator@example.org"];
function harness({ argv, env, email = "operator@example.org", projectId = PRODUCTION_PROJECT }) {
  const opened = [];
  const db = new Proxy(proxy, { get: (target, key) => key === "projectId" ? projectId : target[key] });
  const request = async (method, url, options = {}) => {
    if (url.includes("tokeninfo")) return { status: 200, json: { email, email_verified: "true" } };
    if (url.includes(":testIamPermissions")) return { status: 200, json: { permissions: REQUIRED_READ_PERMISSIONS.filter(p => options.json.permissions.includes(p)) } };
    if (url.includes("/databases/")) return { status: 200, json: { name: `projects/${PRODUCTION_PROJECT}/databases/(default)`, type: "FIRESTORE_NATIVE" } };
    throw new Error(url);
  };
  return { opened, run: () => cli.runRecoveryCli({ argv, env, request, auth: () => { opened.push("auth"); return { getProjectId: async () => PRODUCTION_PROJECT, getAccessToken: async () => "adc-token" }; },
    initFirestore: async () => { opened.push("adc-firestore"); return { db }; }, openEmulatorDb: () => { opened.push("emulator-firestore"); return db; },
    loadEnsure: () => { opened.push("ensure"); return ensure; } }) };
}

test("CLI arguments: --reports is required in both modes; unknown, repeated or override flags are refused", async () => {
  for (const argv of [[], ["--reports="], ["--reports=r,r"], ["--reports=a/b"], ["--reports=r", "--reports=s"], ["--reports=r", "--force"], ["--reports=r", "--apply"], ["--reports=r", "--execute"],
    ["--reports=r", "--execute", "--confirm-digest=short"], ["--reports=r", "--execute=yes", "--confirm-digest=0123456789abcdef"], ["--reports=r", "--confirm-digest=0123456789abcdef"],
    ["--reports=r", "--allow-production"], ["--execute", "--confirm-digest=0123456789abcdef"], CLOUD_ARGS, ["r"]]) {
    for (const env of [EMULATOR_ENV, CLOUD_ENV]) {
      const h = harness({ argv, env });
      await assert.rejects(h.run(), /\[(arguments|reports)\]/, JSON.stringify(argv)); assert.deepEqual(h.opened, []);
    }
  }
});

test("CLI execute is refused before any Firestore access everywhere but the validated demo emulator in test mode", async () => {
  const EXECUTE = ["--reports=r", "--execute", "--confirm-digest=0123456789abcdef"];
  const without = key => Object.fromEntries(Object.entries(EMULATOR_ENV).filter(([name]) => name !== key));
  const cases = [[EXECUTE, CLOUD_ENV], [[...EXECUTE, ...CLOUD_ARGS], CLOUD_ENV], [[...EXECUTE, ...CLOUD_ARGS], EMULATOR_ENV], [EXECUTE, {}], [EXECUTE, { NODE_ENV: "test" }],
    [EXECUTE, { ...EMULATOR_ENV, NODE_ENV: "production" }], [EXECUTE, { ...EMULATOR_ENV, NODE_ENV: "development" }], [EXECUTE, { ...EMULATOR_ENV, FIRESTORE_EMULATOR_HOST: "10.0.0.5:8381" }],
    [EXECUTE, { ...EMULATOR_ENV, FIREBASE_PROJECT_ID: PRODUCTION_PROJECT, GCLOUD_PROJECT: PRODUCTION_PROJECT }], [EXECUTE, { ...EMULATOR_ENV, GOOGLE_APPLICATION_CREDENTIALS: "/key.json" }],
    [EXECUTE, without("MENRO_INTEGRATION_TEST")], [EXECUTE, without("FIRESTORE_EMULATOR_HOST")],
    // The shared demo topology may run outside test mode; execution may not.
    [EXECUTE, { MENRO_INTEGRATION_TEST: "true", GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" }]];
  for (const [argv, env] of cases) {
    const h = harness({ argv, env });
    await assert.rejects(h.run(), /separate approved plan/, JSON.stringify(env)); assert.deepEqual(h.opened, []);
  }
});

test("CLI dry run needs either the demo emulators or a verified Cloud Shell identity", async () => {
  seed("r");
  for (const [argv, env, opened] of [[["--reports=r"], CLOUD_ENV, []], [["--reports=r"], {}, []], [["--reports=r", ...CLOUD_ARGS], EMULATOR_ENV, []], [["--reports=r", CLOUD_ARGS[0]], CLOUD_ENV, []]]) {
    const h = harness({ argv, env }); await assert.rejects(h.run(), /\[(arguments|environment)\]/); assert.deepEqual(h.opened, opened);
  }
  const stranger = harness({ argv: ["--reports=r", ...CLOUD_ARGS], env: CLOUD_ENV, email: "other@example.org" });
  await assert.rejects(stranger.run(), /\[identity\]/); assert.deepEqual(stranger.opened, ["auth"]);
  const wrongProject = harness({ argv: ["--reports=r", ...CLOUD_ARGS], env: CLOUD_ENV, projectId: "other" });
  await assert.rejects(wrongProject.run(), /\[database\]/);
  const cloud = harness({ argv: ["--reports=r,missing", ...CLOUD_ARGS], env: CLOUD_ENV });
  const result = await cloud.run();
  assert.equal(result.mode, "dry-run"); assert.deepEqual(result.reports.map(row => row.decision), ["ELIGIBLE_MISSING_COHORT", "REPORT_NOT_FOUND"]);
  assert.match(result.next, /separate approved plan/);
  assert.deepEqual(cloud.opened, ["auth", "adc-firestore"]); assert.deepEqual(store.appliedWrites, []);
});

test("CLI emulator dry run then confirmed execute provisions once", async () => {
  seed("r");
  const dry = harness({ argv: ["--reports=r"], env: EMULATOR_ENV, projectId: DEMO });
  const reviewed = await dry.run();
  assert.deepEqual(dry.opened, ["emulator-firestore"]); assert.deepEqual(store.appliedWrites, []);
  const execute = harness({ argv: ["--reports=r", "--execute", `--confirm-digest=${reviewed.digest}`], env: EMULATOR_ENV, projectId: DEMO });
  const result = await execute.run();
  assert.equal(result.mode, "execute"); assert.deepEqual(result.results.map(row => row.status), ["PROVISIONED"]);
  const notDemo = harness({ argv: ["--reports=r", "--execute", `--confirm-digest=${reviewed.digest}`], env: EMULATOR_ENV, projectId: PRODUCTION_PROJECT });
  await assert.rejects(notDemo.run(), /\[database\]/);
});

const SCRIPT = path.join(__dirname, "..", "scripts", "recoverHistoricalCohorts.js");
const childEnv = extra => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...extra });
test("the real script exits non-zero with --execute in a production-like environment, before loading any Firebase app", () => {
  for (const args of [["--reports=r", "--execute", "--confirm-digest=0123456789abcdef"], ["--reports=r", "--execute", "--confirm-digest=0123456789abcdef", ...CLOUD_ARGS]]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { env: childEnv(CLOUD_ENV), encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /RECOVERY STOPPED .*separate approved plan/); assert.equal(result.stdout, "");
  }
});

test("the Cloud Shell dry run is credential-free: src/config/firebase.js never loads", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "helpers", "credentialFreeRecoveryRun.js")], { env: childEnv(CLOUD_ENV), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.deepEqual(out, { hasKey: false, decision: "ELIGIBLE_MISSING_COHORT", writes: 0, loadedConfigFirebase: false, loadedCohortService: false });
});
