const express = require("express");
const router = express.Router();

const { verifyToken } = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/authorize.middleware");

const {
  submitSeedlingRequest,
  getSeedlingRequests,
  getSeedlingRequest,
  getMySeedlingRequests,
  markRequestReviewed,
  approveRequest,
  rejectRequest,
  releaseRequest,
} = require("../controller/seedlingRequest.controller");

router.post(
  "/",
  verifyToken,
  authorizeRoles("participant"),
  submitSeedlingRequest
);

router.get(
  "/",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getSeedlingRequests
);

router.get(
  "/my",
  verifyToken,
  authorizeRoles("participant"),
  getMySeedlingRequests
);

router.get(
  "/:id",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getSeedlingRequest
);

router.patch(
  "/:id/review",
  verifyToken,
  authorizeRoles("staff"),
  markRequestReviewed
);

router.patch(
  "/:id/approve",
  verifyToken,
  authorizeRoles("admin"),
  approveRequest
);

router.patch(
  "/:id/reject",
  verifyToken,
  authorizeRoles("admin"),
  rejectRequest
);

router.patch(
  "/:id/release",
  verifyToken,
  authorizeRoles("staff"),
  releaseRequest
);

module.exports = router;