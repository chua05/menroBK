const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { nextRecordNumber } = require("../utils/recordNumber.util");

const reports = db.collection("plantingReports");
const submissions = db.collection("plantingContributions");
const events = db.collection("events");
const requests = db.collection("seedlingRequests");

function normalizeSubmission(entry = {}) {
  const verificationStatus = entry.verificationStatus ||
    (entry.automatedVerificationStatus === "Flagged" ? "Needs Review" : "Verified");
  const staffReviewStatus = entry.staffReviewStatus ||
    (verificationStatus === "Verified" ? "Not Required" : "Pending Review");
  return { ...entry, verificationStatus, staffReviewStatus };
}

function summarizeSubmissions(entries, releasedQuantity) {
  const submissions = entries.map(normalizeSubmission);
  const quantity = (items) => items.reduce((total, entry) => total + Number(entry.quantity || 0), 0);
  const active = submissions.filter((entry) => entry.staffReviewStatus !== "Rejected" && entry.verificationStatus !== "Invalid");
  const pending = active.filter((entry) => entry.verificationStatus === "Needs Review" && entry.staffReviewStatus === "Pending Review");
  const accepted = active.filter((entry) => entry.verificationStatus === "Verified" || entry.staffReviewStatus === "Accepted");
  const rejected = submissions.filter((entry) => entry.staffReviewStatus === "Rejected");
  const activeSubmittedQuantity = quantity(active);
  const acceptedQuantity = quantity(accepted);
  const pendingReviewQuantity = quantity(pending);
  const rejectedQuantity = quantity(rejected);
  const remainingAvailableQuantity = Math.max(0, Number(releasedQuantity || 0) - activeSubmittedQuantity);
  let reportingProgress = "Awaiting Submission";
  if (Number(releasedQuantity || 0) > 0 && acceptedQuantity >= Number(releasedQuantity) && pendingReviewQuantity === 0) {
    reportingProgress = "Completed";
  } else if (Number(releasedQuantity || 0) > 0 && activeSubmittedQuantity >= Number(releasedQuantity) && pendingReviewQuantity > 0) {
    reportingProgress = "Fully Reported — Awaiting Review";
  } else if (activeSubmittedQuantity > 0 || acceptedQuantity > 0) {
    reportingProgress = "Partial";
  }
  return { submissions, activeSubmittedQuantity, acceptedQuantity, pendingReviewQuantity,
    rejectedQuantity, remainingAvailableQuantity, reportingProgress };
}

function parentRef(eventId) {
  if (typeof eventId !== "string" || !eventId || eventId.includes("/")) {
    throw new Error("Invalid planting event ID.");
  }
  return reports.doc(`event_${eventId}`);
}

