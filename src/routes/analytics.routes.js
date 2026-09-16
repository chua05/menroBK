const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { dashboard } = require("../controller/analytics.controller");

router.get("/dashboard", verifyToken, authorizeRoles("admin", "staff"), dashboard);

module.exports = router;
