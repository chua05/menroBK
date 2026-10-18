const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");
const { dateOnlyInManila, shiftCalendarDate } = require("../../src/utils/earlyMonitoring.util");

validateIntegrationEnvironment();
const { db } = require("../../src/config/firebase");
const monitoring = require("../../src/services/monitoring.service");
const analytics = require("../../src/services/analytics.service");
const { processEarlyMonitoringNotifications } = require("../../src/services/earlyMonitoringNotification.service");
const { extractImageMetadata, generateImageHash, validateImageBuffer } = require("../../src/utils/imageVerification.util");

const REPORT_ID = "early-acceptance-report";
const NOTIFICATION_REPORT_ID = "early-acceptance-notification-report";
const PARTICIPANT_ID = "phase2-participant";
const SITE_ID = "phase2-site";
const EVENT_ID = "early-acceptance-event";
const uploadRoot = process.env.MENRO_UPLOAD_ROOT;
const today = dateOnlyInManila();
// The committed synthetic evidence fixtures carry a 2026-10-01 capture date.
const openingDate = "2026-10-01";
const deadlineDate = shiftCalendarDate(openingDate, 6);
const officialOpeningDate = shiftCalendarDate(today, 5);
const plantingDate = shiftCalendarDate(officialOpeningDate, -14);
const lifecycleId = `MON-${crypto.createHash("sha256")
  .update([PARTICIPANT_ID, REPORT_ID, EVENT_ID, SITE_ID].join("|"))
  .digest("hex").slice(0, 20)}`;

async function evidence(name) {
  const buffer = await fs.readFile(path.join(__dirname, "fixtures", name));
  return {
    file: { buffer, originalname: name, mimetype: "image/jpeg", size: buffer.length },
    imageDetails: await validateImageBuffer(buffer),
    metadata: await extractImageMetadata(buffer),
    imageHash: generateImageHash(buffer),
  };
}

async function removeFixtures() {
  const hashes = await db.collection("monitoringEvidenceHashes").get();
  const batch = db.batch();
  [REPORT_ID, NOTIFICATION_REPORT_ID].forEach((id) => batch.delete(db.collection("plantingReports").doc(id)));
  batch.delete(db.collection("monitoringRecords").doc(lifecycleId));
  hashes.docs.filter((doc) => doc.data().lifecycleId === lifecycleId).forEach((doc) => batch.delete(doc.ref));
  const notices = await db.collection("notifications").where("relatedRecordId", "in", [REPORT_ID, NOTIFICATION_REPORT_ID]).get();
  notices.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  await db.collection("workerCheckpoints").doc("early-monitoring-notifications").delete();
  await fs.rm(path.join(uploadRoot, "monitoring", PARTICIPANT_ID), { recursive: true, force: true });
}

async function seedReport() {
  await db.collection("plantingReports").doc(REPORT_ID).set({
    reportNumber: "TEST-EARLY-001", participantId: PARTICIPANT_ID,
    participantName: "Phase 2 Participant", eventId: EVENT_ID,
    eventName: "Early Acceptance Planting", siteId: SITE_ID,
    siteName: "Phase 2 Test Site", barangay: "Bical", species: "Narra",
    quantityPlanted: 10, plantingDate, verificationStatus: "Approved",
    reportingProgress: "Completed", testFixture: true,
    earlyMonitoring: { enabled: true, applicable: true, policyVersion: 1,
      openingDate, deadlineDate, officialOpeningDate },
  });
}

async function submitEarly(name = "valid-original.jpg", overrides = {}) {
  return monitoring.createMonitoringRecord({ plantingReportId: REPORT_ID,
    totalMonitored: 10, healthyCount: 8, damagedCount: 1, deadCount: 1,
    maturityStatus: "Immature", monitoredDate: openingDate,
    remarks: "Early emulator acceptance observation", monitoredBy: PARTICIPANT_ID,
    requesterRole: "participant", observationType: "early",
    ...(await evidence(name)), ...overrides });
}

test.beforeEach(async () => { await removeFixtures(); await seedReport(); });
test.after(removeFixtures);

