const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const {
  getPlantingEvidence,
  getMonitoringEvidence,
  getMonitoringRevisionEvidence,
} = require("../controller/evidence.controller");

router.use(verifyToken);

router.get("/planting-reports/:reportId/photos/:photoIndex", getPlantingEvidence);
router.get("/monitoring/:recordId/photos/:entryIndex", getMonitoringEvidence);
router.get(
  "/monitoring/:monitoringId/observations/:observationId/revisions/:revisionNumber",
  getMonitoringRevisionEvidence
);

module.exports = router;
