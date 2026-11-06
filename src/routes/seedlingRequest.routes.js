const express = require("express");

const router = express.Router();

const {
  verifyToken,
} = require("../middleware/auth.middleware");

const {
  authorizeRoles,
} = require("../middleware/role.middleware");

const {
  getSeedlingRequestCapabilities,
  submitSeedlingRequest,
  getRequestLetter,
  getSeedlingRequests,
  getSeedlingRequest,
  getMySeedlingRequests,
  getRequestIdentification,
  markRequestReviewed,
  returnRequestForRevision,
  resubmitRequest,
  approveRequest,
  rejectRequest,
  releaseRequest,
  savePreApprovalSchedule,
  confirmPreApproval,
  createLateReleaseConflict,
  submitLateReleaseProposal,
  returnLateReleaseProposal,
  approveLateReleaseProposal,
} = require("../controller/seedlingRequest.controller");
const { parseRequestLetterSubmission } = require("../middleware/requestLetterUpload.middleware");

const walkIn = require("../controller/walkInRequest.controller");
const { uploadConcurrencyGuard } = require("../middleware/upload.middleware");
const { uploadLimiter } = require("../middleware/rateLimiter.middleware");
const { evidenceUploadMaintenanceGate } = require("../middleware/evidenceUploadMaintenance.middleware");
const walkInUpload = require("multer")({ storage: require("multer").memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 2, fields: 1, fieldSize: 100000 } }).fields([{ name: "acknowledgement", maxCount: 1 }, { name: "requestLetter", maxCount: 1 }]);
router.post("/walk-in", verifyToken, authorizeRoles("staff"), evidenceUploadMaintenanceGate, uploadLimiter, uploadConcurrencyGuard,
  (req, res, next) => walkInUpload(req, res, error => error ? res.status(400).json({ success: false, message: "Upload valid acknowledgement/request-letter files within the 10 MB limit." }) : next()), walkIn.submitWalkIn);
router.patch("/walk-in/:id/resubmit", verifyToken, authorizeRoles("staff"), evidenceUploadMaintenanceGate, uploadLimiter, uploadConcurrencyGuard,
  (req, res, next) => walkInUpload(req, res, error => error ? res.status(400).json({ success: false, message: "Upload valid signed acknowledgement files within the size limit." }) : next()), walkIn.resubmitWalkIn);
router.patch("/walk-in/:id/schedule", verifyToken, authorizeRoles("staff"), evidenceUploadMaintenanceGate, uploadLimiter, uploadConcurrencyGuard,
  (req, res, next) => walkInUpload(req, res, error => error ? res.status(400).json({ success: false, message: "Upload a signed acknowledgement within the size limit." }) : next()), walkIn.recordSchedule);
router.get("/:id/acknowledgement", verifyToken, authorizeRoles("staff", "admin"), walkIn.acknowledgement);

// Non-sensitive capability used to coordinate staggered frontend/backend releases.
router.get("/capabilities", verifyToken, authorizeRoles("participant", "staff"), getSeedlingRequestCapabilities);

// ========================================
// PARTICIPANT — SUBMIT REQUEST
// ========================================

router.post(
  "/",
  verifyToken,
  authorizeRoles("participant", "staff"),
  parseRequestLetterSubmission,
  submitSeedlingRequest
);

router.get("/:id/request-letter", verifyToken,
  authorizeRoles("admin", "staff", "participant"), getRequestLetter);

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
  authorizeRoles("participant", "staff"),
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

router.patch("/:id/pre-approval-schedule", verifyToken, authorizeRoles("staff"), savePreApprovalSchedule);
router.patch("/:id/pre-approval-schedule/confirm", verifyToken, authorizeRoles("participant", "staff"), confirmPreApproval);

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
  authorizeRoles("participant", "staff"),
  parseRequestLetterSubmission,
  resubmitRequest
);

// Admin-only intentional reveal. Ordinary request reads contain only masked
// identification metadata for Admin and no identification fields for Staff.
router.get(
  "/:id/identification",
  verifyToken,
  authorizeRoles("admin"),
  getRequestIdentification
);

// ========================================
// ADMIN — FINAL APPROVAL
//
// Reviewed -> Approved
//
// Optional request body: { "reason": "..." }
//
// Approval creates the scheduled Tree Planting event but does not change stock.
// Physical inventory is deducted only after a successful Staff release.
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
// Current stock is validated and the actual released quantities are deducted
// atomically with the Distribution and final Released request status.
// ========================================

router.patch(
  "/:id/release",
  verifyToken,
  authorizeRoles("staff"),
  releaseRequest
);

router.patch("/:id/late-release-conflict", verifyToken, authorizeRoles("staff"), createLateReleaseConflict);
router.patch("/:id/late-release-rescheduling/proposal", verifyToken, authorizeRoles("participant", "staff"), submitLateReleaseProposal);
router.patch("/:id/late-release-rescheduling/return", verifyToken, authorizeRoles("staff"), returnLateReleaseProposal);
router.patch("/:id/late-release-rescheduling/approve", verifyToken, authorizeRoles("staff"), approveLateReleaseProposal);

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
