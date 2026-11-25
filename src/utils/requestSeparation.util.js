// Review, return, approval, rejection and schedule decisions: never the requester or the Staff encoder of a walk-in.
function assertIndependentRequestAction(request, actorId) {
  if (actorId && (request?.participantId === actorId || request?.walkIn?.encodedBy === actorId)) {
    throw Object.assign(new Error("Another authorized MENRO officer must process your seedling request."), {
      status: 403, code: "REQUEST_SELF_PROCESSING_FORBIDDEN",
    });
  }
}
// Release of an already Admin-approved request is fulfilment, not approval: the Staff encoder of a walk-in may do it, but
// never the requester, and never an officer who both encoded and approved the same request.
function assertReleaseAction(request, actorId) {
  if (!actorId || request?.participantId === actorId || (request?.walkIn?.encodedBy === actorId && request?.approvedBy === actorId)) {
    throw Object.assign(new Error("Another authorized MENRO officer must release these seedlings."), {
      status: 403, code: "REQUEST_SELF_PROCESSING_FORBIDDEN",
    });
  }
}
module.exports = { assertIndependentRequestAction, assertReleaseAction };
