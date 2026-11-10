// Planting report review workflow against the Firestore emulator.
// Real transactions enforce read-before-write ordering that unit mocks cannot.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

validateIntegrationEnvironment();
const { db } = require("../../src/config/firebase");
const reports = require("../../src/services/plantingReport.service");
const official = require("../../src/services/officialPlantingReport.service");

const PREFIX = `planting-review-${Date.now()}`;
const STAFF = { uid: `${PREFIX}-staff`, name: "Emulator Staff", role: "staff" };
const ADMIN = { uid: `${PREFIX}-admin`, name: "Emulator Admin", role: "admin" };
const PARTICIPANT = `${PREFIX}-participant`;
const created = { users: [STAFF.uid, ADMIN.uid, PARTICIPANT], reports: [], events: [], requests: [], contributions: [] };

const forward = (id) => reports.forwardPlantingReport(id, STAFF.uid, "Evidence reviewed", STAFF.name, STAFF.role);
const staffReturn = (id, reason) => reports.returnPlantingReport(id, STAFF.uid, reason, STAFF.name, STAFF.role);
const approve = (id) => reports.approvePlantingReport(id, ADMIN.uid, "Confirmed", ADMIN.name, ADMIN.role);
const reject = (id, reason) => reports.rejectPlantingReport(id, ADMIN.uid, reason, ADMIN.name, ADMIN.role);

async function seedParticipantReport() {
  const eventId = `${PREFIX}-event`, reportId = `event_${eventId}`;
  created.events.push(eventId); created.reports.push(reportId);
  await db.collection("events").doc(eventId).set({ seedlingTotalQuantity: 30, recordedSeedlingQuantity: 30, remainingSeedlingQuantity: 0,
    recordedSeedlingsByInventory: { narra: 30 }, seedlingItems: [{ inventoryId: "narra", quantity: 30, species: "Narra" }] });
  await db.collection("plantingReports").doc(reportId).set({ reportType: "parent", reportNumber: `RPT-${PREFIX}`, requestId: `${PREFIX}-request`, eventId,
    siteId: `${PREFIX}-site`, distributionId: `${PREFIX}-request`, quantityReleased: 30, quantityPlanted: 30, activeSubmittedQuantity: 30,
    acceptedQuantity: 0, pendingReviewQuantity: 30, rejectedQuantity: 0, remainingAvailableQuantity: 0,
    reportingProgress: "Fully Reported — Awaiting Review", verificationStatus: "Fully Reported — Awaiting Review", createdAt: new Date() });
  for (const suffix of ["approve", "return", "reject"]) {
    const id = `${PREFIX}-${suffix}`; created.contributions.push(id);
    // Legacy-shaped pending submission (no workflowStatus field) must enter the new Staff stage.
    await db.collection("plantingContributions").doc(id).set({ reportId, eventId, participantId: PARTICIPANT, contributorId: PARTICIPANT,
      inventoryId: "narra", quantity: 10, verificationStatus: "Verified", staffReviewStatus: "Pending Review", staffApprovalRequired: true,
      photos: [{ photoPath: `planting-reports/${PREFIX}/${suffix}.jpg`, gpsValid: true, siteGpsValid: true, timestampValid: true }] });
  }
  return { eventId, reportId };
}

test.before(async () => {
  for (const [uid, role] of [[STAFF.uid, "staff"], [ADMIN.uid, "admin"], [PARTICIPANT, "participant"]]) {
    await db.collection("users").doc(uid).set({ uid, role, status: "active", fullName: uid });
  }
});

