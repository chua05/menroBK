const service = require("../services/notification.service");
const { sendSuccess, sendError } = require("../utils/response.util");

async function getMyNotifications(req, res) {
  try {
    const readState = ["all", "unread", "read"].includes(req.query.readState)
      ? req.query.readState : "all";
    const result = await service.getMyNotifications(req.user.uid, {
      readState,
      cursor: req.query.cursor,
      limit: req.query.limit,
    });
    return sendSuccess(res, 200, "Notifications retrieved", result);
  } catch (error) {
    if (error.code === "INVALID_CURSOR") return sendError(res, 400, error.message);
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

async function markAllNotificationsRead(req, res) {
  try {
    const result = await service.markAllNotificationsRead(req.user.uid);
    return sendSuccess(res, 200, "All notifications marked as read", result);
  } catch (error) {
    console.error(error);
    const message = error.code === "MARK_ALL_PARTIAL_FAILURE"
      ? "Some notifications could not be marked as read. Please refresh and try again."
      : "Failed to mark all notifications as read.";
    return sendError(res, 500, message);
  }
}

module.exports = { getMyNotifications, markNotificationRead, markAllNotificationsRead };
