const service = require("../services/notification.service");
const { sendSuccess, sendError } = require("../utils/response.util");

async function getMyNotifications(req, res) {
  try {
    const notifications = await service.getMyNotifications(req.user.uid);
    return sendSuccess(res, 200, "Notifications retrieved", {
      notifications,
      unreadCount: notifications.filter((item) => !item.isRead).length,
    });
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "Failed to retrieve notifications.");
  }
}

async function markNotificationRead(req, res) {
  try {
    const notification = await service.markNotificationRead(req.params.id, req.user.uid);
    return sendSuccess(res, 200, "Notification marked as read", notification);
  } catch (error) {
    if (error.message === "Notification not found.") {
      return sendError(res, 404, error.message);
    }
    console.error(error);
    return sendError(res, 500, "Failed to mark notification as read.");
  }
}

module.exports = { getMyNotifications, markNotificationRead };
