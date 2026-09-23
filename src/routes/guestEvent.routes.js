const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { sendSuccess, sendError } = require("../utils/response.util");
const guest = require("../services/guestEvent.service");
const contributions = require("../services/plantingContribution.service");
const { attachEvidence } = require("../services/plantingEvidence.service");
const { uploadContributionEvidence } = require("../middleware/upload.middleware");

router.get("/invitation/:eventId", verifyToken, authorizeRoles("participant"), async (req, res) => {
  try {
    const invitation = await guest.getInvitationForRequester(req.params.eventId, req.user.uid);
    return sendSuccess(res, 200, "Guest invitation retrieved", invitation);
  } catch (error) {
    if (error.message === "Invitation not found.") return sendError(res, 404, error.message);
    console.error(error);
    return sendError(res, 500, "Failed to retrieve guest invitation.");
  }
});

router.get("/session", async (req, res) => {
  try {
    const session = await guest.getGuestSessionContext(req.headers.authorization);
    return sendSuccess(res, 200, "Guest session retrieved", session);
  } catch (error) {
    return sendError(res, 401, "Invalid guest session.");
  }
});

router.get("/session/contributions", async (req, res) => {
  let session;
  try {
    session = await guest.validateGuestSession(req.headers.authorization);
  } catch {
    return sendError(res, 401, "Invalid guest session.");
  }
  try {
    const data = await contributions.getOwnContributions(session.eventId, session.participantId);
    return sendSuccess(res, 200, "Contributions retrieved", data);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "Failed to retrieve contributions.");
  }
});

router.post("/session/contributions", async (req, res) => {
  let session;
  try {
    session = await guest.validateGuestSession(req.headers.authorization);
  } catch (error) {
    return sendError(res, 401, "Invalid guest session.");
  }
  try {
    const data = await contributions.recordContribution(
      session.eventId,
      session.participantId,
      req.body?.inventoryId,
      req.body?.quantity,
      req.body?.submissionKey
    );
    return sendSuccess(res, 201, "Contribution recorded", data);
  } catch (error) {
    if (error.message.startsWith("Only ") || error.message.includes("available planting quantity") ||
        error.message.includes("required") ||
        error.message.includes("not allocated") || error.message.includes("not been released") ||
        error.message.includes("submission key") || error.message.includes("finalized")) {
      return sendError(res, 400, error.message);
    }
    console.error(error);
    return sendError(res, 500, "Failed to record contribution.");
  }
});

router.post("/session/contributions/:id/evidence", async (req, res, next) => {
  try {
    req.guestSession = await guest.validateGuestSession(req.headers.authorization);
    return next();
  } catch {
    return sendError(res, 401, "Invalid guest session.");
  }
}, uploadContributionEvidence, async (req, res) => {
  try {
    const data = await attachEvidence(req.guestSession.eventId, req.guestSession.participantId,
      req.params.id, req.files, req.body, { optionalLocation: true });
    return sendSuccess(res, 200, "Planting evidence recorded", data);
  } catch (error) {
    const expected = /required|photos|image|contribution|accepting evidence|Duplicate|date|coordinates/i
      .test(error.message);
    if (!expected) console.error(error);
    return sendError(res, expected ? 400 : 500,
      expected ? error.message : "Failed to record planting evidence.");
  }
});

router.get("/:token", async (req, res) => {
  try {
    const { eventId, event } = await guest.validateInvitation(req.params.token);
    return sendSuccess(res, 200, "Guest event retrieved", await guest.publicEvent(eventId, event));
  } catch (error) {
    return sendError(res, 404, "Guest event not found.");
  }
});

router.post("/:token/join", async (req, res) => {
  try {
    const joined = await guest.joinGuest(req.params.token, req.body);
    return sendSuccess(res, 201, "Joined event", joined);
  } catch (error) {
    const message = error.message;
    if (message === "This contact number has already joined the event.") return sendError(res, 409, message);
    if (message.startsWith("A valid Philippine mobile number") || message.startsWith("Full name is required")) {
      return sendError(res, 400, message);
    }
    if (message === "Invalid guest invitation." || message === "Event not found.") {
      return sendError(res, 404, "Guest event not found.");
    }
    console.error(error);
    return sendError(res, 500, "Failed to join event.");
  }
});

module.exports = router;
