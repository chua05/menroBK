// Emulator acceptance for automatic Survival Monitoring lifecycle registration and MON-YYYY-NNN numbering.
// Real Firestore transactions: idempotency, concurrency and the controlled backfill.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

const integration = validateIntegrationEnvironment();
assert.equal(integration.integration, true, "Lifecycle registration acceptance requires the emulator environment");
assert.equal(integration.phase3cIsolated || integration.legacyMonitoringIsolated, true, "Lifecycle backfill acceptance requires independently isolated emulators");
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

test("target-scoped historical preflight reads nested policy, changes nothing and normal registration stays idempotent", async () => {
  const target = await seedReport("backfill-020", { reportNumber: "RPT-2026-020", reportingPolicy: { definition: { monitoring: "STAFF_SPOT_CHECK" } } });
  const second = await seedReport("backfill-024", { reportNumber: "RPT-2026-024", reportingPolicy: { definition: { monitoring: "STAFF_SPOT_CHECK" } } });
  const unrelated = await seedReport("backfill-unrelated");
  const targets = [target, second].map(row => ({ reportId: row.reportId, reportNumber: row.report.reportNumber }));
  const beforeReports = await Promise.all([target, second].map(async row => (await db.collection("plantingReports").doc(row.reportId).get()).data()));
  const countersBefore = (await db.collection("counters").get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const dry = await runBackfill({ expectedProject: db.projectId, targets });
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.blocked, false);
  assert.equal(dry.readOnly, true);
  assert.equal(dry.targetCount, 2);
  assert.equal(dry.otherReportsPlanned, 0);
  assert.equal(dry.proposedChangeCount, 2);
  assert.deepEqual(dry.plan.map(row => [row.reportId, row.monitoringMethod, row.action]), targets.map(row => [row.reportId, "STAFF_SPOT_CHECK", "REGISTER"]));
  assert.equal(dry.plan.find((row) => row.reportId === target.reportId)?.action, "REGISTER");
  assert.equal((await lifecycleDocs(target.reportId)).length, 0, "a dry run writes nothing");
  assert.equal((await lifecycleDocs(unrelated.reportId)).length, 0);
  assert.deepEqual((await db.collection("counters").get()).docs.map(doc => ({ id: doc.id, ...doc.data() })), countersBefore);
  assert.deepEqual(await Promise.all([target, second].map(async row => (await db.collection("plantingReports").doc(row.reportId).get()).data())), beforeReports);
  await assert.rejects(runBackfill({ expectedProject: "menrosystem-ddfac", targets }), /project/);
  await assert.rejects(runBackfill({ expectedProject: db.projectId, targets, apply: true }), /[Ww]rit|apply/);
  // Local historical fixture correction uses the accepted transactional service,
  // never the CLI's rejected global apply operation or a production dataset.
  for (const row of [target, second]) {
    const applied = await registration.registerMonitoringLifecycle({ reportId: row.reportId });
    assert.equal(applied.status, "REGISTERED");
    const record = (await db.collection("monitoringRecords").doc(applied.lifecycleId).get()).data();
    assert.equal(record.monitoringMethod, "STAFF_SPOT_CHECK");
    assert.deepEqual([record.startMonitoringDate, record.nextMonitoringDate, record.monitoringEndDate, record.history], [null, null, null, []]);
    assert.equal(record.scheduleStatus, "AWAITING_MONITORING_POLICY");
    assert.equal((await registration.registerMonitoringLifecycle({ reportId: row.reportId })).status, "NO_CHANGE");
  }
  const again = await runBackfill({ expectedProject: db.projectId, targets });
  assert.deepEqual(again.plan.map(row => row.action), ["KEEP", "KEEP"]);
  assert.equal(again.proposedChangeCount, 0);
  assert.equal((await lifecycleDocs(target.reportId)).length, 1);
});

test("nested NONE and conflicting policies never register, while a pending policy remains pending", async () => {
  const none = await seedReport("nested-none", { reportingPolicy: { definition: { monitoring: "NONE" } } });
  const conflict = await seedReport("nested-conflict", { reportingPolicy: { monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "STAFF_SPOT_CHECK" } } });
  for (const row of [none, conflict]) {
    assert.equal((await registration.registerMonitoringLifecycle({ reportId: row.reportId })).status, "NO_CHANGE");
    assert.equal((await lifecycleDocs(row.reportId)).length, 0);
  }
  const pending = await seedReport("nested-pending", { reportingPolicy: { definition: { monitoring: "PENDING_MENRO_POLICY" } } });
  const registered = await registration.registerMonitoringLifecycle({ reportId: pending.reportId });
  const record = (await db.collection("monitoringRecords").doc(registered.lifecycleId).get()).data();
  assert.equal(record.monitoringMethod, "PENDING_MENRO_POLICY");
  assert.equal(record.scheduleStatus, "AWAITING_MONITORING_POLICY");
  assert.equal(record.startMonitoringDate, null);
});

