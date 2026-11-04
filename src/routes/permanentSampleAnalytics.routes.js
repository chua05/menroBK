const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { db } = require("../config/firebase");
const { resolveVerifiedPlantingCohortConfig } = require("../config/verifiedPlantingCohort");
const service = require("../services/permanentSampleAnalytics.service").createService({ db,
  enabled: () => resolveVerifiedPlantingCohortConfig().enabled && process.env.PERMANENT_SAMPLE_ANALYTICS_ENABLED === "true" });
router.get("/", verifyToken, authorizeRoles("staff", "admin"), async (req, res) => {
  try {
    const data = await service.get({ actorId: req.user.uid, actorRole: req.user.role, cohortId: req.query.cohortId, siteId: req.query.siteId });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Analytics are unavailable." });
  }
});
module.exports = router;
