const express = require("express");

const router = express.Router();

const {
  createEvent,
  getAllEvents,
  getArchivedEvents,
  getEventById,
  updateEvent,
  updateRecordStatus,
  markEventCompleted,
  archiveEvent,
  restoreEvent,
  deleteEvent,
} = require("../controller/event.controller");

const {
  verifyToken,
} = require("../middleware/auth.middleware");

const {
  authorizeRoles,
} = require("../middleware/role.middleware");
const guestService = require("../services/guestEvent.service");
const contributionService = require("../services/plantingContribution.service");
const { sendSuccess, sendError } = require("../utils/response.util");

// Logged-in attendee planting/photo contributions are retired (decision C6);
// historical contributions stay readable.
const retiredContribution = (_req, res) => sendError(res, 410,
  "Attendee planting and photo contributions have been retired. Submit the event's final planting report instead.");

router.post("/:id/join", verifyToken, authorizeRoles("participant"), async (req, res) => {
  try {
    const data = await guestService.joinRegistered(req.params.id, req.user);
    return sendSuccess(res, 200, "Joined event", data);
  } catch (error) {
    if (error.message === "Event not found.") return sendError(res, 404, error.message);
    console.error(error);
    return sendError(res, 500, "Failed to join event.");
  }
});

router.get("/:id/participants", verifyToken, authorizeRoles("staff", "admin"), async (req, res) => {
  try {
    const data = await guestService.getEventParticipants(req.params.id);
    return sendSuccess(res, 200, "Event participants retrieved", data);
  } catch (error) {
    if (error.message === "Event not found.") return sendError(res, 404, error.message);
    console.error(error);
    return sendError(res, 500, "Failed to retrieve event participants.");
  }
});

router.get("/:id/contributions/my", verifyToken, authorizeRoles("participant"), async (req, res) => {
  const participantId = guestService.registeredParticipantId(req.params.id, req.user.uid);
  const data = await contributionService.getOwnContributions(req.params.id, participantId);
  return sendSuccess(res, 200, "Contributions retrieved", data);
});

router.post("/:id/contributions", verifyToken, authorizeRoles("participant"), retiredContribution);
router.post("/:id/contributions/:contributionId/evidence", verifyToken, authorizeRoles("participant"), retiredContribution);

// Event attendance: the event's requester, MENRO Staff and Admin only (checked in the service).
router.get("/:id/attendance", verifyToken, authorizeRoles("participant", "staff", "admin"), async (req, res) => {
  try {
    const data = await guestService.listEventAttendance(req.params.id, req.user);
    res.set("Cache-Control", "private, no-store");
    return sendSuccess(res, 200, "Event attendance retrieved", data);
  } catch (error) {
    if ([403, 404].includes(error.status)) return sendError(res, error.status, error.message);
    console.error(error);
    return sendError(res, 500, "Failed to retrieve event attendance.");
  }
});

// Legacy seedling reservations (decision C3): Staff/Admin review and release.
router.get("/:id/reservations", verifyToken, authorizeRoles("staff", "admin"), async (req, res) => {
  try {
    return sendSuccess(res, 200, "Legacy reservations retrieved", await contributionService.listLegacyReservations(req.params.id));
  } catch (error) {
    if (error.status === 404) return sendError(res, 404, error.message);
    console.error(error);
    return sendError(res, 500, "Failed to retrieve reservations.");
  }
});

router.post("/:id/reservations/:contributionId/release", verifyToken, authorizeRoles("staff", "admin"), async (req, res) => {
  try {
    const data = await contributionService.releaseLegacyReservation(req.params.id, req.params.contributionId, req.user, req.body?.reason);
    return sendSuccess(res, 200, "Reservation released", data);
  } catch (error) {
    if ([400, 401, 403, 404, 409].includes(error.status)) {
      return res.status(error.status).json({ success: false, message: error.message, ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}) });
    }
    console.error(error);
    return sendError(res, 500, "Failed to release the reservation.");
  }
});

// GET ALL ACTIVE EVENTS
// Participant, staff, and admin may view events.
router.get(
  "/",
  verifyToken,
  getAllEvents
);

// GET ARCHIVED EVENTS
// Only staff/admin need archive management.
router.get(
  "/archived",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getArchivedEvents
);

// CREATE EVENT
router.post(
  "/",
  verifyToken,
  authorizeRoles("admin", "staff"),
  createEvent
);

// UPDATE EVENT RECORD STATUS
// Final workflow status control is restricted to admin.
router.patch(
  "/:id/record-status",
  verifyToken,
  authorizeRoles("admin"),
  updateRecordStatus
);

// MARK EVENT COMPLETED
router.patch(
  "/:id/complete",
  verifyToken,
  authorizeRoles("admin", "staff"),
  markEventCompleted
);

// ARCHIVE EVENT
router.patch(
  "/:id/archive",
  verifyToken,
  authorizeRoles("admin", "staff"),
  archiveEvent
);

// RESTORE EVENT
router.patch(
  "/:id/restore",
  verifyToken,
  authorizeRoles("admin", "staff"),
  restoreEvent
);

// UPDATE EVENT
router.put(
  "/:id",
  verifyToken,
  authorizeRoles("admin", "staff"),
  updateEvent
);

// DELETE EVENT
router.delete(
  "/:id",
  verifyToken,
  authorizeRoles("admin", "staff"),
  deleteEvent
);

// GET EVENT BY ID
// Keep this below /archived and the action routes.
router.get(
  "/:id",
  verifyToken,
  getEventById
);

module.exports = router;
