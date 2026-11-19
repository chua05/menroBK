// One-request historical correction: routes a Staff-encoded walk-in that was stored "Pending" before the
// Staff direct-to-Admin workflow existed (production: REQ-2026-054) to Admin approval, exactly as a new Staff
// submission would be stored. Firestore is injected (Cloud Shell ADC tool or emulator); this module never loads
// src/config/firebase.js.
//
// Writes ONLY routing/audit fields on the one request document:
//   status "Pending" -> "Reviewed" (Awaiting Approval), submissionPath, staffReviewRequired, reviewStatus
//   "Not Required", submittedByUid/Role/Name (from the persisted encoder), routedToAdminAt, requestVersion+1,
//   updatedAt, historicalCorrection, and one appended reviewHistory "routed_to_admin_approval" entry.
// Never touches the citizen requester, items/quantities, schedule, event proposal/linkage, walk-in record,
// identification, inventory, events or any other request, and never records a Staff review.
const crypto = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { STAFF_DIRECT_TO_ADMIN, STAFF_REVIEW_NOT_REQUIRED } = require("../utils/requestSubmissionPath.util");

const CORRECTION_TYPE = "HISTORICAL_STAFF_SUBMISSION_ROUTED_TO_ADMIN";
const REQUEST_NUMBER = /^REQ-\d{4}-\d{3,}$/;
const clean = (value) => (typeof value === "string" ? value.trim() : "");
const dateOnly = (value) => clean(value).slice(0, 10);
const todayInManila = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

class CorrectionStop extends Error {
  constructor(step, message, details = {}) { super(`[${step}] ${message}`); this.step = step; this.details = details; }
}

// Read-only assessment of one request. Returns blockers (any => no write) and the exact fields a correction writes.
function assess(id, request, encoderProfile, now) {
  const blockers = [];
  const history = Array.isArray(request.reviewHistory) ? request.reviewHistory : [];
  const submitted = history.find((entry) => entry?.action === "submitted") || null;
  const encodedBy = clean(request.walkIn?.encodedBy);
  const alreadyCorrected = request.status === "Reviewed" && request.submissionPath === STAFF_DIRECT_TO_ADMIN && request.historicalCorrection?.type === CORRECTION_TYPE;
  if (alreadyCorrected) return { state: "ALREADY_CORRECTED", blockers: [], encodedBy };

  if (request.status !== "Pending") blockers.push(`STATUS_${clean(request.status).toUpperCase() || "MISSING"}`);
  if (request.archived === true) blockers.push("ARCHIVED");
  if (request.submissionPath) blockers.push("SUBMISSION_PATH_ALREADY_SET");
  // Trusted Staff creator: persisted at submission by the authenticated walk-in endpoint.
  if (!encodedBy) blockers.push("NO_PERSISTED_STAFF_ENCODER");
  if (request.createdByRole !== "staff" || request.requesterRole !== "walk-in") blockers.push("NOT_A_STAFF_ENCODED_WALK_IN");
  if (!submitted || submitted.actorId !== encodedBy || submitted.actorRole !== "staff" || submitted.actionBasis !== "STAFF_ENCODED_WALK_IN") blockers.push("SUBMISSION_AUDIT_MISMATCH");
  if (clean(request.participantId) === encodedBy) blockers.push("REQUESTER_IS_ENCODER");
  // A genuine Staff review would already have routed it; never overwrite or invent one.
  if (request.reviewId || request.reviewedBy || request.reviewedByUid || request.reviewedByName || request.reviewedAt || history.some((entry) => entry?.action === "reviewed")) blockers.push("STAFF_REVIEW_ALREADY_RECORDED");
  if (request.preApprovalSchedule?.status === "AwaitingRequesterConfirmation") blockers.push("SCHEDULE_CONFIRMATION_PENDING");
  if (request.eventId || request.eventCreated === true) blockers.push("EVENT_ALREADY_LINKED");
  if (request.inventoryReserved === true || request.inventoryDeducted === true || request.inventoryReleased === true) blockers.push("INVENTORY_ALREADY_AFFECTED");
  if (!Number.isSafeInteger(request.requestVersion) || request.requestVersion < 0) blockers.push("INVALID_REQUEST_VERSION");
  // Approval requires a future schedule; a past one would strand the request in Awaiting Approval.
  const plantingDate = dateOnly(request.preApprovalSchedule?.status === "Confirmed" ? request.preApprovalSchedule.plantingDate : request.eventProposal?.proposedDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plantingDate) || plantingDate <= todayInManila(now)) blockers.push("SCHEDULE_NOT_IN_FUTURE");
  if (!encoderProfile) blockers.push("ENCODER_PROFILE_NOT_FOUND");

  const workflow = request.workflow || {};
  const notes = [];
  if (workflow.siteMode === "proposed" && !workflow.officialSiteId && !request.proposedSiteVerification) notes.push("ADMIN_MUST_VERIFY_PROPOSED_SITE_AT_APPROVAL");
  if (encoderProfile && encoderProfile.role !== "staff") notes.push(`ENCODER_CURRENT_ROLE_${clean(encoderProfile.role).toUpperCase() || "UNKNOWN"}`);
  return { state: blockers.length ? "BLOCKED" : "CORRECTABLE", blockers, notes, encodedBy, plantingDate,
    submittedByName: clean(request.walkIn?.encodedByName) || clean(submitted?.actorName) || "MENRO Staff" };
}

