const express = require("express");

const router = express.Router();

const {
  getDistributions,
  getDistribution,
  getParticipantDistributions,
} = require("../controller/distribution.controller");

const {
  verifyToken,
} = require("../middleware/auth.middleware");

const {
  authorizeRoles,
} = require("../middleware/role.middleware");

// GET ALL DISTRIBUTIONS
// Supports:
// ?species=Calamansi
// ?participantId=USER_UID
// ?requestId=REQUEST_ID
router.get(
  "/",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getDistributions
);

// GET DISTRIBUTIONS BY PARTICIPANT
// Must be placed before "/:id".
router.get(
  "/participant/:participantId",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getParticipantDistributions
);

// GET DISTRIBUTION BY ID
router.get(
  "/:id",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getDistribution
);

module.exports = router;