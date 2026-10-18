const { Timestamp } = require("firebase-admin/firestore");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

validateIntegrationEnvironment();
const { db } = require("../../src/config/firebase");
const PREFIX = "closure-";

const records = {
  requestA: "closure-request-a", requestB: "closure-request-b",
  reportA: "closure-report-a", reportB: "closure-report-b",
  contributionA: "closure-contribution-a", monitoringA: "closure-monitoring-a",
  observationA: "closure-observation-a", eventA: "closure-event-a",
  requestEvent: "closure-request-event", inventory: "closure-inventory",
  distribution: "closure-distribution",
};

async function removeFixtures() {
  const collections = ["seedlingRequests", "plantingReports", "plantingContributions",
    "monitoringRecords", "events", "seedlingInventory", "distributions", "notifications"];
  for (const name of collections) {
    const snapshot = await db.collection(name).get();
    const refs = snapshot.docs.filter((doc) => doc.id.startsWith(PREFIX));
    while (refs.length) {
      const batch = db.batch();
      refs.splice(0, 400).forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
  }
}

function notice(id, recipientUserId, relatedRecordType, relatedRecordId, extra = {}, seconds = 0) {
  return {
    recipientUserId, type: `closure_${relatedRecordType}`, title: `Closure ${id}`,
    message: `Open ${relatedRecordId}`, relatedRecordType, relatedRecordId,
    isRead: false, readAt: null,
    createdAt: Timestamp.fromMillis(Date.now() + 60_000 + seconds * 1_000),
    testFixture: true, ...extra,
  };
}

async function seed() {
  await removeFixtures();
  const now = Timestamp.now();
  const batch = db.batch();
  for (const [id, participantId, number] of [
    [records.requestA, "phase2-participant", "CLOSURE-REQ-A"],
    [records.requestB, "phase2-other", "CLOSURE-REQ-B"],
  ]) batch.set(db.collection("seedlingRequests").doc(id), {
    requestNumber: number, participantId, participantName: participantId,
    status: "Pending Review", purpose: "Closure acceptance", createdAt: now,
    trees: [{ inventoryId: records.inventory, species: "Narra", quantity: 5 }],
    archived: false, testFixture: true,
  });
  const contribution = { id: records.contributionA, contributorId: "phase2-participant",
    participantId: "phase2-participant", participantName: "Phase 2 Participant",
    quantityPlanted: 5, reviewStatus: "Pending", verificationStatus: "Pending" };
  batch.set(db.collection("plantingReports").doc(records.reportA), {
    reportNumber: "CLOSURE-REPORT-A", participantId: "phase2-participant",
    participantName: "Phase 2 Participant", eventId: records.eventA,
    eventName: "Closure Manual Event", siteId: "phase2-site", siteName: "Phase 2 Test Site",
    quantityPlanted: 5, plantingDate: "2026-10-01", submissions: [contribution],
    verificationStatus: "Pending", reportingProgress: "For Verification", testFixture: true,
  });
  batch.set(db.collection("plantingReports").doc(records.reportB), {
    reportNumber: "CLOSURE-REPORT-B", participantId: "phase2-other",
    participantName: "Other Participant", eventName: "Other Event", siteId: "phase2-site",
    quantityPlanted: 3, plantingDate: "2026-10-01", verificationStatus: "Pending",
    reportingProgress: "For Verification", testFixture: true,
  });
  batch.set(db.collection("plantingContributions").doc(records.contributionA), {
    ...contribution, parentReportId: records.reportA, eventId: records.eventA, testFixture: true,
  });
  batch.set(db.collection("monitoringRecords").doc(records.monitoringA), {
    participantId: "phase2-participant", plantingReportId: records.reportA,
    plantingReportNumber: "CLOSURE-REPORT-A", siteId: "phase2-site",
    siteName: "Phase 2 Test Site", quantityPlanted: 5, archived: false, testFixture: true,
    history: [{ id: records.observationA, monitoredBy: "phase2-participant",
      originalReporterId: "phase2-participant", monitoredDate: "2026-10-10",
      totalMonitored: 5, healthyCount: 4, damagedCount: 0, deadCount: 1,
      reviewStatus: "Pending Review", reviewVersion: 0 }],
  });
  for (const [id, name, sourceRequestId] of [
    [records.eventA, "Closure Manual Event", ""],
    [records.requestEvent, "Closure Request Event", records.requestA],
  ]) batch.set(db.collection("events").doc(id), {
    name, type: "Tree Planting", recordStatus: "scheduled",
    date: "2026-10-20", startTime: "09:00", endTime: "11:00",
    barangay: "Bical", plantingSiteId: "phase2-site", plantingSiteName: "Phase 2 Test Site",
    createdBy: "phase2-staff", sourceRequestId, archived: false, testFixture: true,
  });
  batch.set(db.collection("seedlingInventory").doc(records.inventory), {
    inventoryNumber: "CLOSURE-INV-001", batchReference: "CLOSURE-BATCH-001",
    species: "Narra", treeName: "Narra", initialQuantity: 20, currentQuantity: 15,
    availableQuantity: 15, reservedQuantity: 0, status: "Available", archived: false,
    dateReceived: "2026-10-01", testFixture: true,
  });
  batch.set(db.collection("distributions").doc(records.distribution), {
    distributionNumber: "CLOSURE-DIST-001", participantId: "phase2-participant",
    participantName: "Phase 2 Participant", requestId: records.requestA,
    requestNumber: "CLOSURE-REQ-A", eventId: records.eventA, plantingSiteId: "phase2-site",
    status: "Released", totalQuantityReleased: 5, releasedAt: now,
    items: [{ inventoryId: records.inventory, species: "Narra", releasedQuantity: 5 }],
    testFixture: true,
  });
  const targets = [
    ["request", "seedlingRequest", records.requestA, {}],
    ["report", "plantingReport", records.reportA, {}],
    ["contribution", "plantingReport", records.reportA, { relatedSubrecordId: records.contributionA }],
    ["monitoring", "monitoring", records.monitoringA, { relatedSubrecordId: records.observationA }],
    ["event", "event", records.eventA, { relatedEventId: records.eventA }],
    ["inventory", "inventory", records.inventory, {}],
    ["distribution", "distribution", records.distribution, {}],
  ];
  targets.forEach(([key, type, recordId, extra], index) => {
    batch.set(db.collection("notifications").doc(`${PREFIX}admin-${key}`),
      notice(key, "phase2-admin", type, recordId, extra, index));
    batch.set(db.collection("notifications").doc(`${PREFIX}staff-${key}`),
      notice(key, "phase2-staff", type, recordId, extra, 10 + index));
  });
  targets.slice(0, 5).forEach(([key, type, recordId, extra], index) => {
    batch.set(db.collection("notifications").doc(`${PREFIX}participant-${key}`),
      notice(key, "phase2-participant", type, recordId, extra, 20 + index));
  });
  await batch.commit();
}

(process.argv.includes("--cleanup") ? removeFixtures() : seed())
  .then(() => console.log(process.argv.includes("--cleanup")
    ? "Notification closure fixtures removed." : "Notification closure fixtures seeded."))
  .catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { records, removeFixtures, seed };
