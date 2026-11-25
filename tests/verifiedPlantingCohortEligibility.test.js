// B1: one Firebase-free eligibility rule shared by automatic provisioning, readiness and historical recovery.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const tables = new Map();
const table = name => tables.get(name) || (tables.set(name, new Map()), tables.get(name));
const ref = (collection, id) => ({ id, path: `${collection}/${id}`, collection, get: async () => ({ id, exists: table(collection).has(id), data: () => table(collection).get(id) }) });
const db = { collection: name => ({ doc: id => ref(name, id) }) };
// Like Firestore, a stored value may never be undefined.
const assertStorable = (value, at = "") => {
  assert.notEqual(value, undefined, `undefined at ${at}`);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) for (const [key, child] of Object.entries(value)) assertStorable(child, `${at}.${key}`);
};
const transaction = { get: document => document.get(), create: (document, value) => { assertStorable(value); table(document.collection).set(document.id, value); } };
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const eligibility = require("../src/services/verifiedPlantingCohortEligibility");
const cohorts = require("../src/services/verifiedPlantingCohort.service");
const visits = require("../src/services/sampleMonitoringVisit.service");

const FLAGS = ["VERIFIED_PLANTING_COHORT_ENABLED", "PERMANENT_SAMPLE_WRITE_PAUSED", "PERMANENT_SAMPLE_PILOT_ENABLED", "PERMANENT_SAMPLE_PILOT_USER_IDS", "PERMANENT_SAMPLE_PILOT_COHORT_IDS"];
test.beforeEach(() => { tables.clear(); FLAGS.forEach(name => delete process.env[name]); process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true"; });
test.after(() => FLAGS.forEach(name => delete process.env[name]));

const REPORT = { reportNumber: "RPT-1", reportType: "parent", reportingProgress: "Completed", acceptedQuantity: 25, siteId: "site", species: "Narra", plantingDate: "2026-10-01" };
const CONFLICT = "POLICY_CONFLICT", OTHER = "NOT_PERMANENT_SAMPLE_MONITORING";
// [label, reportingPolicy, expected code, expected method]
const MATRIX = [
  ["no snapshot keeps the legacy behaviour", undefined, null, "LEGACY"],
  ["nested only", { definition: { monitoring: "PERMANENT_SAMPLE" } }, null, "PERMANENT_SAMPLE"],
  ["flat only", { monitoring: "PERMANENT_SAMPLE" }, null, "PERMANENT_SAMPLE"],
  ["both equal", { monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "PERMANENT_SAMPLE" } }, null, "PERMANENT_SAMPLE"],
  ["surrounding whitespace", { monitoring: " PERMANENT_SAMPLE ", definition: { monitoring: "PERMANENT_SAMPLE" } }, null, "PERMANENT_SAMPLE"],
  ["blank flat, nested permanent", { monitoring: "  ", definition: { monitoring: "PERMANENT_SAMPLE" } }, null, "PERMANENT_SAMPLE"],
  ["flat permanent, nested spot check", { monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "STAFF_SPOT_CHECK" } }, CONFLICT, "UNSPECIFIED"],
  ["flat pending, nested permanent", { monitoring: "PENDING_MENRO_POLICY", definition: { monitoring: "PERMANENT_SAMPLE" } }, CONFLICT, "UNSPECIFIED"],
  ["flat none, nested permanent", { monitoring: "NONE", definition: { monitoring: "PERMANENT_SAMPLE" } }, CONFLICT, "UNSPECIFIED"],
  ["spot check", { monitoring: "STAFF_SPOT_CHECK" }, OTHER, "STAFF_SPOT_CHECK"],
  ["nested spot check", { definition: { monitoring: "STAFF_SPOT_CHECK" } }, OTHER, "STAFF_SPOT_CHECK"],
  ["none", { monitoring: "NONE" }, OTHER, "NONE"],
  ["pending MENRO policy", { monitoring: "PENDING_MENRO_POLICY", definition: { monitoring: "PENDING_MENRO_POLICY" } }, OTHER, "PENDING_MENRO_POLICY"],
  ["flat permanent, nested pending", { monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "PENDING_MENRO_POLICY" } }, CONFLICT, "UNSPECIFIED"],
  ["flat permanent with a pending policy status", { monitoring: "PERMANENT_SAMPLE", policyStatus: "PENDING_MENRO_POLICY" }, OTHER, "PENDING_MENRO_POLICY"],
  ["nested permanent with a pending policy status", { definition: { monitoring: "PERMANENT_SAMPLE" }, policyStatus: "PENDING_MENRO_POLICY" }, OTHER, "PENDING_MENRO_POLICY"],
  ["conflict with a pending policy status stays a conflict", { monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "NONE" }, policyStatus: "PENDING_MENRO_POLICY" }, CONFLICT, "UNSPECIFIED"],
  ["resolved policy status", { monitoring: "PERMANENT_SAMPLE", policyStatus: "RESOLVED" }, null, "PERMANENT_SAMPLE"],
  ["empty snapshot", {}, OTHER, "UNSPECIFIED"],
  ["whitespace only", { monitoring: "   ", definition: { monitoring: "" } }, OTHER, "UNSPECIFIED"],
  ["unknown value", { monitoring: "SOMETHING_ELSE" }, OTHER, "SOMETHING_ELSE"],
  ["case difference is not silently accepted", { monitoring: "permanent_sample" }, OTHER, "permanent_sample"],
  ["stored text LEGACY is not the missing-snapshot case", { monitoring: "LEGACY" }, OTHER, "LEGACY"],
  ["a list is never read as a method", { monitoring: ["PERMANENT_SAMPLE"] }, OTHER, "UNSPECIFIED"],
  ["a nested list is never read as a method", { definition: { monitoring: ["PERMANENT_SAMPLE"] } }, OTHER, "UNSPECIFIED"],
];
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const reportWith = policy => freeze({ ...structuredClone(REPORT), ...(policy === undefined ? {} : { reportingPolicy: structuredClone(policy) }) });

