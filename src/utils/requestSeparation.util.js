function assertIndependentRequestAction(request, actorId) {
  if (actorId && (request?.participantId === actorId || request?.walkIn?.encodedBy === actorId)) {
    throw Object.assign(new Error("Another authorized MENRO officer must process your seedling request."), {
      status: 403, code: "REQUEST_SELF_PROCESSING_FORBIDDEN",
    });
  }
}
module.exports = { assertIndependentRequestAction };
