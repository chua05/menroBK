const test = require("node:test");
const assert = require("node:assert/strict");
const { PRODUCTION_PROJECT, PRODUCTION_TARGETS } = require("../src/services/monitoringLifecycleBackfill.service");
const { REQUIRED_READ_PERMISSIONS, parseCloudShellArguments, runCloudShellPreflight } = require("../scripts/cloudShellMonitoringPreflight");
const { lifecycleId } = require("../src/utils/monitoringLifecycleId.util");
const policy = require("../src/services/monitoringLifecyclePolicy");
const registration = require("../src/services/monitoringLifecycleRegistration.service");
const monitoring = require("../src/services/monitoring.service");

const PRINCIPAL = "operator@example.org";
const ARGV = [`--expected-project=${PRODUCTION_PROJECT}`, `--expected-principal=${PRINCIPAL}`];
const ENV = Object.freeze({ NODE_ENV: "production", FIREBASE_PROJECT_ID: PRODUCTION_PROJECT, GOOGLE_CLOUD_PROJECT: PRODUCTION_PROJECT, HOME: "/home/operator" });

// Memory-only Firestore: production-shaped IDs never reach a real service; any write throws.
function memoryDb({ reports = true, records = [], counters = {} } = {}) {
  const data = { plantingReports: new Map(), monitoringRecords: new Map(records), counters: new Map(Object.entries(counters)) };
  if (reports) for (const target of PRODUCTION_TARGETS) data.plantingReports.set(target.reportId, { reportNumber: target.reportNumber, participantId: "p", eventId: `e-${target.reportId}`,
    siteId: "s", verificationStatus: "Completed", reportingProgress: "Completed", reportingPolicy: { definition: { monitoring: "STAFF_SPOT_CHECK" } } });
  const writes = [];
  const snap = (collection, id) => ({ id, exists: data[collection].has(id), data: () => structuredClone(data[collection].get(id)) });
  const query = (collection, filters = [], max = Infinity) => ({ query: true, collection, filters, max,
    where: (f, op, v) => query(collection, [...filters, [f, op, v]], max), select: () => query(collection, filters, max), limit: n => query(collection, filters, n), doc: id => ({ collection, id }) });
  const tx = {
    async getAll(...refs) { if (refs.at(-1)?.fieldMask) refs.pop(); return refs.map(ref => snap(ref.collection, ref.id)); },
    async get(ref) {
      if (!ref.query) return snap(ref.collection, ref.id);
      const rows = [...data[ref.collection]].filter(([, v]) => ref.filters.every(([f, op, e]) => op === "==" ? v[f] === e : e.includes(v[f]))).slice(0, ref.max);
      return { docs: rows.map(([id]) => snap(ref.collection, id)) };
    },
    create: () => writes.push("create"), set: () => writes.push("set"), update: () => writes.push("update"), delete: () => writes.push("delete"),
  };
  const db = { projectId: PRODUCTION_PROJECT, databaseId: "(default)", collection: name => query(name),
    async runTransaction(run, options) { assert.equal(options?.readOnly, true, "preflight transaction must be read-only"); return run(tx); } };
  return { db, data, writes };
}

