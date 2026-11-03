const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const {
  getPlantingEvidence,
  getMonitoringEvidence,
  getMonitoringRevisionEvidence,
  getCohortBaselineEvidence,
  getSampleMonitoringEvidence,
} = require("../controller/evidence.controller");

router.use(verifyToken);

router.get("/planting-reports/:reportId/photos/:photoIndex", getPlantingEvidence);
router.get("/monitoring/:recordId/photos/:entryIndex", getMonitoringEvidence);
router.get(
  "/monitoring/:monitoringId/observations/:observationId/revisions/:revisionNumber",
  getMonitoringRevisionEvidence
);
router.get("/verified-planting-cohorts/:cohortId/baseline/:sampleId/photos/:photoIndex", getCohortBaselineEvidence);
router.get("/sample-monitoring/visits/:visitId/samples/:sampleId/evidence/:evidenceIndex", getSampleMonitoringEvidence);

module.exports = router;