test("historical preflight blocks archived/noncanonical lifecycles and policy mismatches without changing them", async () => {
  const target = await seedReport("duplicate-preflight");
  const ref = db.collection("monitoringRecords").doc(target.lifecycleId);
  const oldRef = db.collection("monitoringRecords").doc(`${PREFIX}-old-lifecycle`);
  const history = [{ id: "historical-observation", reviewStatus: "Approved" }];
  await ref.set({ plantingReportId: target.reportId, participantId: target.report.participantId, eventId: target.report.eventId,
    siteId: target.report.siteId, monitoringMethod: "STAFF_SPOT_CHECK", history, startMonitoringDate: "2026-10-15" });
  await oldRef.set({ plantingReportId: target.reportId, archived: true, history });
  const before = (await oldRef.get()).data();
  try {
    const result = await runBackfill({ expectedProject: db.projectId, targets: [{ reportId: target.reportId, reportNumber: target.report.reportNumber }] });
    assert.equal(result.plan[0].action, "BLOCKED");
    for (const reason of ["DUPLICATE_LIFECYCLES", "NONCANONICAL_LIFECYCLE", "LIFECYCLE_ARCHIVED"]) assert.ok(result.plan[0].reasons.includes(reason));
    assert.deepEqual((await oldRef.get()).data(), before);
    assert.deepEqual((await ref.get()).data().history, history);
    await oldRef.delete();
    await ref.update({ monitoringMethod: "PERMANENT_SAMPLE" });
    const mismatch = await runBackfill({ expectedProject: db.projectId, targets: [{ reportId: target.reportId, reportNumber: target.report.reportNumber }] });
    assert.ok(mismatch.plan[0].reasons.includes("LIFECYCLE_POLICY_MISMATCH"));
    assert.equal((await ref.get()).data().monitoringMethod, "PERMANENT_SAMPLE", "preflight never relabels an existing lifecycle");
    assert.deepEqual((await ref.get()).data().history, history);
  } finally { await oldRef.delete(); await ref.delete(); }
});

test("historical preflight rejects stale counters and duplicate or malformed numbers without repairing them", async () => {
  const target = await seedReport("number-integrity");
  const registered = await registration.registerMonitoringLifecycle({ reportId: target.reportId });
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric" }).format(new Date()));
  const counterRef = db.collection("counters").doc(`monitoringRecords_${year}`);
  const beforeCounter = (await counterRef.get()).data();
  const recordRef = db.collection("monitoringRecords").doc(registered.lifecycleId);
  const beforeRecord = (await recordRef.get()).data();
  const duplicateRef = db.collection("monitoringRecords").doc(`${PREFIX}-duplicate-number`);
  const options = { expectedProject: db.projectId, targets: [{ reportId: target.reportId, reportNumber: target.report.reportNumber }] };
  try {
    await counterRef.update({ lastNumber: 0 });
    assert.ok((await runBackfill(options)).numberIntegrity.reasons.includes("COUNTER_BEHIND_EXISTING_NUMBERS"));
    assert.equal((await counterRef.get()).data().lastNumber, 0, "preflight does not repair counters");
    await counterRef.set(beforeCounter);
    await duplicateRef.set({ plantingReportId: `${PREFIX}-another-report`, archived: true, monitoringNumber: beforeRecord.monitoringNumber });
    assert.ok((await runBackfill(options)).numberIntegrity.reasons.includes("DUPLICATE_MONITORING_NUMBERS"));
    await duplicateRef.delete();
    await recordRef.update({ monitoringNumber: "MON-MALFORMED" });
    const malformed = await runBackfill(options);
    assert.ok(malformed.plan[0].reasons.includes("INVALID_TARGET_MONITORING_NUMBER"));
    assert.equal((await recordRef.get()).data().monitoringNumber, "MON-MALFORMED");
    assert.equal(JSON.stringify(malformed).includes("MON-MALFORMED"), false, "malformed raw values are not exposed");
  } finally {
    await duplicateRef.delete(); await counterRef.set(beforeCounter); await recordRef.set(beforeRecord);
  }
});
