const express = require("express");

const router = express.Router();

const {
  verifyToken,
} = require("../middleware/auth.middleware");

const {
  authorizeRoles,
} = require("../middleware/role.middleware");

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

// ========================================
// PARTICIPANT — SUBMIT REQUEST
// ========================================

router.post(
  "/",
  verifyToken,
  authorizeRoles("participant"),
  submitSeedlingRequest
);

// ========================================
// ADMIN / STAFF — VIEW ALL REQUESTS
// ========================================

router.get(
  "/",
  verifyToken,
  authorizeRoles("admin", "staff"),
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
  authorizeRoles("participant"),
  getMySeedlingRequests
);

// ========================================
// STAFF — REVIEW PENDING REQUEST
//
// Pending -> Reviewed
// ========================================

router.patch(
  "/:id/review",
  verifyToken,
  authorizeRoles("staff"),
  markRequestReviewed
);

// ========================================
// ADMIN — FINAL APPROVAL
//
// Reviewed -> Approved
// Inventory stock is reserved/deducted here.
// ========================================

router.patch(
  "/:id/approve",
  verifyToken,
  authorizeRoles("admin"),
  approveRequest
);

// ========================================
// ADMIN — REJECT REVIEWED REQUEST
//
// Reviewed -> Rejected
// ========================================

router.patch(
  "/:id/reject",
  verifyToken,
  authorizeRoles("admin"),
  rejectRequest
);

// ========================================
// STAFF — RELEASE APPROVED REQUEST
//
// Approved -> Released
// Reserved stock becomes distributed stock.
// Available stock is NOT deducted again.
// ========================================

router.patch(
  "/:id/release",
  verifyToken,
  authorizeRoles("staff"),
  releaseRequest
);

// ========================================
// ADMIN / STAFF — VIEW ONE REQUEST
//
// IMPORTANT:
// Keep this AFTER "/my".
// ========================================

router.get(
  "/:id",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getSeedlingRequest
);

module.exports = router;