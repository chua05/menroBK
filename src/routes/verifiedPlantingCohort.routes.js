const express = require("express");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const {
  listCohorts, getCohort, saveSamplingPlan, approveSamplingPlan,
  saveBaseline, approveBaseline,
} = require("../controller/verifiedPlantingCohort.controller");

const router = express.Router();

router.get("/", verifyToken, authorizeRoles("staff", "admin"), listCohorts);
router.get("/:id", verifyToken, authorizeRoles("staff", "admin"), getCohort);
router.put("/:id/sampling-plan", verifyToken, authorizeRoles("staff"), saveSamplingPlan);
router.post("/:id/sampling-plan/approve", verifyToken, authorizeRoles("admin"), approveSamplingPlan);
router.put("/:id/baseline", verifyToken, authorizeRoles("staff"), saveBaseline);
router.post("/:id/baseline/approve", verifyToken, authorizeRoles("admin"), approveBaseline);

module.exports = router;
