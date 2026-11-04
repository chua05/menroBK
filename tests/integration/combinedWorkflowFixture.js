const assert = require("node:assert/strict");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");
const { db } = require("../../src/config/firebase");
function idsFor(prefix) {
  assert.match(prefix, /^phase3c-browser-[0-9a-f-]{36}$/);
  const mode = validateIntegrationEnvironment();
  assert.equal(mode.projectId, "demo-menro-phase3c-isolated"); assert.equal(mode.integration, true);
  return { requestId: `${prefix}-official-request`, eventId: `${prefix}-official-event`, inventoryId: `${prefix}-inventory`, reportId: `event_${prefix}-official-event` };
}
async function seed(prefix) {
  const ids = idsFor(prefix), now = require("firebase-admin/firestore").Timestamp.now(), siteId = `${prefix}-site`;
  const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await db.collection("seedlingInventory").doc(ids.inventoryId).create({ species: "Narra", availableQuantity: 100, currentQuantity: 100, category: "Native", testFixture: prefix });
  await db.collection("seedlingRequests").doc(ids.requestId).create({ participantId: `${prefix}-participant`, participantName: "Disposable requester", requestType: "individual", status: "Released", eventId: ids.eventId,
    items: [{ inventoryId: ids.inventoryId, species: "Narra", quantity: 10 }], totalQuantity: 10, workflow: { sector: "Resident / Individual", effectiveRequestType: "individual" }, testFixture: prefix });
  await db.collection("distributions").doc(ids.requestId).create({ requestId: ids.requestId, eventId: ids.eventId, participantId: `${prefix}-participant`, status: "Released", items: [{ inventoryId: ids.inventoryId, species: "Narra", releasedQuantity: 10 }], totalQuantityReleased: 10, testFixture: prefix });
  await db.collection("events").doc(ids.eventId).create({ name: "Disposable official planting", type: "Tree Planting", date, startTime: "08:00", sourceRequestId: ids.requestId, allocationReleasedAt: now,
    plantingSiteId: siteId, plantingSiteName: "Phase 3C browser fixture", barangay: "Bical", seedlingItems: [{ inventoryId: ids.inventoryId, species: "Narra", quantity: 10 }], seedlingTotalQuantity: 10, status: "Approved", testFixture: prefix });
  await db.collection("plantingReports").doc(ids.reportId).create({ reportType: "parent", requestId: ids.requestId, eventId: ids.eventId, siteId, participantId: `${prefix}-participant`, quantityReleased: 10,
    quantityPlanted: 0, acceptedQuantity: 0, activeSubmittedQuantity: 0, pendingReviewQuantity: 0, reportingProgress: "Awaiting Submission", eventDate: date, createdAt: now, testFixture: prefix });
  return ids;
}
async function inspect(prefix) {
  const ids = idsFor(prefix), docs = [], operations = [];
  for (const [collection, id] of [["seedlingRequests", ids.requestId], ["distributions", ids.requestId], ["events", ids.eventId], ["plantingReports", ids.reportId], ["seedlingInventory", ids.inventoryId]]) {
    const doc = await db.collection(collection).doc(id).get();
    if (doc.exists) { assert.equal(doc.data().testFixture, prefix); docs.push(doc); }
  }
  const opSnapshot = await db.collection("officialPlantingOperations").where("requestId", "==", ids.requestId).get();
  for (const doc of opSnapshot.docs) {
    assert.equal(doc.data().staffId, `${prefix}-staff`); assert.equal(doc.data().reportId, ids.reportId); assert.equal(doc.data().eventId, ids.eventId);
    operations.push(doc); docs.push(doc);
  }
  const submissions = await db.collection("plantingContributions").where("reportId", "==", ids.reportId).get();
  for (const doc of submissions.docs) {
    const row = doc.data(); assert.equal(row.authenticatedSubmitterUid, `${prefix}-staff`); assert.equal(row.requestId, ids.requestId); assert.equal(row.eventId, ids.eventId);
    const operation = operations.find(op => op.id === row.officialOperationId); assert.ok(operation && operation.data().submissionIds.includes(doc.id)); docs.push(doc);
  }
  const cohorts = await db.collection("verifiedPlantingCohorts").where("source.requestId", "==", ids.requestId).get();
  for (const doc of cohorts.docs) { assert.equal(doc.data().source.siteId, `${prefix}-site`); assert.equal(doc.data().source.plantingReportId, ids.reportId); docs.push(doc); }
  for (const collection of ["notifications", "verificationLogs"]) {
    const field = collection === "notifications" ? "relatedRecordId" : "plantingReportId";
    const snapshot = await db.collection(collection).where(field, "==", ids.reportId).get();
    for (const doc of snapshot.docs) {
      if (collection === "notifications") assert.ok([`${prefix}-staff`, `${prefix}-admin`, `${prefix}-participant`].includes(doc.data().recipientUserId));
      else assert.equal(doc.data().performedBy, `${prefix}-admin`);
      docs.push(doc);
    }
  }
  const intentIds = operations.flatMap(doc => doc.data().attendanceIntent?.intentId ? [doc.data().attendanceIntent.intentId] : []);
  return { docs, operations, intentIds, requestId: ids.requestId };
}
async function cleanupObjects(inspection) {
  for (const doc of inspection.operations) await require("../../src/services/plantingAttendance.service").cleanupAttendanceObject(doc.id, inspection.requestId);
}
module.exports = { seed, inspect, cleanupObjects };