async function parentForEventInTransaction(transaction, eventId, event, now, initialQuantity = 0,
  initialStatus = "Pending", initialWorkflow = {}) {
  const requestId = event.sourceRequestId;
  if (!requestId) throw new Error("Event has no linked seedling request.");
  const ref = parentRef(eventId);
  const [parentDoc, requestDoc] = await Promise.all([
    transaction.get(ref),
    transaction.get(requests.doc(requestId)),
  ]);
  if (!requestDoc.exists || requestDoc.data().eventId !== eventId ||
      !["Approved", "Released"].includes(requestDoc.data().status)) {
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
  const reportNumber = await nextRecordNumber(transaction, {
    prefix: "RPT",
    counterKey: "plantingReports",
    date: typeof now?.toDate === "function" ? now.toDate() : new Date(),
    timestamp: now,
  });
  const data = {
    reportNumber,
    reportType: "parent",
    requestId,
    requestNumber: request.requestNumber || "",
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
    verificationStatus: initialStatus,
    activeSubmittedQuantity: Number(initialWorkflow.activeSubmittedQuantity ?? initialQuantity),
    acceptedQuantity: Number(initialWorkflow.acceptedQuantity || 0),
    pendingReviewQuantity: Number(initialWorkflow.pendingReviewQuantity || 0),
    rejectedQuantity: 0,
    remainingAvailableQuantity: Math.max(0, Number(event.seedlingTotalQuantity || 0) - Number(initialQuantity || 0)),
    reportingProgress: initialWorkflow.reportingProgress || (initialQuantity > 0 ? "Partial" : "Awaiting Submission"),
    ...(initialStatus === "Pending Review" ? { submittedAt: now } : {}),
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
  const quantityReleased = (event.seedlingItems || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const summary = summarizeSubmissions(contributions, quantityReleased || data.quantityReleased);
  const species = (event.seedlingItems || []).map((item) => {
    const recorded = summary.submissions.filter((entry) => entry.inventoryId === item.inventoryId &&
      entry.staffReviewStatus !== "Rejected" && entry.verificationStatus !== "Invalid")
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
  const latestContribution = contributions[contributions.length - 1] || null;
  const primaryContribution = contributions.find((entry) => entry.participantType === "requester") ||
    contributions.find((entry) => entry.photos?.length) || latestContribution;
  const primaryPhoto = primaryContribution?.photos?.[0] || null;
  const suspiciousFlags = [...new Set(evidence.flatMap((photo) => photo.suspiciousFlags || []))];
  return {
    id, ...data,
    photos: evidence,
    participantName: data.participantName || "",
    participantType: data.participantType || "",
    submittedByName: latestContribution?.contributorName || "",
    submittedByType: latestContribution?.participantUserType || "",
    participantBarangay: primaryContribution?.participantBarangay || data.participantBarangay || data.barangay || "",
    organizationAffiliation: primaryContribution?.organizationAffiliation || data.organizationAffiliation || "",
    participantContactNumber: primaryContribution?.participantContactNumber || data.participantContactNumber || "",
    species: primaryContribution?.species || data.species || "",
    plantingDate: primaryContribution?.plantingDate || data.plantingDate || data.eventDate || "",
    requestedQuantity: primaryContribution?.requestedQuantity ?? data.requestedQuantity ?? null,
    releasedItemQuantity: primaryContribution?.releasedQuantity ?? null,
    locationSource: primaryContribution?.locationSource || primaryPhoto?.locationSource || data.locationSource || "",
    gpsAccuracyMeters: primaryContribution?.gpsAccuracyMeters ?? primaryPhoto?.locationAccuracyMeters ?? null,
    locationCapturedAt: primaryContribution?.locationCapturedAt ?? primaryPhoto?.locationCapturedAt ?? null,
    photoTakenAt: primaryContribution?.photoCapturedAt ?? primaryPhoto?.photoCapturedAt ?? null,
    latitude: primaryContribution?.latitude ?? primaryPhoto?.metadata?.latitude ?? null,
    longitude: primaryContribution?.longitude ?? primaryPhoto?.metadata?.longitude ?? null,
    gpsMetadataPresent: primaryContribution?.gpsMetadataPresent ??
      (primaryPhoto ? primaryPhoto.gpsMetadataPresent === true : null),
    gpsValid: primaryContribution?.gpsValid ??
      (primaryPhoto ? primaryPhoto.gpsValid === true : null),
    siteGpsDistanceMeters: primaryContribution?.siteGpsDistanceMeters ??
      primaryPhoto?.siteGpsDistanceMeters ?? primaryPhoto?.gpsDistanceMeters ?? null,
    siteCoverageRadiusMeters: primaryContribution?.siteCoverageRadiusMeters ??
      primaryPhoto?.siteCoverageRadiusMeters ?? null,
    siteGpsToleranceMeters: primaryContribution?.siteGpsToleranceMeters ??
      primaryPhoto?.siteCoverageRadiusMeters ?? null,
    siteGpsValid: primaryContribution?.siteGpsValid ?? primaryPhoto?.siteGpsValid ?? null,
    siteLocationStatus: primaryContribution?.siteLocationStatus ??
      primaryPhoto?.siteLocationStatus ?? null,
    municipalityScope: primaryContribution?.municipalityScope ??
      primaryPhoto?.municipalityScope ?? null,
    siteMatch: primaryContribution?.siteMatch ?? primaryPhoto?.siteMatch ?? null,
    locationVerificationStatus: primaryContribution?.locationVerificationStatus ??
      primaryPhoto?.locationVerificationStatus ?? null,
    requiresStaffReview: primaryContribution?.requiresStaffReview ??
      primaryPhoto?.requiresStaffReview ?? false,
    verifiedAt: primaryContribution?.verifiedAt ?? primaryPhoto?.verifiedAt ?? null,
    allocationSummary: species,
    quantityReleased: species.reduce((sum, item) => sum + item.allocated, 0),
    quantityPlanted: summary.activeSubmittedQuantity,
    ...summary,
    contributorCount: new Set(contributions.map((entry) => entry.contributorId || entry.participantId)).size,
    evidenceCount: evidence.length,
    automatedVerificationStatus: evidence.length === 0 ? null
      : evidence.some((photo) => photo.automatedStatus === "Flagged" ||
          (photo.automatedStatus === undefined && photo.suspiciousFlags?.length))
        ? "Flagged"
        : evidence.every((photo) => photo.automatedStatus === "Passed Automated Check")
          ? "Passed Automated Check" : null,
    suspiciousFlags,
    submissions: summary.submissions.map((entry) => ({
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
    if (!reportDoc.exists || reportDoc.data().reportType !== "parent") {
      throw new Error("Planting report not found.");
    }
    if (reportDoc.data().verificationStatus === "Pending Review") return;
    if (!["Draft", "Pending"].includes(reportDoc.data().verificationStatus)) {
      throw new Error("Only pending planting reports can be submitted for review.");
    }
    const eventDoc = await transaction.get(events.doc(reportDoc.data().eventId));
    const submissionSnapshot = await transaction.get(submissions.where("reportId", "==", id));
    if (!eventDoc.exists || !eventDoc.data().allocationReleasedAt ||
        Number(eventDoc.data().recordedSeedlingQuantity || 0) <= 0) {
      throw new Error("The report has no recorded planting contributions.");
    }
    const submitterSubmissions = submissionSnapshot.docs.filter((doc) =>
      doc.data().contributorId === requesterId || doc.data().participantId === requesterId);
    if (submitterSubmissions.length === 0) {
      throw new Error("Planting evidence photos are required before review.");
    }
    if (submitterSubmissions.some((doc) => !doc.data().photos?.length)) {
      throw new Error("Planting evidence photos are required before review.");
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

module.exports = { parentRef, parentForEventInTransaction, reportDetails, finalizeParent,
  normalizeSubmission, summarizeSubmissions };