function digestOf(id, request, assessment) {
  const reviewed = { id, requestNumber: request.requestNumber, status: request.status, requestVersion: request.requestVersion, participantId: request.participantId,
    encodedBy: assessment.encodedBy, state: assessment.state, blockers: assessment.blockers, historyLength: (request.reviewHistory || []).length,
    totalQuantity: request.totalQuantity, plantingDate: assessment.plantingDate || null };
  return crypto.createHash("sha256").update(JSON.stringify(reviewed)).digest("hex").slice(0, 16);
}

// Fields compared before/after to prove only routing/audit fields changed.
const PRESERVED_FIELDS = ["participantId", "participantName", "contactNumber", "organization", "requesterRole", "createdByRole", "requestNumber", "items", "totalQuantity",
  "purpose", "plantingLocation", "preferredReleaseDate", "eventProposal", "eventId", "eventCreated", "walkIn", "workflow", "originalSchedule", "preApprovalSchedule",
  "scheduleHistory", "inventoryReserved", "inventoryDeducted", "inventoryReleased", "reviewId", "reviewedBy", "reviewedByUid", "reviewedByName", "reviewedAt", "createdAt"];
const pick = (record) => JSON.stringify(PRESERVED_FIELDS.map((field) => [field, record?.[field] ?? null]));

