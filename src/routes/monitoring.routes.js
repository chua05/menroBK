const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const router =
  express.Router();

const {
  addMonitoringRecord,
  getMonitoringRecords,
  getMonitoringRecord,
  getMyMonitoringRecords,
  updateMonitoring,
  reviewMonitoring,
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

const monitoringUploadDir =
  path.join(
    process.cwd(),
    "uploads",
    "monitoring"
  );

fs.mkdirSync(
  monitoringUploadDir,
  {
    recursive: true,
  }
);

const storage =
  multer.diskStorage({
    destination: (
      req,
      file,
      callback
    ) => {
      callback(
        null,
        monitoringUploadDir
      );
    },

    filename: (
      req,
      file,
      callback
    ) => {
      const extension =
        path
          .extname(
            file.originalname
          )
          .toLowerCase() ||
        ".jpg";

      const uniqueName =
        `${Date.now()}-${crypto
          .randomBytes(8)
          .toString(
            "hex"
          )}${extension}`;

      callback(
        null,
        uniqueName
      );
    },
  });

const upload =
  multer({
    storage,

    limits: {
      fileSize:
        10 * 1024 * 1024,

      files: 1,
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
  "/",
  verifyToken,
  authorizeRoles(
    "participant"
  ),
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
  "/:id/review",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  reviewMonitoring
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