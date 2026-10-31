const express = require("express");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { getCohort, saveBaseline } = require("../controller/verifiedPlantingCohort.controller");

const router = express.Router();

router.get("/:id", verifyToken, authorizeRoles("staff"), getCohort);
router.put("/:id/baseline", verifyToken, authorizeRoles("staff"), saveBaseline);

module.exports = router;
