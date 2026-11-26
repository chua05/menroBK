const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { dashboard, mapTrees } = require("../controller/analytics.controller");

router.get("/dashboard", verifyToken, authorizeRoles("admin", "staff"), dashboard);
router.get("/map-trees", verifyToken, authorizeRoles("admin", "staff"), mapTrees);

module.exports = router;