function createHistoricalStaffRequestCorrection({ db, requestNumber, operator, now = () => Timestamp.now() }) {
  if (!REQUEST_NUMBER.test(clean(requestNumber))) throw new CorrectionStop("target", "A single exact request number is required.");
  if (!clean(operator)) throw new CorrectionStop("operator", "The verified operator identity is required for the audit entry.");
  const requests = db.collection("seedlingRequests");

  async function locate(reader) {
    const matches = await reader.get(requests.where("requestNumber", "==", requestNumber).limit(2));
    if (matches.docs.length !== 1) throw new CorrectionStop("target", `Expected exactly one request numbered ${requestNumber}; found ${matches.docs.length}.`);
    return matches.docs[0];
  }

  async function read(transaction) {
    const doc = await locate(transaction);
    const request = (await transaction.get(requests.doc(doc.id))).data();
    const encoderId = clean(request.walkIn?.encodedBy);
    const encoder = encoderId ? await transaction.get(db.collection("users").doc(encoderId)) : null;
    const assessment = assess(doc.id, request, encoder?.exists ? encoder.data() : null, now().toDate());
    return { id: doc.id, request, assessment, digest: digestOf(doc.id, request, assessment) };
  }

  async function dryRun() {
    const { id, request, assessment, digest } = await db.runTransaction(read, { readOnly: true });
    return { mode: "dry-run", readOnly: true, requestId: id, requestNumber, planDigest: digest, state: assessment.state, blockers: assessment.blockers, notes: assessment.notes || [],
      current: { status: request.status, requestVersion: request.requestVersion, submissionPath: request.submissionPath || null, reviewStatus: request.reviewStatus || null,
        encodedBy: assessment.encodedBy || null, participantName: request.participantName || null, requesterRole: request.requesterRole || null, createdByRole: request.createdByRole || null,
        plantingDate: assessment.plantingDate || null, totalQuantity: request.totalQuantity ?? null, reviewHistoryLength: (request.reviewHistory || []).length },
      writeScope: assessment.state === "CORRECTABLE" ? {
        document: `seedlingRequests/${id}`, status: "Pending -> Reviewed (Awaiting Approval)", submissionPath: STAFF_DIRECT_TO_ADMIN, staffReviewRequired: false,
        reviewStatus: STAFF_REVIEW_NOT_REQUIRED, submittedByUid: assessment.encodedBy, submittedByRole: "staff", submittedByName: assessment.submittedByName,
        requestVersion: `${request.requestVersion} -> ${request.requestVersion + 1}`, appendedHistory: "routed_to_admin_approval", otherDocumentsWritten: 0,
      } : null };
  }

  async function execute({ confirmRequestId, confirmPlanDigest, reason }) {
    const why = clean(reason);
    if (why.length < 10 || why.length > 300) throw new CorrectionStop("reason", "Provide a correction reason of 10 to 300 characters.");
    const result = await db.runTransaction(async (transaction) => {
      const { id, request, assessment, digest } = await read(transaction);
      if (id !== confirmRequestId) throw new CorrectionStop("confirmation", "The confirmed request ID does not match the located request.");
      if (assessment.state === "ALREADY_CORRECTED") return { status: "NO_CHANGE", requestId: id, before: request };
      if (assessment.state !== "CORRECTABLE") throw new CorrectionStop("preconditions", `Not correctable: ${assessment.blockers.join(", ")}.`, { blockers: assessment.blockers });
      if (digest !== confirmPlanDigest) throw new CorrectionStop("confirmation", "The request changed since the reviewed dry run. Re-run the dry run and confirm its new digest.", { planDigest: digest });
      const timestamp = now();
      const nextVersion = request.requestVersion + 1;
      transaction.update(requests.doc(id), {
        status: "Reviewed",
        submissionPath: STAFF_DIRECT_TO_ADMIN,
        staffReviewRequired: false,
        reviewStatus: STAFF_REVIEW_NOT_REQUIRED,
        submittedByUid: assessment.encodedBy,
        submittedByRole: "staff",
        submittedByName: assessment.submittedByName,
        routedToAdminAt: timestamp,
        requestVersion: nextVersion,
        updatedAt: timestamp,
        historicalCorrection: { type: CORRECTION_TYPE, correctedAt: timestamp, correctedBy: operator, reason: why, previousStatus: "Pending", previousRequestVersion: request.requestVersion },
        reviewHistory: [...(request.reviewHistory || []), { action: "routed_to_admin_approval", actorId: operator, actorRole: "operator", actionBasis: CORRECTION_TYPE,
          reason: why, previousStatus: "Pending", routedTo: "ADMIN_APPROVAL", requestVersion: nextVersion, at: timestamp }],
      });
      return { status: "CORRECTED", requestId: id, before: request, requestVersion: nextVersion };
    });
    const after = (await db.runTransaction((transaction) => transaction.get(requests.doc(result.requestId)), { readOnly: true })).data();
    return { ...result, before: undefined, postVerification: verify(result.before, after) };
  }

  return { dryRun, execute };
}

// Before/after proof: routing state is correct, preserved fields are byte-identical, no review was recorded.
function verify(before, after) {
  const problems = [];
  if (after.status !== "Reviewed" || after.submissionPath !== STAFF_DIRECT_TO_ADMIN || after.reviewStatus !== STAFF_REVIEW_NOT_REQUIRED) problems.push("ROUTING_STATE");
  if (after.submittedByUid !== clean(after.walkIn?.encodedBy)) problems.push("SUBMITTER");
  if (pick(before) !== pick(after)) problems.push("PRESERVED_FIELDS_CHANGED");
  if (after.reviewId || after.reviewedBy || after.reviewedByUid || after.reviewedByName || after.reviewedAt || (after.reviewHistory || []).some((entry) => entry?.action === "reviewed")) problems.push("STAFF_REVIEW_PRESENT");
  if ((after.reviewHistory || []).length !== (before.reviewHistory || []).length + (after.historicalCorrection?.type === CORRECTION_TYPE && before.status === "Pending" ? 1 : 0)) problems.push("HISTORY_LENGTH");
  return { ok: problems.length === 0, problems, status: after.status, requestVersion: after.requestVersion, submittedByUid: after.submittedByUid };
}

module.exports = { CORRECTION_TYPE, CorrectionStop, PRESERVED_FIELDS, assess, createHistoricalStaffRequestCorrection, verify };
