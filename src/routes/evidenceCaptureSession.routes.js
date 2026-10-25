const express = require("express");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { uploadPlantingPhoto, uploadConcurrencyGuard } = require("../middleware/upload.middleware");
const { uploadLimiter } = require("../middleware/rateLimiter.middleware");
const { evidenceUploadMaintenanceGate } = require("../middleware/evidenceUploadMaintenance.middleware");
const controller = require("../controller/evidenceCaptureSession.controller");

const router = express.Router();
const guards = [verifyToken, authorizeRoles("participant"), evidenceUploadMaintenanceGate, uploadLimiter];
router.post("/", ...guards, controller.create);
router.post("/:sessionId/verify", ...guards, uploadConcurrencyGuard,
  uploadPlantingPhoto.single("photo"), controller.verify);

module.exports = router;
