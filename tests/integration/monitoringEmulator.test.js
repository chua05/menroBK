const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Timestamp } = require("firebase-admin/firestore");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

validateIntegrationEnvironment();
const { db } = require("../../src/config/firebase");
const service = require("../../src/services/monitoring.service");
const analytics = require("../../src/services/analytics.service");
const evidence = require("../../src/services/evidenceAccess.service");
const { extractImageMetadata, generateImageHash, isClearlyScreenshot,
  validateImageBuffer } = require("../../src/utils/imageVerification.util");

const collection = db.collection("monitoringRecords");
const id = "phase2-integration-workflow";
const analyticsId = "phase2-integration-analytics-partial";
const fixtureRoot = path.join(__dirname, "fixtures");
const uploadRoot = process.env.MENRO_UPLOAD_ROOT;
const submittedLifecycleId = `MON-${crypto.createHash("sha256")
  .update(["phase2-participant", "phase2-report", "phase2-event", "phase2-site"].join("|"))
  .digest("hex").slice(0, 20)}`;

async function fileData(name) {
  const buffer = await fs.readFile(path.join(fixtureRoot, name));
  return { file: { buffer, originalname: name, mimetype: "image/jpeg", size: buffer.length },
    imageDetails: await validateImageBuffer(buffer), metadata: await extractImageMetadata(buffer),
    imageHash: generateImageHash(buffer) };
}

async function submit(name = "valid-original.jpg", overrides = {}) {
  return service.createMonitoringRecord({ plantingReportId: "phase2-report", totalMonitored: 10,
    healthyCount: 8, damagedCount: 1, deadCount: 1, maturityStatus: "Immature",
    monitoredDate: "2026-10-01", remarks: "Emulator integration observation",
    monitoredBy: "phase2-participant", requesterRole: "participant",
    ...(await fileData(name)), ...overrides });
}

async function clearSubmissionFixtures() {
  await Promise.all([
    collection.doc(submittedLifecycleId).delete(),
    db.collection("monitoringEvidenceHashes").get().then((snapshot) =>
      Promise.all(snapshot.docs.filter((doc) => doc.data().lifecycleId === submittedLifecycleId)
        .map((doc) => doc.ref.delete()))),
    fs.rm(path.join(uploadRoot, "monitoring", "phase2-participant"), { recursive: true, force: true }),
  ]);
}

function pendingObservation() {
  return { id: "phase2-observation", workflowVersion: 2, reviewStatus: "Pending Review",
    reviewVersion: 0, originalReporterId: "phase2-participant", monitoredBy: "phase2-participant",
    monitoredDate: "2026-10-01", totalMonitored: 10, cohortQuantityAtObservation: 10,
    isFullCohortAssessment: true, healthyCount: 8, damagedCount: 1, deadCount: 1,
    photoUrl: "/uploads/monitoring/phase2-participant/test.jpg", revisionNumber: 1,
    auditHistory: [], revisionHistory: [{ revisionNumber: 1, evidenceRef: { photoUrl: "/uploads/monitoring/phase2-participant/test.jpg" } }] };
}

