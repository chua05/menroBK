const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { activationState } = require("../utils/earlyMonitoring.util");
const { nextRecordNumber } = require("../utils/recordNumber.util");
const { progressFor } = require("../utils/plantingBalance.util");
const { WORKFLOW_STATUS, deriveWorkflowStatus } = require("../utils/plantingReviewWorkflow.util");

const reports = db.collection("plantingReports");
const submissions = db.collection("plantingContributions");
const events = db.collection("events");
const requests = db.collection("seedlingRequests");

function normalizeSubmission(entry = {}) {
  const rawVerification = String(entry.verificationStatus || "").trim();
  const legacyNeedsReview = ["Flagged", "Reviewed", "Pending Review"]
    .includes(rawVerification) || entry.automatedVerificationStatus === "Flagged";
  const verificationStatus = ["Verified", "Needs Review", "Invalid"].includes(rawVerification)
    ? rawVerification
    : legacyNeedsReview ? "Needs Review" : "Verified";
  const rawReview = String(entry.staffReviewStatus || rawVerification).trim();
  const staffReviewStatus = ["Not Required", "Pending Review", "Accepted", "Rejected"]
    .includes(entry.staffReviewStatus)
    ? entry.staffReviewStatus
    : rawReview === "Rejected" ? "Rejected"
      : ["Approved", "Accepted"].includes(rawReview) ? "Accepted"
        : verificationStatus === "Verified" ? "Not Required" : "Pending Review";
  const workflowStatus = deriveWorkflowStatus({ ...entry, staffReviewStatus });
  return { ...entry, verificationStatus, staffReviewStatus, workflowStatus,
    correctionAllowed: workflowStatus === WORKFLOW_STATUS.RETURNED && !entry.correctedBySubmission };
}

