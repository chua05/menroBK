function assertIndependentRequestAction(request, actorId) {
  if (request?.participantId && actorId && request.participantId === actorId) {
    throw Object.assign(new Error("Another authorized MENRO officer must process your seedling request."), {
      status: 403, code: "REQUEST_SELF_PROCESSING_FORBIDDEN",
    });
  }
}
module.exports = { assertIndependentRequestAction };
