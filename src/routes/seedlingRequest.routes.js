const express = require("express");

const router = express.Router();

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

const {
  submitSeedlingRequest,
  getSeedlingRequests,
  getSeedlingRequest,
  getMySeedlingRequests,
  markRequestReviewed,
  approveRequest,
  rejectRequest,
  releaseRequest,
} = require(
  "../controller/seedlingRequest.controller"
);

// ========================================
// PARTICIPANT — SUBMIT REQUEST
// ========================================
router.post(
  "/",
  verifyToken,
  authorizeRoles(
    "participant"
  ),
  submitSeedlingRequest
);

// ========================================
// ADMIN / STAFF — VIEW ALL REQUESTS
// ========================================
router.get(
  "/",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getSeedlingRequests
);

// ========================================
// PARTICIPANT — VIEW OWN REQUESTS
//
// IMPORTANT:
// Keep this BEFORE "/:id"
// ========================================
router.get(
  "/my",
  verifyToken,
  authorizeRoles(
    "participant"
  ),
  getMySeedlingRequests
);

// ========================================
// STAFF — REVIEW REQUEST
// ========================================
router.patch(
  "/:id/review",
  verifyToken,
  authorizeRoles(
    "staff"
  ),
  markRequestReviewed
);

// ========================================
// ADMIN — FINAL APPROVAL
//
// Available inventory is deducted / reserved
// inside seedlingRequest.service.js.
// ========================================
router.patch(
  "/:id/approve",
  verifyToken,
  authorizeRoles(
    "admin"
  ),
  approveRequest
);

// ========================================
// ADMIN — REJECT REQUEST
// ========================================
router.patch(
  "/:id/reject",
  verifyToken,
  authorizeRoles(
    "admin"
  ),
  rejectRequest
);

// ========================================
// STAFF — RELEASE APPROVED REQUEST
//
// Reserved stock becomes distributed stock.
// Available stock must NOT be deducted again.
// ========================================
router.patch(
  "/:id/release",
  verifyToken,
  authorizeRoles(
    "staff"
  ),
  releaseRequest
);

// ========================================
// ADMIN / STAFF — VIEW ONE REQUEST
//
// Keep this after "/my".
// ========================================
router.get(
  "/:id",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getSeedlingRequest
);

module.exports = router;