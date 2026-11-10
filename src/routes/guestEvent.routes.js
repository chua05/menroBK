const router = require("express").Router();
router.use(require("../middleware/privateEvidenceResponse.middleware").privateEvidenceResponse);
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { sendSuccess, sendError } = require("../utils/response.util");
const guest = require("../services/guestEvent.service");
const contributions = require("../services/plantingContribution.service");
const { guestContributionLimiter } = require("../middleware/rateLimiter.middleware");

// Guest planting/photo contributions are replaced by attendance-only
// registration. Historical contributions stay readable; new ones are refused.
const RETIRED = "Guest planting and photo contributions have been replaced by attendance registration. Use the event link to register attendance.";
const retired = (_req, res) => sendError(res, 410, RETIRED);

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
    return sendError(res, 401, error.message === "Guest session expired."
      ? "Your guest session has expired. Please use a valid invitation link."
      : "Invalid guest session.");
  }
});

router.get("/session/contributions", async (req, res) => {
  let session;
  try {
    session = await guest.validateGuestSession(req.headers.authorization);
  } catch (error) {
    return sendError(res, 401, error.message === "Guest session expired."
      ? "Your guest session has expired. Please use a valid invitation link."
      : "Invalid guest session.");
  }
  try {
    const data = await contributions.getOwnContributions(session.eventId, session.participantId);
    return sendSuccess(res, 200, "Contributions retrieved", data);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "Failed to retrieve contributions.");
  }
});

router.post("/session/contributions", retired);
router.post("/session/contributions/:id/evidence", retired);

// Public event card for the attendance page (no allocation or balances).
router.get("/:token", async (req, res) => {
  try {
    const { eventId, event, state } = await guest.validateAttendanceInvitation(req.params.token);
    return sendSuccess(res, 200, "Guest event retrieved", await guest.attendanceEventView(eventId, event, state));
  } catch (error) {
    if ([404, 410].includes(error.status)) return sendError(res, error.status, error.message);
    console.error(error);
    return sendError(res, 500, "Failed to load the guest event.");
  }
});

// Attendance registration: Full Name, Contact Number and Address only.
router.post("/:token/attendance", guestContributionLimiter, async (req, res) => {
  try {
    const registered = await guest.registerAttendance(req.params.token, req.body);
    return sendSuccess(res, 201, "Attendance recorded", { eventId: registered.eventId, fullName: registered.fullName, registeredAt: registered.registeredAt });
  } catch (error) {
    if ([400, 404, 409, 410].includes(error.status)) {
      return res.status(error.status).json({ success: false, message: error.message, ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}) });
    }
    console.error(error);
    return sendError(res, 500, "Failed to record attendance.");
  }
});

// The guest session existed only for planting contributions.
router.post("/:token/join", retired);

module.exports = router;
