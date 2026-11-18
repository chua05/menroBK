// Emulator acceptance for automatic Survival Monitoring lifecycle registration and MON-YYYY-NNN numbering.
// Real Firestore transactions: idempotency, concurrency and the controlled backfill.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

assert.equal(validateIntegrationEnvironment().integration, true, "Lifecycle registration acceptance requires the emulator environment");
const { db } = require("../../src/config/firebase");
const registration = require("../../src/services/monitoringLifecycleRegistration.service");
const monitoring = require("../../src/services/monitoring.service");
const { runBackfill } = require("../../scripts/backfillMonitoringLifecycles");

const PREFIX = `lifecycle-registration-${randomUUID()}`;
const created = [];
const sequenceOf = (number) => Number(String(number).split("-").at(-1));
const lifecycleIdFor = (reportId, report) => monitoring.lifecycleId(report.participantId || "", reportId, report.eventId || "", report.siteId || "");
async function seedReport(suffix, extra = {}) {
  const reportId = `${PREFIX}-${suffix}`;
  const report = { reportNumber: `RPT-${suffix}`, participantId: `${PREFIX}-participant`, eventId: `${PREFIX}-event-${suffix}`, siteId: `${PREFIX}-site`,
    siteName: "Registration site", barangay: "Bical", plantingDate: "2026-10-01", quantityPlanted: 20, acceptedQuantity: 20,
    reportingProgress: "Completed", verificationStatus: "Completed", reportingPolicy: { monitoring: "STAFF_SPOT_CHECK", reporting: "REQUIRED", policyVersion: 0 }, ...extra };
  // An explicit undefined field means "omit it" (e.g. a legacy report without a purpose policy).
  for (const key of Object.keys(report)) if (report[key] === undefined) delete report[key];
  await db.collection("plantingReports").doc(reportId).set(report);
  created.push(reportId);
  return { reportId, report, lifecycleId: lifecycleIdFor(reportId, report) };
}
const lifecycleDocs = async (reportId) => (await db.collection("monitoringRecords").where("plantingReportId", "==", reportId).get()).docs;

test.after(async () => {
  for (const reportId of created) {
    await Promise.all((await lifecycleDocs(reportId)).map((doc) => doc.ref.delete()));
    await db.collection("plantingReports").doc(reportId).delete();
  }
});

test("a verified Staff spot-check report gets one lifecycle with a MON number, no schedule and no observations", async () => {
  const { reportId, report, lifecycleId } = await seedReport("spot");
  const first = await registration.registerMonitoringLifecycle({ reportId });
  assert.equal(first.status, "REGISTERED"); assert.equal(first.lifecycleId, lifecycleId);
  assert.match(first.monitoringNumber, new RegExp(`^MON-${new Date().getFullYear()}-\\d{3,}$`));
  const stored = (await db.collection("monitoringRecords").doc(lifecycleId).get()).data();
  assert.deepEqual([stored.monitoringMethod, stored.scheduleStatus, stored.startMonitoringDate, stored.nextMonitoringDate, stored.monitoringEndDate],
    ["STAFF_SPOT_CHECK", "AWAITING_MONITORING_POLICY", null, null, null]);
  assert.deepEqual(stored.history, []); assert.equal(stored.plantingReportId, reportId); assert.equal(stored.plantingReportNumber, report.reportNumber);
  assert.equal(stored.siteId, report.siteId); assert.equal(stored.registrationSource, "PLANTING_REPORT_VERIFICATION");
  // The stored monitoring policy is never changed by registration.
  assert.deepEqual((await db.collection("plantingReports").doc(reportId).get()).data().reportingPolicy, report.reportingPolicy);
  // Retries and repeated loads never duplicate the lifecycle or its number.
  assert.deepEqual(await registration.registerMonitoringLifecycle({ reportId }), { reportId, status: "NO_CHANGE" });
  assert.equal((await lifecycleDocs(reportId)).length, 1);
  assert.equal((await db.collection("monitoringRecords").doc(lifecycleId).get()).data().monitoringNumber, first.monitoringNumber);
  // The lifecycle list shows it as Awaiting Monitoring Setup, never Available for Monitoring.
  const listed = (await monitoring.getAllMonitoringRecords({ plantingReportId: reportId }))[0];
  assert.equal(listed.status, "Awaiting Monitoring Setup"); assert.equal(listed.historyCount, 0);
});

