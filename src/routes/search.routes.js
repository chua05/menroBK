const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const controller = require("../controller/search.controller");

router.get("/", verifyToken, authorizeRoles("admin", "staff", "participant"), controller.search);

module.exports = router;
