const express =
  require("express");

const router =
  express.Router();

const {
  getDistributions,
  getDistribution,
  getParticipantDistributions,
  getMyDistributions,
} = require(
  "../controller/distribution.controller"
);

const {
  verifyToken,
} = require(
  "../middleware/auth.middleware"
);

const {
  authorizeRoles,
} = require(
  "../middleware/role.middleware"
);


// GET ALL DISTRIBUTIONS
// ADMIN / STAFF
//
// Supports:
// ?species=Calamansi
// ?participantId=USER_UID
// ?requestId=REQUEST_ID
router.get(
  "/",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getDistributions
);


// GET CURRENT PARTICIPANT'S
// OWN RELEASED DISTRIBUTIONS
//
// IMPORTANT:
// Must be before "/:id".
router.get(
  "/my-distributions",
  verifyToken,
  authorizeRoles(
    "participant"
  ),
  getMyDistributions
);


// GET DISTRIBUTIONS
// OF A SPECIFIC PARTICIPANT
// ADMIN / STAFF
//
// IMPORTANT:
// Must also be before "/:id".
router.get(
  "/participant/:participantId",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getParticipantDistributions
);


// GET DISTRIBUTION BY ID
// ADMIN / STAFF
//
// Dynamic route should remain last.
router.get(
  "/:id",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getDistribution
);


module.exports = router;