for (const [label, policy, code, method] of MATRIX) {
  test(`policy matrix: ${label} -> ${code || "allowed"} for the rule, provisioning and readiness`, async () => {
    const report = reportWith(policy);
    assert.deepEqual(eligibility.permanentSamplePolicy(report), { allowed: code === null, code, method });

    const cohort = await cohorts.ensureCohortForAuthoritativeReportInTransaction(transaction, { reportId: "report", report });
    assert.equal(Boolean(cohort?.created), code === null);
    assert.equal(table("verifiedPlantingCohorts").size, code === null ? 1 : 0);

    const problems = visits._test.reportEligibilityProblems({ verifiedPlantedQuantity: 25, source: { siteId: "site" } },
      { exists: true, data: () => report }, { exists: true, data: () => ({ status: "active" }) });
    assert.deepEqual(problems, code ? [code] : []);
  });
}

test("a nested-only report copies only the snapshot values that exist and never writes undefined", async () => {
  const bare = await cohorts.ensureCohortForAuthoritativeReportInTransaction(transaction, { reportId: "bare", report: reportWith({ definition: { monitoring: "PERMANENT_SAMPLE" }, sampling: null }) });
  assert.deepEqual(bare.samplingPolicySnapshot, {});
  assert.ok(bare.samplingReadiness.pending.includes("MINIMUM_SAMPLE_POLICY_PENDING"));
  const full = await cohorts.ensureCohortForAuthoritativeReportInTransaction(transaction, { reportId: "full", report: reportWith({ definition: { monitoring: "PERMANENT_SAMPLE" },
    sampling: { percentage: 10, minimum: null }, policyVersion: 0, approvedBy: "admin-1" }) });
  assert.deepEqual(full.samplingPolicySnapshot, { percentage: 10, minimum: null, policyVersion: 0, approvedBy: "admin-1" });
});

test("an unusable first-visit delay is a pending policy value and never aborts provisioning", async () => {
  const readiness = async firstVisitDelayWeeks => (await cohorts.ensureCohortForAuthoritativeReportInTransaction(transaction, { reportId: `delay-${table("verifiedPlantingCohorts").size}`,
    report: reportWith({ definition: { monitoring: "PERMANENT_SAMPLE" }, sampling: { percentage: 10, minimum: 1, firstVisitDelayWeeks } }) })).samplingReadiness;
  for (const bad of ["two", 1e9, 10001, -1, 1.5, "2", true, [2], null]) {
    const result = await readiness(bad);
    assert.ok(result.pending.includes("FIRST_VISIT_DELAY_PENDING"), JSON.stringify(bad)); assert.equal(result.firstVisitDueDate, null); assert.equal(result.status, "POLICY_PENDING");
  }
  for (const [weeks, due] of [[0, "2026-10-01"], [2, "2026-10-15"]]) {
    const result = await readiness(weeks);
    assert.ok(!result.pending.includes("FIRST_VISIT_DELAY_PENDING")); assert.equal(result.firstVisitDueDate, due);
  }
  assert.equal((await readiness(10000)).pending.includes("FIRST_VISIT_DELAY_PENDING"), false);
});

test("malformed stored sampling values fail closed instead of producing an active schedule", async () => {
  const readiness = async (name, sampling) => (await cohorts.ensureCohortForAuthoritativeReportInTransaction(transaction, { reportId: `sampling-${name}`,
    report: reportWith({ definition: { monitoring: "PERMANENT_SAMPLE" }, sampling: { firstVisitDelayWeeks: 0,
      speciesAllocationProcedure: "approved", physicalSelectionProcedure: "approved", ...sampling } }) })).samplingReadiness;
  for (const [name, sampling, code] of [
    ["percentage-text", { percentage: "10", minimum: 1, intervalMonths: 12 }, "SAMPLING_PERCENTAGE_PENDING"],
    ["percentage-range", { percentage: 101, minimum: 1, intervalMonths: 12 }, "SAMPLING_PERCENTAGE_PENDING"],
    ["minimum-zero", { percentage: 10, minimum: 0, intervalMonths: 12 }, "MINIMUM_SAMPLE_POLICY_PENDING"],
    ["minimum-fraction", { percentage: 10, minimum: 1.5, intervalMonths: 12 }, "MINIMUM_SAMPLE_POLICY_PENDING"],
    ["interval-zero", { percentage: 10, minimum: 1, intervalMonths: 0 }, "VISIT_INTERVAL_POLICY_PENDING"],
    ["interval-text", { percentage: 10, minimum: 1, intervalMonths: "12" }, "VISIT_INTERVAL_POLICY_PENDING"],
  ]) {
    const result = await readiness(name, sampling);
    assert.ok(result.pending.includes(code), name);
    assert.equal(result.status, "POLICY_PENDING", name);
    if (code === "SAMPLING_PERCENTAGE_PENDING") {
      assert.equal(result.percentage, null, name); assert.equal(result.baseTarget, null, name); assert.equal(result.target, null, name);
    }
    if (code === "VISIT_INTERVAL_POLICY_PENDING") assert.equal(result.intervalMonths, null, name);
  }
});

