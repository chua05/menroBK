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