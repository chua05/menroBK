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
  cancelEvent,
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

router.get("/:id/contributions/my", verifyToken, authorizeRoles("participant"), async (req, res) => {
  const participantId = guestService.registeredParticipantId(req.params.id, req.user.uid);
  const data = await contributionService.getOwnContributions(req.params.id, participantId);
  return sendSuccess(res, 200, "Contributions retrieved", data);
});

router.post("/:id/contributions", verifyToken, authorizeRoles("participant"), async (req, res) => {
  try {
    const participantId = guestService.registeredParticipantId(req.params.id, req.user.uid);
    const data = await contributionService.recordContribution(
      req.params.id, participantId, req.body?.inventoryId, req.body?.quantity
    );
    return sendSuccess(res, 201, "Contribution recorded", data);
  } catch (error) {
    if (error.message.startsWith("Only ") || error.message.includes("required") ||
        error.message.includes("not allocated") || error.message.includes("not been released") ||
        error.message === "Event participation not found.") {
      return sendError(res, 400, error.message);
    }
    console.error(error);
    return sendError(res, 500, "Failed to record contribution.");
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

// CANCEL EVENT
router.patch(
  "/:id/cancel",
  verifyToken,
  authorizeRoles("admin", "staff"),
  cancelEvent
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
