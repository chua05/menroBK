const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const controller = require("../controller/notification.controller");

router.get("/", verifyToken, controller.getMyNotifications);
router.patch("/:id/read", verifyToken, controller.markNotificationRead);

module.exports = router;