function summarizeSubmissions(entries, releasedQuantity) {
  const submissions = entries.map(normalizeSubmission);
  const quantity = (items) => items.reduce((total, entry) => total + Number(entry.quantity || 0), 0);
  const active = submissions.filter((entry) => entry.staffReviewStatus !== "Rejected" && entry.verificationStatus !== "Invalid");
  const pending = active.filter((entry) => entry.staffReviewStatus === "Pending Review");
  // New submissions always require an explicit Staff decision. Historical
  // Verified/Not Required records remain official without fabricating reviews.
  const accepted = active.filter((entry) => entry.staffReviewStatus === "Accepted" ||
    (entry.staffApprovalRequired !== true && entry.verificationStatus === "Verified" &&
      entry.staffReviewStatus === "Not Required"));
  // Returned and rejected submissions both release their quantities; only the
  // reported split differs so corrections are not counted as final rejections.
  const released = submissions.filter((entry) => entry.staffReviewStatus === "Rejected");
  const returned = released.filter((entry) => entry.workflowStatus === WORKFLOW_STATUS.RETURNED);
  const rejected = released.filter((entry) => entry.workflowStatus !== WORKFLOW_STATUS.RETURNED);
  const activeSubmittedQuantity = quantity(active);
  const acceptedQuantity = quantity(accepted);
  const pendingReviewQuantity = quantity(pending);
  const rejectedQuantity = quantity(rejected);
  const returnedQuantity = quantity(returned);
  const leftover = items => items.reduce((total, entry) => total + Number(entry.leftoverQuantity || 0), 0);
  const declaredLeftoverQuantity = leftover(active), acceptedLeftoverQuantity = leftover(accepted), pendingReviewLeftoverQuantity = leftover(pending);
  const remainingAvailableQuantity = Math.max(0, Number(releasedQuantity || 0) - activeSubmittedQuantity - declaredLeftoverQuantity);
  const reportingProgress = progressFor({ released: Number(releasedQuantity || 0), active: activeSubmittedQuantity, accepted: acceptedQuantity, pending: pendingReviewQuantity,
    leftovers: declaredLeftoverQuantity, acceptedLeftovers: acceptedLeftoverQuantity, pendingLeftovers: pendingReviewLeftoverQuantity });
  return { submissions, activeSubmittedQuantity, acceptedQuantity, pendingReviewQuantity,
    rejectedQuantity, returnedQuantity, remainingAvailableQuantity, reportingProgress, declaredLeftoverQuantity, acceptedLeftoverQuantity, pendingReviewLeftoverQuantity };
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const seconds = value._seconds ?? value.seconds;
  if (Number.isFinite(Number(seconds))) return Number(seconds) * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

// Report-level review stage, summarised from each submission's workflowStatus
// (see plantingReviewWorkflow.util). Earliest unfinished stage wins so the
// report never looks further along than its least-reviewed submission.
const REVIEW_STAGE_ORDER = [
  WORKFLOW_STATUS.PENDING_REVIEW,
  WORKFLOW_STATUS.PENDING_ADMIN_APPROVAL,
  WORKFLOW_STATUS.REVIEWED,
  WORKFLOW_STATUS.RETURNED,
];

// Every submission approved so far, but released seedlings remain unreported
// (legacy partial reports, or a rejected/returned share): not Completed yet.
const AWAITING_REMAINING_REPORT = "Awaiting Remaining Report";

function activeStages(normalizedSubmissions) {
  return normalizedSubmissions
    .filter((entry) => entry.verificationStatus !== "Invalid" && !entry.correctedBySubmission)
    .map((entry) => entry.workflowStatus || deriveWorkflowStatus(entry));
}

// `reportingProgress` (optional) is the parent's quantity progress. Only a
// report whose progress is "Completed" (Admin-approved for its whole released
// balance, leftovers included) reads as Completed.
function reviewStatusFor(normalizedSubmissions, reportingProgress) {
  if (normalizedSubmissions.length === 0) return "Not Submitted";
  const stages = activeStages(normalizedSubmissions);
  for (const stage of REVIEW_STAGE_ORDER) if (stages.includes(stage)) return stage;
  if (stages.length > 0 && stages.every((stage) => stage === WORKFLOW_STATUS.REJECTED)) return WORKFLOW_STATUS.REJECTED;
  if (stages.includes(WORKFLOW_STATUS.COMPLETED)) {
    return reportingProgress === undefined || reportingProgress === "Completed"
      ? WORKFLOW_STATUS.COMPLETED : AWAITING_REMAINING_REPORT;
  }
  return WORKFLOW_STATUS.REJECTED;
}

// Every unfinished review stage present on the report, in workflow order, so a
// report waiting on both Staff and Admin is counted in both queues.
function reviewStagesFor(normalizedSubmissions) {
  const stages = activeStages(normalizedSubmissions);
  return REVIEW_STAGE_ORDER.filter((stage) => stages.includes(stage));
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
    ...(request.approvedPurposePolicy ? { reportingPolicy: require("./purposePolicy.service").releasePolicy(request.approvedPurposePolicy, Number(event.seedlingTotalQuantity || 0)) } : {}),
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
    remainingAvailableQuantity: Math.max(0, Number(event.seedlingTotalQuantity || 0) - Number(initialQuantity || 0) - Number(initialWorkflow.declaredLeftoverQuantity || 0)),
    ...(initialWorkflow.declaredLeftoverQuantity > 0 ? { declaredLeftoverQuantity: initialWorkflow.declaredLeftoverQuantity, pendingReviewLeftoverQuantity: initialWorkflow.declaredLeftoverQuantity, acceptedLeftoverQuantity: 0 } : {}),
    reportingProgress: initialWorkflow.reportingProgress || (initialQuantity > 0 ? "Partial" : "Awaiting Submission"),
    ...(initialStatus === "Pending Review" ? { submittedAt: now } : {}),
    createdAt: now,
    updatedAt: now,
  };
  if (!data.reportingPolicy && activationState().enabled && Number(initialQuantity) > 0) {
    data.earlyMonitoringOriginalSubmittedAt = now;
  }
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
  const allContributions = submissionSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  // Chronological order so "latest" really is the most recent submission. The
  // evidence endpoint resolves photo indexes through this same function, so
  // list photo indexes and secure photo retrieval stay aligned.
  const contributions = allContributions
    // Rows of a final report (v4) share one evidence set stored on the group's
    // first row, so the other per-type rows have no photos of their own.
    .filter((entry) => entry.officialStaffReport === true || Array.isArray(entry.photos) && entry.photos.length > 0 ||
      Boolean(entry.finalReportGroupId))
    .sort((a, b) => timestampMillis(a.recordedAt) - timestampMillis(b.recordedAt) ||
      String(a.id).localeCompare(String(b.id)));
  const participantById = new Map(participantSnapshot.docs.map((doc) => [doc.id, doc.data()]));
  const quantityReleased = (event.seedlingItems || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const summary = summarizeSubmissions(contributions, quantityReleased || data.quantityReleased);
  const species = (event.seedlingItems || []).map((item) => {
    const recorded = summary.submissions.filter((entry) => entry.inventoryId === item.inventoryId &&
      entry.staffReviewStatus !== "Rejected" && entry.verificationStatus !== "Invalid")
      .reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    const leftoverQuantity = summary.submissions.filter(entry => entry.inventoryId === item.inventoryId && entry.staffReviewStatus !== "Rejected" && entry.verificationStatus !== "Invalid")
      .reduce((sum, entry) => sum + Number(entry.leftoverQuantity || 0), 0);
    return {
      inventoryId: item.inventoryId,
      species: item.species,
      allocated: Number(item.quantity || 0),
      recorded,
      ...(data.officialPlantingWorkflow === true || leftoverQuantity > 0 ? { leftoverQuantity } : {}),
      // Active submissions above already include pending contributions. Their
      // reservation ledger must not be deducted a second time in this summary.
      remaining: Math.max(0, Number(item.quantity || 0) - recorded - leftoverQuantity),
    };
  });
  const evidence = contributions.flatMap((entry) => (entry.photos || []).map(photo =>
    photo.privateEvidence ? { ...photo, _evidenceRecordId: entry.id } : photo));
  const latestContribution = contributions[contributions.length - 1] || null;
  const primaryContribution = contributions.find((entry) => entry.participantType === "requester") ||
    contributions.find((entry) => entry.photos?.length) || latestContribution;
  const primaryPhoto = primaryContribution?.photos?.[0] || null;
  const suspiciousFlags = [...new Set(evidence.flatMap((photo) => photo.suspiciousFlags || []))];
  // A release with several seedling types is one report; never summarize it as its first species.
  const reportedSpecies = [...new Set(species.map((item) => String(item.species || "").trim()).filter(Boolean))];
  const multipleSpecies = species.length > 1;
  return {
    id, ...data,
    verificationStatus: summary.reportingProgress,
    photos: evidence,
    participantName: data.participantName || "",
    participantType: data.participantType || "",
    submittedByName: latestContribution?.submittedByName || latestContribution?.contributorName || "",
    submittedByType: latestContribution?.submittedBySector || latestContribution?.participantUserType || "",
    submissionCount: contributions.length,
    lastSubmittedAt: latestContribution?.recordedAt ?? null,
    // Submission progress and Staff review are separate: a saved submission is
    // "Submitted" while its review remains "Pending Review" until Staff decides.
    submissionStatus: contributions.length > 0 ? "Submitted" : "Awaiting Submission",
    reviewStatus: reviewStatusFor(summary.submissions, summary.reportingProgress),
    reviewStages: reviewStagesFor(summary.submissions),
    participantBarangay: primaryContribution?.participantBarangay || data.participantBarangay || data.barangay || "",
    organizationAffiliation: primaryContribution?.organizationAffiliation || data.organizationAffiliation || "",
    participantContactNumber: primaryContribution?.participantContactNumber || data.participantContactNumber || "",
    species: multipleSpecies && reportedSpecies.length ? reportedSpecies.join(", ") : primaryContribution?.species || data.species || "",
    plantingDate: primaryContribution?.plantingDate || data.plantingDate || data.eventDate || "",
    requestedQuantity: multipleSpecies ? data.requestedQuantity ?? null : primaryContribution?.requestedQuantity ?? data.requestedQuantity ?? null,
    releasedItemQuantity: multipleSpecies ? null : primaryContribution?.releasedQuantity ?? null,
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
    if (reportDoc.data().submittedAt) return;
    if (!["Draft", "Pending", "Pending Review", "Awaiting Submission", "Partial",
      "Fully Reported — Awaiting Review"].includes(reportDoc.data().reportingProgress ||
        reportDoc.data().verificationStatus)) {
      throw new Error("Only pending planting reports can be submitted for review.");
    }
    const eventDoc = await transaction.get(events.doc(reportDoc.data().eventId));
    const submissionSnapshot = await transaction.get(submissions.where("reportId", "==", id));
    const submitterSubmissions = submissionSnapshot.docs.filter((doc) =>
      doc.data().contributorId === requesterId || doc.data().participantId === requesterId);
    if (submitterSubmissions.length === 0) {
      throw new Error("Planting evidence photos are required before review.");
    }
    if (submitterSubmissions.some((doc) => !doc.data().photos?.length)) {
      throw new Error("Planting evidence photos are required before review.");
    }
    const recordedQuantity = submissionSnapshot.docs.reduce(
      (total, doc) => total + Number(doc.data().quantity || 0), 0);
    if (!eventDoc.exists || !eventDoc.data().allocationReleasedAt || recordedQuantity <= 0) {
      throw new Error("The report has no recorded planting contributions.");
    }
    const now = Timestamp.now();
    transaction.update(ref, {
      submittedAt: now,
      updatedAt: now,
    });
  });
  const doc = await ref.get();
  return reportDetails(doc.id, doc.data());
}

module.exports = { parentRef, parentForEventInTransaction, reportDetails, finalizeParent,
  normalizeSubmission, summarizeSubmissions, reviewStatusFor, reviewStagesFor, AWAITING_REMAINING_REPORT };
