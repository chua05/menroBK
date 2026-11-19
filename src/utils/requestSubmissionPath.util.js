// Seedling request approval paths, derived only from the authenticated actor (req.user, whose role comes from
// the server-side user profile) and persisted creator metadata — never from client-supplied role fields.
//
// - Participant submission: status "Pending" (Pending Review) -> Staff review -> "Reviewed" (Awaiting Approval)
//   -> Admin approve/reject.
// - Staff submission (a Staff member's own request or a Staff-encoded walk-in for a citizen): status "Reviewed"
//   (Awaiting Approval) immediately, routed straight to the Admin. No Staff review happens, so no review ID,
//   reviewer or review date is recorded; reviewStatus is "Not Required". Admin remains the only final authority.
const STAFF_DIRECT_TO_ADMIN = "STAFF_DIRECT_TO_ADMIN";
const PARTICIPANT_STAFF_REVIEW = "PARTICIPANT_STAFF_REVIEW";
const STAFF_REVIEW_NOT_REQUIRED = "Not Required";

const clean = (value) => (typeof value === "string" ? value.trim() : "");

function isStaffActor(actor) {
  return Boolean(actor && clean(actor.uid) && actor.role === "staff");
}

// Fields recorded when an authenticated Staff member submits or resubmits a request.
function staffDirectSubmissionFields(actor, now) {
  return {
    status: "Reviewed",
    submissionPath: STAFF_DIRECT_TO_ADMIN,
    staffReviewRequired: false,
    reviewStatus: STAFF_REVIEW_NOT_REQUIRED,
    submittedByUid: clean(actor.uid),
    submittedByRole: "staff",
    submittedByName: clean(actor.fullName) || "MENRO Staff",
    routedToAdminAt: now,
  };
}

function participantSubmissionFields() {
  return { status: "Pending", submissionPath: PARTICIPANT_STAFF_REVIEW, staffReviewRequired: true };
}

const isStaffDirectRequest = (request) => request?.submissionPath === STAFF_DIRECT_TO_ADMIN;

// A request belongs to "My Requests" of the user who is its requester or who created/submitted it as Staff
// (including a Staff-encoded walk-in, whose requester is the citizen).
function isCreatedByUser(request, uid) {
  const id = clean(uid);
  return Boolean(id && (request?.participantId === id || request?.walkIn?.encodedBy === id || request?.submittedByUid === id));
}

module.exports = { PARTICIPANT_STAFF_REVIEW, STAFF_DIRECT_TO_ADMIN, STAFF_REVIEW_NOT_REQUIRED, isCreatedByUser, isStaffActor,
  isStaffDirectRequest, participantSubmissionFields, staffDirectSubmissionFields };