test("an event reference that is not a plain document ID is never read and never aborts provisioning", async () => {
  for (const [index, eventId] of [5, "a/b", " padded ", "__reserved__", "..", { id: "x" }].entries()) {
    const reads = [];
    const strict = { ...transaction, get: async document => { reads.push(document.path); return document.get(); } };
    const strictDb = db.collection;
    db.collection = name => ({ doc: id => { if (typeof id !== "string" || !id || id.includes("/")) throw new Error("invalid document path"); return ref(name, id); } });
    try {
      const cohort = await cohorts.ensureCohortForAuthoritativeReportInTransaction(strict, { reportId: `event-${index}`, report: freeze({ ...REPORT, eventId }) });
      assert.equal(cohort.created, true); assert.equal(cohort.source.siteId, "site");
      assert.ok(!reads.some(value => value.startsWith("events/")), JSON.stringify(eventId));
    } finally { db.collection = strictDb; }
  }
});

test("sampling values never stand in for the official policy version or approver", async () => {
  const create = (reportId, policy) => cohorts.ensureCohortForAuthoritativeReportInTransaction(transaction, { reportId, report: reportWith({ definition: { monitoring: "PERMANENT_SAMPLE" }, ...policy }) });
  const sampling = { percentage: 10, policyVersion: 99, approvedBy: "not-the-approver" };
  assert.deepEqual((await create("absent", { sampling })).samplingPolicySnapshot, { percentage: 10 });
  assert.deepEqual((await create("present", { sampling, policyVersion: 1, approvedBy: "admin-1" })).samplingPolicySnapshot, { percentage: 10, policyVersion: 1, approvedBy: "admin-1" });
});

test("pause, pilot and the feature flag still defer provisioning of an allowed nested-only report", async () => {
  const report = reportWith({ definition: { monitoring: "PERMANENT_SAMPLE" } });
  for (const env of [{ PERMANENT_SAMPLE_WRITE_PAUSED: "true" }, { VERIFIED_PLANTING_COHORT_ENABLED: "false" },
    { PERMANENT_SAMPLE_PILOT_ENABLED: "true", PERMANENT_SAMPLE_PILOT_USER_IDS: '["u"]', PERMANENT_SAMPLE_PILOT_COHORT_IDS: '["c"]' }]) {
    Object.assign(process.env, env);
    assert.equal(await cohorts.ensureCohortForAuthoritativeReportInTransaction(transaction, { reportId: "report", report }), null);
    FLAGS.forEach(name => delete process.env[name]); process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true";
  }
  assert.equal(table("verifiedPlantingCohorts").size, 0);
});

test("provisioning and the visit service use the shared quantity, ID and policy functions", () => {
  assert.equal(cohorts.cohortIdFor, eligibility.cohortIdFor);
  assert.equal(cohorts._test.authoritativeQuantity, eligibility.authoritativeQuantity);
  assert.equal(eligibility.cohortIdFor("report-1"), `VPC-${require("node:crypto").createHash("sha256").update("report-1").digest("hex").slice(0, 24)}`);
  for (const bad of ["", "a/b", null, 5]) assert.throws(() => eligibility.cohortIdFor(bad), /Invalid planting report ID/);
  assert.equal(eligibility.authoritativeQuantity({ reportType: "parent", reportingProgress: "Completed", acceptedQuantity: 4 }), 4);
  assert.equal(eligibility.authoritativeQuantity({ reportType: "parent", verificationStatus: "Approved", acceptedQuantity: 4 }), 0);
  assert.equal(eligibility.authoritativeQuantity({ verificationStatus: "Approved", quantityPlanted: 7 }), 7);
  for (const quantityPlanted of [0, -1, 1.5, "x", null, undefined]) assert.equal(eligibility.authoritativeQuantity({ verificationStatus: "Approved", quantityPlanted }), 0);
});

test("the eligibility module loads without Firebase, directly or transitively", () => {
  const script = `require(${JSON.stringify(path.join(__dirname, "../src/services/verifiedPlantingCohortEligibility.js"))});
    const bad = Object.keys(require.cache).filter(f => /firebase/i.test(f)); process.stdout.write(JSON.stringify(bad));`;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "production" };
  const result = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});
