const express = require("express");
const multer = require("multer");
const { uploadConcurrencyGuard, UPLOAD_FORM_LIMITS } = require("../middleware/upload.middleware");
const { uploadLimiter } = require("../middleware/rateLimiter.middleware");

const router =
  express.Router();

const {
  addMonitoringRecord,
  getMonitoringRecords,
  addEarlyMonitoringRecord,
  getMonitoringRecord,
  getMyMonitoringRecords,
  updateMonitoring,
  reviewMonitoring,
  returnMonitoring,
  resubmitMonitoring,
  approveMonitoring,
  rejectMonitoring,
  archiveMonitoring,
} = require(
  "../controller/monitoring.controller"
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

// ========================================
// MONITORING PHOTO STORAGE
// ========================================

const upload =
  multer({
    storage: multer.memoryStorage(),

    limits: {
      ...UPLOAD_FORM_LIMITS,
      fileSize:
        10 * 1024 * 1024,

      files: 1,
      parts: 101,
    },

    fileFilter: (
      req,
      file,
      callback
    ) => {
      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp",
      ];

      if (
        !allowedTypes.includes(
          file.mimetype
        )
      ) {
        return callback(
          new Error(
            "Only JPEG, PNG, and WEBP images are allowed."
          )
        );
      }

      return callback(
        null,
        true
      );
    },
  });

// ========================================
// PARTICIPANT CREATE MONITORING RECORD
// ========================================
router.post(
  "/early",
  verifyToken,
  authorizeRoles("participant"),
  uploadLimiter,
  uploadConcurrencyGuard,
  upload.single("photo"),
  addEarlyMonitoringRecord
);

router.post(
  "/",
  verifyToken,
  authorizeRoles(
    "participant"
  ),
  uploadLimiter,
  uploadConcurrencyGuard,
  upload.single("photo"),
  addMonitoringRecord
);

// ========================================
// PARTICIPANT VIEW OWN RECORDS
//
// IMPORTANT:
// Keep this BEFORE /:id
// ========================================
router.get(
  "/my-records",
  verifyToken,
  authorizeRoles(
    "participant"
  ),
  getMyMonitoringRecords
);

// ========================================
// ADMIN / STAFF VIEW ALL
// ========================================
router.get(
  "/",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getMonitoringRecords
);

// ========================================
// ADMIN / STAFF REVIEW RECORD
// ========================================
router.patch(
  "/:monitoringId/observations/:observationId/review",
  verifyToken,
  authorizeRoles("staff"),
  reviewMonitoring
);

router.patch(
  "/:monitoringId/observations/:observationId/return",
  verifyToken,
  authorizeRoles("staff"),
  returnMonitoring
);

router.patch(
  "/:monitoringId/observations/:observationId/resubmit",
  verifyToken,
  authorizeRoles("participant"),
  uploadLimiter,
  uploadConcurrencyGuard,
  upload.single("photo"),
  resubmitMonitoring
);

router.patch(
  "/:monitoringId/observations/:observationId/approve",
  verifyToken,
  authorizeRoles("admin"),
  approveMonitoring
);

router.patch(
  "/:monitoringId/observations/:observationId/reject",
  verifyToken,
  authorizeRoles("admin"),
  rejectMonitoring
);

// ========================================
// ADMIN / STAFF ARCHIVE RECORD
// ========================================
router.patch(
  "/:id/archive",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  archiveMonitoring
);

// ========================================
// STAFF UPDATE RECORD
// ========================================
router.patch(
  "/:id",
  verifyToken,
  authorizeRoles(
    "staff"
  ),
  updateMonitoring
);

// ========================================
// ADMIN / STAFF VIEW ONE RECORD
// ========================================
router.get(
  "/:id",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getMonitoringRecord
);

module.exports = router;
