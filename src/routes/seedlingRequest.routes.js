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
  returnRequestForRevision,
  resubmitRequest,
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
// Keep this BEFORE "/:id".
// ========================================

router.get(
  "/my",
  verifyToken,
  authorizeRoles("participant"),
  getMySeedlingRequests
);

// ========================================
// STAFF — REVIEW
//
// Pending -> Reviewed
// ========================================

router.patch(
  "/:id/review",
  verifyToken,
  authorizeRoles("staff"),
  markRequestReviewed
);

// Staff may return only a currently pending request for participant revision.
router.patch(
  "/:id/return",
  verifyToken,
  authorizeRoles("staff"),
  returnRequestForRevision
);

// Participant updates and resubmits the same returned request document.
router.patch(
  "/:id/resubmit",
  verifyToken,
  authorizeRoles("participant"),
  resubmitRequest
);

// ========================================
// ADMIN — FINAL APPROVAL
//
// Reviewed -> Approved
//
// Optional request body: { "reason": "..." }
//
// Approval:
// 1. Reserves all requested inventory
// 2. Creates the Tree Planting event
// 3. Event is immediately Scheduled
// ========================================

router.patch(
  "/:id/approve",
  verifyToken,
  authorizeRoles("admin"),
  approveRequest
);

// ========================================
// ADMIN — FINAL REJECTION
//
// Reviewed -> Rejected
//
// Request body:
// {
//   "reason": "..."
// }
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
//
// All reserved stock becomes distributed.
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
// Keep this AFTER "/my" and action routes.
// ========================================

router.get(
  "/:id",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff",
    "participant"
  ),
  getSeedlingRequest
);

module.exports = router;