async function reset() {
  const notices = await db.collection("notifications").where("relatedRecordId", "==", id).get();
  if (!notices.empty) {
    const batch = db.batch();
    notices.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  await collection.doc(id).set({ recordType: "monitoringLifecycle", participantId: "phase2-participant",
    plantingReportId: "phase2-report", siteId: "phase2-site", quantityPlanted: 10,
    startMonitoringDate: "2026-09-15", nextMonitoringDate: null, monitoringEndDate: "2028-09-01",
    history: [pendingObservation()], archived: false });
}

test.beforeEach(reset);
test.after(async () => {
  await Promise.all([collection.doc(id).delete(), collection.doc(analyticsId).delete()]);
  await clearSubmissionFixtures();
});

test("concurrent Staff review is transaction-safe and rejects the loser", async () => {
  const action = () => service.reviewMonitoringObservation({ monitoringId: id,
    observationId: "phase2-observation", expectedVersion: 0, remarks: "Checked",
    actorId: "phase2-staff", actorRole: "staff" });
  const results = await Promise.allSettled([action(), action()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const stored = (await collection.doc(id).get()).data().history[0];
  assert.equal(stored.reviewStatus, "Reviewed");
  assert.equal(stored.reviewVersion, 1);
  assert.equal(stored.auditHistory.length, 1);
});

test("concurrent Admin final decisions produce one final immutable outcome", async () => {
  const reviewed = pendingObservation();
  reviewed.reviewStatus = "Reviewed"; reviewed.reviewVersion = 1;
  reviewed.staffReviewedBy = "phase2-staff"; reviewed.staffReviewedAt = Timestamp.now();
  await collection.doc(id).update({ history: [reviewed] });
  const approve = service.approveMonitoringObservation({ monitoringId: id,
    observationId: reviewed.id, expectedVersion: 1, actorId: "phase2-admin", actorRole: "admin" });
  const reject = service.rejectMonitoringObservation({ monitoringId: id,
    observationId: reviewed.id, expectedVersion: 1, reason: "Test rejection",
    actorId: "phase2-admin", actorRole: "admin" });
  const results = await Promise.allSettled([approve, reject]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const stored = (await collection.doc(id).get()).data().history[0];
  assert.ok(["Approved", "Rejected"].includes(stored.reviewStatus));
  await assert.rejects(() => service.reviewMonitoringObservation({ monitoringId: id,
    observationId: reviewed.id, expectedVersion: stored.reviewVersion,
    actorId: "phase2-staff", actorRole: "staff" }), /Only pending|changed/);
});

test("stale versions and malformed legacy schedules fail safely", async () => {
  await assert.rejects(() => service.reviewMonitoringObservation({ monitoringId: id,
    observationId: "phase2-observation", expectedVersion: 9,
    actorId: "phase2-staff", actorRole: "staff" }), /changed while it was being reviewed/);
  assert.equal(service.lifecycleStatus({ quantityPlanted: 10, startMonitoringDate: "2026-01-01",
    monitoringEndDate: "2028-01-01", nextMonitoringDate: null,
    history: [{ reviewStatus: "Validated", totalMonitored: 10 }] }, "2026-10-01"),
  "Available for Monitoring");
});

test("concurrent submissions persist exactly one unresolved observation and clean the loser", async () => {
  await clearSubmissionFixtures();
  const results = await Promise.allSettled([submit("valid-original.jpg"), submit("valid-replacement.jpg")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const stored = (await collection.doc(submittedLifecycleId).get()).data();
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].reviewStatus, "Pending Review");
  assert.equal(stored.nextMonitoringDate, null);
  const files = await fs.readdir(path.join(uploadRoot, "monitoring", "phase2-participant"));
  assert.equal(files.length, 1, "the rejected transaction upload must be removed");
});

test("only Admin-approved full coverage advances scheduling; partial and rejected do not", async () => {
  await clearSubmissionFixtures();
  let record = await submit();
  const observationId = record.history[0].id;
  record = await service.reviewMonitoringObservation({ monitoringId: submittedLifecycleId, observationId,
    expectedVersion: 0, actorId: "phase2-staff", actorRole: "staff" });
  assert.equal(record.nextMonitoringDate, null);
  record = await service.approveMonitoringObservation({ monitoringId: submittedLifecycleId, observationId,
    expectedVersion: 1, actorId: "phase2-admin", actorRole: "admin" });
  assert.equal(record.nextMonitoringDate, "2026-11-05");

  await clearSubmissionFixtures();
  record = await submit("valid-replacement.jpg", { totalMonitored: 5, healthyCount: 3, damagedCount: 1, deadCount: 1 });
  const partialId = record.history[0].id;
  await service.reviewMonitoringObservation({ monitoringId: submittedLifecycleId, observationId: partialId,
    expectedVersion: 0, actorId: "phase2-staff", actorRole: "staff" });
  record = await service.rejectMonitoringObservation({ monitoringId: submittedLifecycleId, observationId: partialId,
    expectedVersion: 1, reason: "Synthetic rejection", actorId: "phase2-admin", actorRole: "admin" });
  assert.equal(record.nextMonitoringDate, null);
  const replacement = await submit("valid-original.jpg");
  assert.equal(replacement.history.length, 2, "a rejected observation permits one new observation");
});

test("returned observation preserves ID across partial/full corrections and evidence revisions", async () => {
  await clearSubmissionFixtures();
  let record = await submit();
  const observationId = record.history[0].id;
  record = await service.returnMonitoringObservation({ monitoringId: submittedLifecycleId, observationId,
    expectedVersion: 0, reason: "Recheck coverage", actorId: "phase2-staff", actorRole: "staff" });
  record = await service.resubmitMonitoringObservation({ monitoringId: submittedLifecycleId, observationId,
    expectedVersion: 1, actorId: "phase2-participant", retainEvidenceRevision: 1,
    totalMonitored: 5, healthyCount: 3, damagedCount: 1, deadCount: 1,
    monitoredDate: "2026-10-01", maturityStatus: "Immature", remarks: "Partial correction" });
  assert.equal(record.history[0].id, observationId);
  assert.equal(record.history[0].isFullCohortAssessment, false);
  assert.equal(record.history[0].revisionHistory.length, 2);
  record = await service.returnMonitoringObservation({ monitoringId: submittedLifecycleId, observationId,
    expectedVersion: 2, reason: "Check full cohort", actorId: "phase2-staff", actorRole: "staff" });
  const replacement = await fileData("valid-replacement.jpg");
  record = await service.resubmitMonitoringObservation({ monitoringId: submittedLifecycleId, observationId,
    expectedVersion: 3, actorId: "phase2-participant", totalMonitored: 10,
    healthyCount: 8, damagedCount: 1, deadCount: 1, monitoredDate: "2026-10-02",
    maturityStatus: "Immature", remarks: "Full correction", ...replacement });
  assert.equal(record.history[0].id, observationId);
  assert.equal(record.history[0].isFullCohortAssessment, true);
  assert.equal(record.history[0].revisionHistory.length, 3);
  await evidence.monitoringRevisionEvidenceForUser(submittedLifecycleId, observationId, 1,
    { uid: "phase2-participant", role: "participant" });
  await assert.rejects(() => evidence.monitoringRevisionEvidenceForUser(submittedLifecycleId, observationId, 1,
    { uid: "phase2-other", role: "participant" }), /forbidden/i);
});

test("synthetic evidence exercises GPS, timestamps, suspicious flags, and duplicate hashing", async () => {
  const original = await fileData("valid-original.jpg");
  const outside = await fileData("outside-site.jpg");
  const missing = await fileData("missing-gps.jpg");
  const screenshot = await fileData("screenshot-like.jpg");
  const duplicate = await fileData("duplicate-original.jpg");
  assert.equal(original.metadata.latitude, 12.671);
  assert.equal(original.metadata.longitude, 123.875);
  assert.ok(original.metadata.capturedAt instanceof Date);
  assert.equal(missing.metadata.latitude, null);
  assert.equal(isClearlyScreenshot({ fileName: "screenshot-like.jpg", metadata: screenshot.metadata }), true);
  assert.equal(original.imageHash, duplicate.imageHash);
  await clearSubmissionFixtures();
  const flagged = await submit("outside-site.jpg");
  assert.equal(flagged.history[0].siteGpsValid, false);
  assert.equal(flagged.history[0].automatedVerificationStatus, "Flagged");
  assert.ok(outside.metadata.latitude > 12.68);
});

test("newer approved partial observation suppresses older full-cohort analytics", async () => {
  await collection.doc(analyticsId).set({ recordType: "monitoringLifecycle",
    participantId: "phase2-participant", plantingReportId: "phase2-report",
    siteId: "phase2-site", siteName: "Phase 2 Test Site", barangay: "Bical",
    species: "Narra", quantityPlanted: 10, authoritativePlantingDate: "2026-09-01",
    startMonitoringDate: "2026-09-15", monitoringEndDate: "2028-09-01", archived: false,
    history: [
      { id: "older-full", workflowVersion: 2, reviewStatus: "Approved",
        monitoredDate: "2026-10-01", totalMonitored: 10, healthyCount: 0,
        damagedCount: 0, deadCount: 10, isFullCohortAssessment: true },
      { id: "newer-partial", workflowVersion: 2, reviewStatus: "Approved",
        monitoredDate: "2026-10-10", totalMonitored: 5, healthyCount: 5,
        damagedCount: 0, deadCount: 0, isFullCohortAssessment: false },
    ] });
  const dashboard = await analytics.getDashboard();
  assert.equal(dashboard.summary.overallSurvivalRate, 90);
  assert.equal(dashboard.meta.latestMonitoringCount, 2);
  const october = dashboard.survivalTrend.find((entry) => entry.period === "Oct 2026");
  assert.equal(october?.rate, null);
});