test.after(async () => {
  const deleteWhere = async (collection, field, values) => {
    for (const value of values) {
      const snapshot = await db.collection(collection).where(field, "==", value).get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
  };
  const reportIds = [...new Set(created.reports)];
  await deleteWhere("notifications", "relatedRecordId", reportIds);
  await deleteWhere("verificationLogs", "plantingReportId", reportIds);
  await deleteWhere("plantingContributions", "reportId", reportIds);
  await deleteWhere("officialPlantingOperations", "reportId", reportIds);
  await deleteWhere("verifiedPlantingCohorts", "source.plantingReportId", reportIds);
  const remove = (collection, ids) => Promise.all([...new Set(ids)].map((id) => db.collection(collection).doc(id).delete()));
  await remove("plantingReports", reportIds);
  await remove("events", created.events);
  await remove("seedlingRequests", created.requests);
  await remove("distributions", created.requests);
  await remove("users", created.users);
});

test("participant report: Staff forward then Admin approval completes; return and rejection release quantities", async () => {
  const { eventId, reportId } = await seedParticipantReport();
  const approveId = `${PREFIX}-approve`, returnId = `${PREFIX}-return`, rejectId = `${PREFIX}-reject`;

  await assert.rejects(approve(approveId), (error) => error.status === 409 && /must review and forward/.test(error.message));
  await assert.rejects(reports.approvePlantingReport(approveId, STAFF.uid, "", STAFF.name, STAFF.role), (error) => error.status === 403);

  const forwarded = await forward(approveId);
  const forwardedRow = forwarded.submissions.find((row) => row.id === approveId);
  assert.equal(forwardedRow.workflowStatus, "Reviewed");
  assert.equal(forwarded.acceptedQuantity, 0, "Staff review never confirms quantities");
  assert.notEqual(forwarded.reportingProgress, "Completed");
  const adminNotice = await db.collection("notifications").doc(`planting_report_forwarded_${reportId}_${approveId}_${ADMIN.uid}`).get();
  assert.equal(adminNotice.data()?.type, "planting_report_forwarded");

  const approved = await approve(approveId);
  assert.equal(approved.submissions.find((row) => row.id === approveId).workflowStatus, "Completed");
  assert.equal(approved.acceptedQuantity, 10);

  await assert.rejects(staffReturn(returnId, "  "), (error) => error.status === 400);
  const returned = await staffReturn(returnId, "Retake the photo inside the site");
  const returnedRow = returned.submissions.find((row) => row.id === returnId);
  assert.equal(returnedRow.workflowStatus, "Returned for Correction");
  assert.equal(returnedRow.correctionAllowed, true);
  assert.equal(returned.returnedQuantity, 10);
  assert.equal(returned.rejectedQuantity, 0);
  assert.equal((await db.collection("events").doc(eventId).get()).data().recordedSeedlingQuantity, 20);

  await forward(rejectId);
  const rejected = await reject(rejectId, "Planted outside the approved site");
  const rejectedRow = rejected.submissions.find((row) => row.id === rejectId);
  assert.equal(rejectedRow.workflowStatus, "Rejected");
  assert.equal(rejectedRow.correctionAllowed, false);
  assert.equal(rejected.rejectedQuantity, 10);
  assert.equal(rejected.reportingProgress, "Partial", "only Admin-approved quantities count; nothing is completed early");
  assert.equal((await db.collection("events").doc(eventId).get()).data().recordedSeedlingQuantity, 10);

  const logs = await reports.getPlantingReportVerificationLogs(reportId);
  const actionsFor = (id) => logs.filter((log) => log.submissionId === id).map((log) => log.action);
  assert.deepEqual(actionsFor(approveId), ["Staff Review — Forwarded to Admin", "Admin Approval"]);
  assert.deepEqual(actionsFor(returnId), ["Staff Return for Correction"]);
  assert.deepEqual(actionsFor(rejectId), ["Staff Review — Forwarded to Admin", "Admin Rejection"]);
});

test("official Staff report: direct to Admin; rejection is final; a return is corrected and approved", async () => {
  const requestId = `${PREFIX}-official-request`, eventId = `${PREFIX}-official-event`, reportId = `event_${eventId}`;
  created.requests.push(requestId); created.events.push(eventId); created.reports.push(reportId);
  await db.collection("seedlingRequests").doc(requestId).set({ status: "Released", eventId, participantId: PARTICIPANT, participantName: "Emulator requester",
    requestType: "individual", workflow: { sector: "Resident / Individual" } });
  await db.collection("distributions").doc(requestId).set({ requestId, eventId, participantId: PARTICIPANT, status: "Released", items: [{ inventoryId: "narra", releasedQuantity: 10 }] });
  await db.collection("events").doc(eventId).set({ sourceRequestId: requestId, allocationReleasedAt: "2026-01-01", date: "2026-01-01", startTime: "08:00",
    plantingSiteId: `${PREFIX}-site`, seedlingItems: [{ inventoryId: "narra", species: "Narra", quantity: 10 }], seedlingTotalQuantity: 10 });
  await db.collection("plantingReports").doc(reportId).set({ reportType: "parent", requestId, eventId, participantId: PARTICIPANT, quantityReleased: 10,
    quantityPlanted: 0, acceptedQuantity: 0, activeSubmittedQuantity: 0, pendingReviewQuantity: 0, reportingProgress: "Awaiting Submission" });
  const staff = { uid: STAFF.uid, fullName: STAFF.name, role: "staff" }, admin = { uid: ADMIN.uid, fullName: ADMIN.name, role: "admin" };
  const submit = (version, extra = {}) => official.submitOfficialReport(staff, { requestId, confirmationBasis: "release-based",
    items: [{ inventoryId: "narra", leftoverQuantity: 2 }], remarks: "Emulator official report", clientSubmissionId: randomUUID(), expectedVersion: version, ...extra });

  const first = await submit(0); const firstId = first.officialSubmissionIds[0];
  assert.equal(first.submissions.find((row) => row.id === firstId).workflowStatus, "Pending Admin Approval");
  const notices = await db.collection("notifications").where("relatedSubrecordId", "==", firstId).get();
  assert.ok(notices.docs.some((doc) => doc.data().recipientUserId === ADMIN.uid && doc.data().type === "planting_report_submitted_admin"));
  await assert.rejects(official.reviewOfficialSubmission(staff, firstId, "approve"), (error) => error.status === 403);
  const rejected = await official.reviewOfficialSubmission(admin, firstId, "reject", "Release record does not match the field count");
  assert.equal(rejected.submissions.find((row) => row.id === firstId).workflowStatus, "Rejected");
  await assert.rejects(submit(2, { correctionOf: firstId }), (error) => error.status === 409, "an Admin rejection cannot be corrected");

  const second = await submit(2); const secondId = second.officialSubmissionIds[0];
  const returned = await reports.returnPlantingReport(secondId, ADMIN.uid, "Confirm the leftover count", ADMIN.name, ADMIN.role);
  assert.equal(returned.submissions.find((row) => row.id === secondId).workflowStatus, "Returned for Correction");
  const corrected = await submit(4, { correctionOf: secondId }); const correctedId = corrected.officialSubmissionIds[0];
  assert.equal(corrected.submissions.find((row) => row.id === correctedId).revision, 1);
  const approved = await reports.approvePlantingReport(correctedId, ADMIN.uid, "", ADMIN.name, ADMIN.role);
  assert.equal(approved.submissions.find((row) => row.id === correctedId).workflowStatus, "Completed");
  assert.equal(approved.reportingProgress, "Completed");
  assert.equal(approved.acceptedQuantity, 8);
});
