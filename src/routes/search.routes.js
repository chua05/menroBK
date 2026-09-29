const router = require("express").Router();
const { searchLimiter } = require("../middleware/rateLimiter.middleware");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const controller = require("../controller/search.controller");

router.get("/", verifyToken, authorizeRoles("admin", "staff", "participant"), searchLimiter, controller.search);

module.exports = router;
