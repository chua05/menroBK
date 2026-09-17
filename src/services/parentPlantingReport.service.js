const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const reports = db.collection("plantingReports");
const submissions = db.collection("plantingContributions");
const events = db.collection("events");
const requests = db.collection("seedlingRequests");

function parentRef(eventId) {
  if (typeof eventId !== "string" || !eventId || eventId.includes("/")) {
    throw new Error("Invalid planting event ID.");
  }
  return reports.doc(`event_${eventId}`);
}

async function parentForEventInTransaction(transaction, eventId, event, now, initialQuantity = 0) {
  const requestId = event.sourceRequestId;
  if (!requestId) throw new Error("Event has no linked seedling request.");
  const ref = parentRef(eventId);
  const [parentDoc, requestDoc] = await Promise.all([
    transaction.get(ref),
    transaction.get(requests.doc(requestId)),
  ]);
  if (!requestDoc.exists || requestDoc.data().eventId !== eventId ||
      requestDoc.data().status !== "Approved") {
    throw new Error("Event and approved request do not match.");
  }
  if (parentDoc.exists) {
    if (parentDoc.data().requestId !== requestId) {
      throw new Error("Planting report relationship is inconsistent.");
    }
    return { ref, data: parentDoc.data(), created: false };
  }
  const historical = await transaction.get(reports.where("eventId", "==", eventId).limit(1));
  if (!historical.empty) {
    const legacyDoc = historical.docs[0];
    if ((legacyDoc.data().requestId || legacyDoc.data().distributionId) !== requestId) {
      throw new Error("Planting report relationship is inconsistent.");
    }
    return { ref: legacyDoc.ref || reports.doc(legacyDoc.id), data: legacyDoc.data(), created: false };
  }
  const request = requestDoc.data();
  const data = {
    reportType: "parent",
    requestId,
    eventId,
    distributionId: requestId,
    participantId: request.participantId,
    participantName: request.participantName || "",
    eventName: event.name || "",
    siteId: event.plantingSiteId || "",
    siteName: event.plantingSiteName || "",
    barangay: event.barangay || "",
    eventDate: event.date || "",
    quantityReleased: Number(event.seedlingTotalQuantity || 0),
    quantityPlanted: initialQuantity,
    verificationStatus: "Draft",
    createdAt: now,
    updatedAt: now,
  };
  transaction.create(ref, data);
  return { ref, data, created: true };
}

async function reportDetails(id, data) {
  if (data.reportType !== "parent") return { id, ...data };
  const [eventDoc, submissionSnapshot, participantSnapshot] = await Promise.all([
    events.doc(data.eventId).get(),
    submissions.where("reportId", "==", id).get(),
    db.collection("eventParticipants").where("eventId", "==", data.eventId).get(),
  ]);
  const event = eventDoc.exists ? eventDoc.data() : {};
  const contributions = submissionSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const participantById = new Map(participantSnapshot.docs.map((doc) => [doc.id, doc.data()]));
  const species = (event.seedlingItems || []).map((item) => {
    const recorded = contributions.filter((entry) => entry.inventoryId === item.inventoryId)
      .reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    return {
      inventoryId: item.inventoryId,
      species: item.species,
      allocated: Number(item.quantity || 0),
      recorded,
      remaining: Number(item.quantity || 0) - recorded,
    };
  });
  const evidence = contributions.flatMap((entry) => entry.photos || []);
  const suspiciousFlags = [...new Set(evidence.flatMap((photo) => photo.suspiciousFlags || []))];
  return {
    id, ...data,
    allocationSummary: species,
    quantityReleased: species.reduce((sum, item) => sum + item.allocated, 0),
    quantityPlanted: species.reduce((sum, item) => sum + item.recorded, 0),
    contributorCount: new Set(contributions.map((entry) => entry.participantId)).size,
    evidenceCount: evidence.length,
    automatedVerificationStatus: evidence.length === 0 ? null
      : (suspiciousFlags.length > 0 || evidence.some((photo) => photo.automatedStatus === "Flagged"))
        ? "Flagged" : "Passed Automated Check",
    suspiciousFlags,
    submissions: contributions.map((entry) => ({
      ...entry,
      contributorName: participantById.get(entry.participantId)?.fullName || entry.contributorName || "",
      organizationBarangay: participantById.get(entry.participantId)?.organizationBarangay || "",
    })),
  };
}

async function finalizeParent(id, requesterId) {
  const ref = reports.doc(id);
  await db.runTransaction(async (transaction) => {
    const reportDoc = await transaction.get(ref);
    if (!reportDoc.exists || reportDoc.data().reportType !== "parent" ||
        reportDoc.data().participantId !== requesterId) {
      throw new Error("Planting report not found.");
    }
    if (reportDoc.data().verificationStatus !== "Draft") {
      throw new Error("Only draft planting reports can be finalized.");
    }
    const eventDoc = await transaction.get(events.doc(reportDoc.data().eventId));
    const submissionSnapshot = await transaction.get(submissions.where("reportId", "==", id));
    if (!eventDoc.exists || !eventDoc.data().allocationReleasedAt ||
        Number(eventDoc.data().recordedSeedlingQuantity || 0) <= 0) {
      throw new Error("The report has no recorded planting contributions.");
    }
    if (submissionSnapshot.empty || submissionSnapshot.docs.some((doc) => !doc.data().photos?.length)) {
      throw new Error("Every planting contribution needs evidence photos before finalization.");
    }
    const now = Timestamp.now();
    transaction.update(ref, {
      verificationStatus: "Pending Review",
      quantityPlanted: Number(eventDoc.data().recordedSeedlingQuantity),
      submittedAt: now,
      updatedAt: now,
    });
  });
  const doc = await ref.get();
  return reportDetails(doc.id, doc.data());
}

module.exports = { parentRef, parentForEventInTransaction, reportDetails, finalizeParent };