test("concurrent early submissions create one immutable early observation", async () => {
  const results = await Promise.allSettled([
    submitEarly("valid-original.jpg"), submitEarly("valid-replacement.jpg"),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  const lifecycle = (await db.collection("monitoringRecords").doc(lifecycleId).get()).data();
  assert.equal(lifecycle.history.length, 1);
  assert.equal(lifecycle.history[0].observationType, "early");
  assert.equal(lifecycle.history[0].reviewStatus, "Pending Review");
});

test("Staff/Admin approval of early monitoring never advances official scheduling or analytics", async () => {
  const before = await analytics.getDashboard();
  let lifecycle = await submitEarly();
  const observationId = lifecycle.history[0].id;
  lifecycle = await monitoring.reviewMonitoringObservation({ monitoringId: lifecycleId,
    observationId, expectedVersion: 0, actorId: "phase2-staff", actorRole: "staff" });
  lifecycle = await monitoring.approveMonitoringObservation({ monitoringId: lifecycleId,
    observationId, expectedVersion: 1, actorId: "phase2-admin", actorRole: "admin" });
  assert.equal(lifecycle.history[0].reviewStatus, "Approved");
  assert.equal(lifecycle.nextMonitoringDate, null);
  const after = await analytics.getDashboard();
  assert.equal(after.summary.overallSurvivalRate, before.summary.overallSurvivalRate);
  assert.equal(after.meta.latestMonitoringCount, before.meta.latestMonitoringCount);
});

test("returned early correction preserves ID and remains allowed after official opening", async () => {
  let lifecycle = await submitEarly();
  const observationId = lifecycle.history[0].id;
  lifecycle = await monitoring.returnMonitoringObservation({ monitoringId: lifecycleId,
    observationId, expectedVersion: 0, reason: "Recheck the sample", actorId: "phase2-staff", actorRole: "staff" });
  await db.collection("monitoringRecords").doc(lifecycleId).update({
    "earlyMonitoring.officialOpeningDate": shiftCalendarDate(today, -1),
  });
  lifecycle = await monitoring.resubmitMonitoringObservation({ monitoringId: lifecycleId,
    observationId, expectedVersion: 1, actorId: PARTICIPANT_ID, retainEvidenceRevision: 1,
    totalMonitored: 5, healthyCount: 3, damagedCount: 1, deadCount: 1,
    monitoredDate: openingDate, maturityStatus: "Immature", remarks: "Corrected early sample" });
  assert.equal(lifecycle.history[0].id, observationId);
  assert.equal(lifecycle.history[0].observationType, "early");
  assert.equal(lifecycle.history[0].reviewStatus, "Pending Review");
  assert.equal(lifecycle.history[0].revisionHistory.length, 2);
});

test("an unresolved early observation does not block an eligible official observation", async () => {
  const early = await submitEarly();
  await db.collection("monitoringRecords").doc(lifecycleId).update({
    startMonitoringDate: today,
    "earlyMonitoring.officialOpeningDate": today,
  });
  await db.collection("plantingReports").doc(REPORT_ID).update({ plantingDate: shiftCalendarDate(today, -14) });
  const official = await monitoring.createMonitoringRecord({ plantingReportId: REPORT_ID,
    totalMonitored: 10, healthyCount: 7, damagedCount: 2, deadCount: 1,
    maturityStatus: "Immature", monitoredDate: today, remarks: "Official while early is pending",
    monitoredBy: PARTICIPANT_ID, requesterRole: "participant", observationType: "official",
    ...(await evidence("valid-replacement.jpg")) });
  assert.equal(early.history[0].reviewStatus, "Pending Review");
  assert.equal(official.history.filter((entry) => entry.reviewStatus === "Pending Review").length, 2);
  assert.deepEqual(new Set(official.history.map((entry) => entry.observationType)), new Set(["early", "official"]));
});

test("concurrent notification worker retries create one deterministic notice", async () => {
  await db.collection("plantingReports").doc(NOTIFICATION_REPORT_ID).set({
    participantId: PARTICIPANT_ID, verificationStatus: "Approved", reportingProgress: "Completed",
    earlyMonitoring: { enabled: true, applicable: true, policyVersion: 1,
      openingDate: today, deadlineDate: shiftCalendarDate(today, 6),
      officialOpeningDate: shiftCalendarDate(today, 10) }, testFixture: true,
  });
  await Promise.all([
    processEarlyMonitoringNotifications({ today }),
    processEarlyMonitoringNotifications({ today }),
  ]);
  const id = `early_monitoring_available_${NOTIFICATION_REPORT_ID}`;
  const notice = await db.collection("notifications").doc(id).get();
  assert.equal(notice.exists, true);
  assert.equal(notice.data().recipientUserId, PARTICIPANT_ID);
  const notices = await db.collection("notifications").where("relatedRecordId", "==", NOTIFICATION_REPORT_ID).get();
  assert.equal(notices.size, 1);
});
