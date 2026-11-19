// Emulator acceptance (isolated legacy-monitoring topology) for the read-only Monitoring Lifecycle preflight's
// counter investigation: a missing monitoringRecords_<year> counter is classified from a full scan of
// monitoringRecords, never assumed safe on its own; the preflight performs zero writes; and Firestore itself
// rejects writes inside the preflight's read-only transaction mode.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

const integration = validateIntegrationEnvironment();
assert.equal(integration.integration, true, "requires the emulator environment");
assert.equal(integration.legacyMonitoringIsolated, true, "requires the isolated legacy-monitoring emulators");
const { db, app } = require("../../src/config/firebase");
const policy = require("../../src/services/monitoringLifecyclePolicy");
const { lifecycleId } = require("../../src/utils/monitoringLifecycleId.util");
const registration = require("../../src/services/monitoringLifecycleRegistration.service");
const { createMonitoringLifecycleBackfill } = require("../../src/services/monitoringLifecycleBackfill.service");

const PREFIX = `counter-preflight-${randomUUID()}`;
const YEAR = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric" }).format(new Date()));
const COUNTER = db.collection("counters").doc(`monitoringRecords_${YEAR}`);
const targets = ["020", "024"].map(n => ({ reportId: `${PREFIX}-report-${n}`, reportNumber: `RPT-${PREFIX}-${n}` }));
const preflight = () => createMonitoringLifecycleBackfill({ db, app, registration: policy, lifecycleId })
  .plan({ expectedProject: db.projectId, targets });

async function snapshotAll() {
  const out = {};
  for (const name of ["plantingReports", "monitoringRecords", "counters"]) out[name] = (await db.collection(name).get()).docs.map(doc => [doc.id, doc.data()]).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(out);
}

test.before(async () => {
  // Fresh dedicated emulator: the year counter and monitoringRecords must start empty for the first-allocation case.
  assert.equal((await COUNTER.get()).exists, false, "test requires a fresh emulator with no current-year counter");
  assert.equal((await db.collection("monitoringRecords").limit(1).get()).size, 0, "test requires a fresh emulator with no monitoring records");
  for (const target of targets) {
    await db.collection("plantingReports").doc(target.reportId).set({ reportNumber: target.reportNumber, participantId: `${PREFIX}-p`, eventId: `${PREFIX}-e-${target.reportId}`,
      siteId: `${PREFIX}-s`, plantingDate: "2026-10-01", verificationStatus: "Completed", reportingProgress: "Completed",
      reportingPolicy: { definition: { monitoring: "STAFF_SPOT_CHECK", reporting: "REQUIRED" }, policyVersion: 0 } });
  }
});

test.after(async () => {
  for (const target of targets) {
    await db.collection("plantingReports").doc(target.reportId).delete();
    for (const doc of (await db.collection("monitoringRecords").where("plantingReportId", "==", target.reportId).get()).docs) await doc.ref.delete();
  }
  await db.collection("monitoringRecords").doc(`${PREFIX}-existing`).delete();
  await COUNTER.delete();
});

test("Firestore rejects a write inside the preflight's read-only transaction mode", async () => {
  await assert.rejects(db.runTransaction(async tx => { tx.set(db.collection("counters").doc(`${PREFIX}-probe`), { x: 1 }); }, { readOnly: true }));
  assert.equal((await db.collection("counters").doc(`${PREFIX}-probe`).get()).exists, false);
});

test("missing counter + empty monitoringRecords is a legitimate first allocation; the preflight writes nothing", async () => {
  const before = await snapshotAll();
  const result = await preflight();
  assert.deepEqual([result.numberIntegrity.counterExists, result.numberIntegrity.counterState, result.numberIntegrity.firstAllocationSafe, result.monitoringRecordsScanned],
    [false, "ABSENT_FIRST_ALLOCATION", true, 0]);
  assert.deepEqual(result.plan.map(row => [row.monitoringMethod, row.policySource, row.action]),
    targets.map(() => ["STAFF_SPOT_CHECK", "reportingPolicy.definition.monitoring", "REGISTER"]));
  assert.deepEqual(result.writeScopeIfApproved, { monitoringRecordsCreated: 2, monitoringNumbersAssignedToExisting: 0, counterDocument: "CREATE", counterId: `monitoringRecords_${YEAR}`,
    plantingReportsChanged: 0, monitoringPoliciesChanged: 0, observationsOrVisitsCreated: 0 });
  assert.equal(await snapshotAll(), before, "no document anywhere changed");
});

test("missing counter with an existing current-year MON number is unsafe and blocks registration", async () => {
  await db.collection("monitoringRecords").doc(`${PREFIX}-existing`).set({ plantingReportId: `${PREFIX}-other-report`, monitoringNumber: `MON-${YEAR}-001` });
  const before = await snapshotAll();
  const result = await preflight();
  assert.equal(result.numberIntegrity.counterState, "ABSENT_WITH_EXISTING_NUMBERS");
  assert.equal(result.numberIntegrity.firstAllocationSafe, false);
  assert.ok(result.plan.every(row => row.action === "BLOCKED" && row.reasons.includes("COUNTER_MISSING_WITH_EXISTING_NUMBERS")));
  assert.equal(result.writeScopeIfApproved, null);
  assert.equal(await snapshotAll(), before);
  await db.collection("monitoringRecords").doc(`${PREFIX}-existing`).delete();
});

test("after an (emulator-only) registration, the plan reports KEEP, a consistent counter, and the policy is preserved", async () => {
  for (const target of targets) assert.equal((await registration.registerMonitoringLifecycle({ reportId: target.reportId })).status, "REGISTERED");
  const result = await preflight();
  assert.deepEqual([result.numberIntegrity.counterState, result.numberIntegrity.counterLastNumber, result.numberIntegrity.currentYearNumberedCount], ["CONSISTENT", 2, 2]);
  assert.deepEqual(result.plan.map(row => row.action), ["KEEP", "KEEP"]);
  assert.ok(result.plan.every(row => row.lifecycles.length === 1 && row.lifecycles[0].scheduleStatus === "AWAITING_MONITORING_POLICY" && row.lifecycles[0].startMonitoringDate === null));
  for (const target of targets) {
    assert.deepEqual((await db.collection("plantingReports").doc(target.reportId).get()).data().reportingPolicy,
      { definition: { monitoring: "STAFF_SPOT_CHECK", reporting: "REQUIRED" }, policyVersion: 0 });
    assert.equal((await registration.registerMonitoringLifecycle({ reportId: target.reportId })).status, "NO_CHANGE");
  }
  assert.equal(result.writeScopeIfApproved, null);
});
