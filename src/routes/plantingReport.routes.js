const express = require("express");

const router = express.Router();

const {
  submitPlantingReport,
  getPlantingReports,
  getPlantingReport,
  getMyPlantingReports,
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
} = require(
  "../middleware/upload.middleware"
);

// PARTICIPANT SUBMIT REPORT
router.post(
  "/",
  verifyToken,
  authorizeRoles("participant"),
  uploadPlantingPhoto.single(
    "photo"
  ),
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

// ADMIN AND STAFF VIEW BY ID
router.get(
  "/:id",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getPlantingReport
);

module.exports = router;