const express = require("express");

const router = express.Router();
router.use(require("../middleware/privateEvidenceResponse.middleware").privateEvidenceResponse);

const {
  submitPlantingReport,
  getPlantingReports,
  getPlantingReport,
  getMyPlantingReports,
  finalizeReport,
  approveReport,
  rejectReport,
  getVerificationLogs,
} = require(
  "../controller/plantingReport.controller"
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

const {
  uploadPlantingPhoto,
  uploadConcurrencyGuard,
  validateAggregateUploadSize,
} = require(
  "../middleware/upload.middleware"
);
const { uploadLimiter } = require("../middleware/rateLimiter.middleware");
const {
  evidenceUploadMaintenanceGate,
} = require("../middleware/evidenceUploadMaintenance.middleware");


// --------------------------------
// PLANTING EVIDENCE UPLOAD
//
// New field:
// photos = 1 to 10 evidence photos
//
// Legacy field:
// photo = old single-photo frontend
//
// Both are temporarily accepted so
// the current frontend will not break
// before PlantingPage.jsx is updated.
// --------------------------------
const plantingEvidenceUpload =
  uploadPlantingPhoto.fields([
    {
      name: "photos",
      maxCount: 10,
    },
    {
      name: "photo",
      maxCount: 1,
    },
  ]);


// HANDLE MULTER ERRORS
const handlePlantingEvidenceUpload = (
  req,
  res,
  next
) => {
  plantingEvidenceUpload(
    req,
    res,
    (error) => {
      if (!error) {
        try {
          validateAggregateUploadSize(req.files);
          return next();
        } catch (aggregateError) {
          error = aggregateError;
        }
      }

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Each planting evidence photo must not exceed 10 MB.",
        });
      }

      if (
        error.code ===
        "LIMIT_UNEXPECTED_FILE"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "A maximum of 10 planting evidence photos is allowed.",
        });
      }

      if (error.code === "LIMIT_AGGREGATE_FILE_SIZE") {
        return res.status(400).json({ success: false, message: error.message });
      }

      return res.status(400).json({
        success: false,
        message:
          error.message ||
          "Failed to process the planting evidence photos.",
      });
    }
  );
};


// Official MENRO documentation is independent of optional requester photos.
const official = require("../controller/officialPlantingReport.controller");
router.get("/official/options", verifyToken, authorizeRoles("staff"), official.listOptions);
router.post("/official", verifyToken, authorizeRoles("staff"), official.submit);
router.put("/official/:id/photos", verifyToken, authorizeRoles("staff"), evidenceUploadMaintenanceGate, uploadLimiter, uploadConcurrencyGuard,
  (req, res, next) => require("../services/evidenceWorkflow.service").enabled() ? next() : res.status(503).json({ success: false, message: "Private planting evidence storage is unavailable." }),
  handlePlantingEvidenceUpload, official.uploadPhotos);
const attendanceUpload = require("multer")({ storage: require("multer").memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 } }).single("attendance");
router.put("/official/:id/attendance", verifyToken, authorizeRoles("staff"), evidenceUploadMaintenanceGate, uploadLimiter, uploadConcurrencyGuard,
  (req, res, next) => attendanceUpload(req, res, error => error
    ? res.status(400).json({ success: false, message: "Upload one attendance PDF, JPEG or PNG file not larger than 10 MB.", fieldErrors: { attendance: "Upload one attendance PDF, JPEG or PNG file not larger than 10 MB." } }) : next()), official.uploadAttendance);
router.get("/official/:id/attendance", verifyToken, authorizeRoles("staff", "admin"), official.downloadAttendance);
router.put("/submissions/:id/attendance", verifyToken, authorizeRoles("participant"), evidenceUploadMaintenanceGate, uploadLimiter, uploadConcurrencyGuard,
  (req, res, next) => attendanceUpload(req, res, error => error ? res.status(400).json({ success: false, message: "Upload one valid attendance PDF, JPEG or PNG up to 10 MB.", fieldErrors: { attendance: "Upload one valid attendance PDF, JPEG or PNG up to 10 MB." } }) : next()), official.uploadParticipantAttendance);
router.get("/submissions/:id/attendance", verifyToken, authorizeRoles("participant", "staff", "admin"), official.downloadParticipantAttendance);

// PARTICIPANT SUBMIT REPORT
router.post(
  "/",
  verifyToken,
  authorizeRoles("participant"),
  evidenceUploadMaintenanceGate,
  uploadLimiter,
  uploadConcurrencyGuard,
  handlePlantingEvidenceUpload,
  submitPlantingReport
);


// PARTICIPANT VIEW OWN REPORTS
router.get(
  "/my-reports",
  verifyToken,
  authorizeRoles("participant"),
  getMyPlantingReports
);


// ADMIN AND STAFF VIEW ALL
router.get(
  "/",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getPlantingReports
);


// ADMIN AND STAFF VIEW ANY REPORT; PARTICIPANTS VIEW THEIR OWN
router.get(
  "/:id",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff",
    "participant"
  ),
  getPlantingReport
);

// STAFF FINAL APPROVAL
router.patch("/:id/finalize", verifyToken, authorizeRoles("participant"), finalizeReport);

// STAFF / ADMIN FINAL APPROVAL
router.patch(
  "/:id/approve",
  verifyToken,
  authorizeRoles("staff", "admin"),
  approveReport
);

// STAFF / ADMIN FINAL REJECTION
router.patch(
  "/:id/reject",
  verifyToken,
  authorizeRoles("staff", "admin"),
  rejectReport
);


// ADMIN AND STAFF VIEW
// VERIFICATION HISTORY
router.get(
  "/:id/verification-logs",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getVerificationLogs
);


module.exports = router;