function harness({ argv = ARGV, env = ENV, adcProject = PRODUCTION_PROJECT, email = PRINCIPAL, verified = "true", permissions = [...REQUIRED_READ_PERMISSIONS, "datastore.entities.update"],
  database = { name: `projects/${PRODUCTION_PROJECT}/databases/(default)`, type: "FIRESTORE_NATIVE", locationId: "asia-southeast1" }, store = memoryDb() } = {}) {
  const calls = [];
  let firestoreInitialized = 0;
  const request = async (method, url, options = {}) => {
    calls.push([method, url]);
    assert.ok(url.startsWith("https://") && /googleapis\.com\//.test(url), url);
    if (options.token !== undefined) assert.equal(options.token, "adc-token");
    if (url.includes("tokeninfo")) { assert.equal(options.form.access_token, "adc-token"); return { status: 200, json: { email, email_verified: verified } }; }
    if (url.includes(":testIamPermissions")) return { status: 200, json: { permissions: permissions.filter(p => options.json.permissions.includes(p)) } };
    if (url.includes("/databases/")) return database ? { status: 200, json: database } : { status: 404, json: { error: { message: "Database not found" } } };
    throw new Error(`unexpected ${url}`);
  };
  const auth = { getProjectId: async () => adcProject, getAccessToken: async () => "adc-token" };
  const initFirestore = async ({ projectId }) => { firestoreInitialized++; assert.equal(projectId, PRODUCTION_PROJECT); return { db: store.db, app: { options: { projectId } } }; };
  const run = () => runCloudShellPreflight({ argv, env, auth, request, initFirestore, now: () => new Date("2026-11-18T18:00:00Z") });
  return { run, calls, store, get firestoreInitialized() { return firestoreInitialized; } };
}

test("extracted policy and lifecycle ID modules are the ones the services use (behavior unchanged)", () => {
  assert.equal(registration.eligible, policy.eligible);
  assert.equal(registration.monitoringPolicyResolution, policy.monitoringPolicyResolution);
  assert.equal(monitoring.lifecycleId, lifecycleId);
  assert.equal(lifecycleId("p", "r", "e", "s"), `MON-${require("node:crypto").createHash("sha256").update("p|r|e|s").digest("hex").slice(0, 20)}`);
});

test("arguments: exact project and an operator email only; write and target options are rejected", () => {
  assert.deepEqual(parseCloudShellArguments(ARGV), { expectedProject: PRODUCTION_PROJECT, expectedPrincipal: PRINCIPAL });
  for (const argv of [[], [ARGV[0]], [ARGV[1]], [...ARGV, "--apply"], [...ARGV, "--report-id=x"], ["--expected-project=other", ARGV[1]], [ARGV[0], "--expected-principal=not-an-email"], [...ARGV, ARGV[0]]])
    assert.throws(() => parseCloudShellArguments(argv), /\[arguments\]/, JSON.stringify(argv));
});

test("environment problems stop before any credential, network or Firestore use", async () => {
  for (const [env, pattern] of [
    [{ ...ENV, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, /FIRESTORE_EMULATOR_HOST/],
    [{ ...ENV, GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json" }, /GOOGLE_APPLICATION_CREDENTIALS/],
    [{ ...ENV, FIREBASE_PRIVATE_KEY: "x" }, /FIREBASE_PRIVATE_KEY/],
    [{ ...ENV, MENRO_INTEGRATION_TEST: "true" }, /MENRO_INTEGRATION_TEST/],
    [{ ...ENV, NODE_ENV: "development" }, /NODE_ENV=production/],
    [{ ...ENV, FIREBASE_PROJECT_ID: "other" }, /FIREBASE_PROJECT_ID/],
    [{ ...ENV, GOOGLE_CLOUD_PROJECT: "other-project" }, /GOOGLE_CLOUD_PROJECT/]]) {
    const h = harness({ env });
    await assert.rejects(h.run(), error => /\[environment\]/.test(error.message) && pattern.test(error.message));
    assert.deepEqual(h.calls, []); assert.equal(h.firestoreInitialized, 0);
  }
});

test("identity, permission and database failures stop before Firestore is initialized", async () => {
  for (const [setup, step] of [[{ adcProject: "other" }, "identity"], [{ adcProject: null }, "identity"], [{ email: "" }, "identity"], [{ verified: "false" }, "identity"],
    [{ email: "someone-else@example.org" }, "identity"], [{ permissions: ["datastore.entities.get"] }, "permissions"],
    [{ database: null }, "database"], [{ database: { name: `projects/${PRODUCTION_PROJECT}/databases/(default)`, type: "DATASTORE_MODE" } }, "database"]]) {
    const h = harness(setup);
    await assert.rejects(h.run(), error => error.message.startsWith(`[${step}]`), JSON.stringify(setup));
    assert.equal(h.firestoreInitialized, 0, step);
  }
});

test("verified path runs the approved two-report plan read-only and classifies a missing counter with no records as first allocation", async () => {
  const h = harness();
  const before = structuredClone([...h.store.data.plantingReports]);
  const { verification, preflight } = await h.run();
  assert.equal(h.firestoreInitialized, 1);
  assert.deepEqual(h.calls.map(([method, url]) => `${method} ${new URL(url).host}`), ["POST oauth2.googleapis.com", "POST cloudresourcemanager.googleapis.com", "GET firestore.googleapis.com"]);
  assert.deepEqual([verification.principal, verification.principalType, verification.databaseType, verification.credentialSource],
    [PRINCIPAL, "user", "FIRESTORE_NATIVE", "application-default-credentials (no key file)"]);
  assert.deepEqual(verification.principalAlsoHoldsWritePermissions, ["datastore.entities.update"]);
  assert.equal(preflight.readOnly, true);
  assert.deepEqual(preflight.plan.map(row => [row.reportId, row.monitoringMethod, row.action]), PRODUCTION_TARGETS.map(t => [t.reportId, "STAFF_SPOT_CHECK", "REGISTER"]));
  assert.deepEqual([preflight.numberIntegrity.counterExists, preflight.numberIntegrity.counterState, preflight.numberIntegrity.firstAllocationSafe, preflight.monitoringRecordsScanned],
    [false, "ABSENT_FIRST_ALLOCATION", true, 0]);
  assert.deepEqual(preflight.writeScopeIfApproved, { monitoringRecordsCreated: 2, monitoringNumbersAssignedToExisting: 0, counterDocument: "CREATE", counterId: "monitoringRecords_2026",
    plantingReportsChanged: 0, monitoringPoliciesChanged: 0, observationsOrVisitsCreated: 0 });
  assert.deepEqual(h.store.writes, []); assert.deepEqual([...h.store.data.plantingReports], before); assert.equal(h.store.data.counters.size, 0);
  assert.doesNotMatch(JSON.stringify(preflight), /MON-2026-\d{3}/, "no future MON ID is allocated or shown");
});

test("a missing counter with existing current-year numbers is unsafe and blocks both targets", async () => {
  const h = harness({ store: memoryDb({ records: [["old-record", { monitoringNumber: "MON-2026-001", plantingReportId: "another-report" }]] }) });
  const { preflight } = await h.run();
  assert.equal(preflight.numberIntegrity.counterState, "ABSENT_WITH_EXISTING_NUMBERS");
  assert.equal(preflight.numberIntegrity.firstAllocationSafe, false);
  assert.ok(preflight.plan.every(row => row.action === "BLOCKED" && row.reasons.includes("COUNTER_MISSING_WITH_EXISTING_NUMBERS")));
  assert.equal(preflight.writeScopeIfApproved, null);
  assert.deepEqual(h.store.writes, []);
});

test("previous-year numbers and unnumbered records do not make a missing current-year counter unsafe", async () => {
  const h = harness({ store: memoryDb({ records: [["r2025", { monitoringNumber: "MON-2025-014", plantingReportId: "old" }], ["legacy", { plantingReportId: "legacy-report" }]] }) });
  const { preflight } = await h.run();
  assert.deepEqual([preflight.numberIntegrity.counterState, preflight.numberIntegrity.firstAllocationSafe, preflight.numberIntegrity.otherYearNumberedCount, preflight.numberIntegrity.unnumberedRecordCount],
    ["ABSENT_FIRST_ALLOCATION", true, 1, 1]);
  assert.ok(preflight.plan.every(row => row.action === "REGISTER"));
});