test("unverified, archived and monitoring-NONE reports are never registered", async () => {
  const pending = await seedReport("pending", { reportingProgress: "Awaiting Submission", verificationStatus: "Pending" });
  const none = await seedReport("none", { reportingPolicy: { monitoring: "NONE", reporting: "NOT_REQUIRED" } });
  const archived = await seedReport("archived", { archived: true });
  for (const row of [pending, none, archived]) {
    assert.equal((await registration.registerMonitoringLifecycle({ reportId: row.reportId })).status, "NO_CHANGE");
    assert.equal((await lifecycleDocs(row.reportId)).length, 0);
  }
});

test("concurrent registration of one report creates one lifecycle and consumes one number", async () => {
  const { reportId } = await seedReport("same");
  const results = await Promise.all(Array.from({ length: 6 }, () => registration.registerMonitoringLifecycle({ reportId })));
  assert.equal(results.filter((row) => row.status === "REGISTERED").length, 1);
  assert.equal((await lifecycleDocs(reportId)).length, 1);
  const next = await seedReport("after-same");
  const after = await registration.registerMonitoringLifecycle({ reportId: next.reportId });
  const registeredNumber = results.find((row) => row.status === "REGISTERED").monitoringNumber;
  assert.equal(sequenceOf(after.monitoringNumber), sequenceOf(registeredNumber) + 1, "the losing retries never consumed a number");
});

test("concurrent registration of different reports assigns unique contiguous sequential numbers", async () => {
  const rows = await Promise.all(Array.from({ length: 8 }, (_, index) => seedReport(`many-${index}`)));
  const results = await Promise.all(rows.map((row) => registration.registerMonitoringLifecycle({ reportId: row.reportId })));
  const sequences = results.map((row) => sequenceOf(row.monitoringNumber)).sort((a, b) => a - b);
  assert.equal(new Set(sequences).size, 8, "no duplicate MON numbers");
  assert.equal(sequences.at(-1) - sequences[0], 7, "numbers are contiguous with no gaps");
});

test("existing lifecycles keep their number and history; an unnumbered one only receives a number", async () => {
  const numbered = await seedReport("numbered", { reportingPolicy: undefined });
  await db.collection("monitoringRecords").doc(numbered.lifecycleId).set({ recordType: "monitoringLifecycle", plantingReportId: numbered.reportId,
    participantId: numbered.report.participantId, siteId: numbered.report.siteId, monitoringNumber: "MON-2025-042", history: [{ id: "obs-1", reviewStatus: "Validated" }] });
  assert.equal((await registration.registerMonitoringLifecycle({ reportId: numbered.reportId })).status, "NO_CHANGE");
  const kept = (await db.collection("monitoringRecords").doc(numbered.lifecycleId).get()).data();
  assert.equal(kept.monitoringNumber, "MON-2025-042"); assert.equal(kept.history.length, 1);
  const unnumbered = await seedReport("unnumbered");
  await db.collection("monitoringRecords").doc(unnumbered.lifecycleId).set({ recordType: "monitoringLifecycle", plantingReportId: unnumbered.reportId,
    participantId: unnumbered.report.participantId, siteId: unnumbered.report.siteId, history: [{ id: "obs-old" }], startMonitoringDate: "2026-10-15" });
  const assigned = await registration.registerMonitoringLifecycle({ reportId: unnumbered.reportId });
  assert.equal(assigned.status, "NUMBER_ASSIGNED");
  const updated = (await db.collection("monitoringRecords").doc(unnumbered.lifecycleId).get()).data();
  assert.equal(updated.monitoringNumber, assigned.monitoringNumber); assert.deepEqual(updated.history, [{ id: "obs-old" }]); assert.equal(updated.startMonitoringDate, "2026-10-15");
});

test("backfill is a dry run by default, refuses a mismatched project, and is idempotent when applied", async () => {
  const target = await seedReport("backfill");
  const dry = await runBackfill();
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.plan.find((row) => row.reportId === target.reportId)?.action, "REGISTER");
  assert.equal((await lifecycleDocs(target.reportId)).length, 0, "a dry run writes nothing");
  await assert.rejects(runBackfill({ apply: true, confirmProject: "menrosystem-ddfac" }), /Refusing to write/);
  const applied = await runBackfill({ apply: true, confirmProject: db.projectId });
  assert.equal(applied.results.find((row) => row.reportId === target.reportId)?.status, "REGISTERED");
  const again = await runBackfill({ apply: true, confirmProject: db.projectId });
  assert.equal(again.results.find((row) => row.reportId === target.reportId)?.status, "NO_CHANGE");
  assert.equal((await lifecycleDocs(target.reportId)).length, 1);
});
