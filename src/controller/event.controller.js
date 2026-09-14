const eventService = require("../services/event.service");

const {
  sendSuccess,
  sendError,
} = require("../utils/response.util");

function getErrorStatus(error) {
  const message = String(
    error?.message || ""
  ).toLowerCase();

  if (
    message.includes("not found")
  ) {
    return 404;
  }

  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("must") ||
    message.includes("does not belong") ||
    message.includes("not active")
  ) {
    return 400;
  }

  return 500;
}

// CREATE EVENT
const createEvent = async (req, res) => {
  try {
    const event =
      await eventService.createEvent({
        ...req.body,
        createdBy: req.user.uid,
      });

    return sendSuccess(
      res,
      201,
      "Event created successfully",
      event
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      getErrorStatus(error),
      error.message
    );
  }
};

// GET ALL ACTIVE EVENTS
const getAllEvents = async (req, res) => {
  try {
    const events =
      await eventService.getAllEvents();

    return sendSuccess(
      res,
      200,
      "Events retrieved",
      events
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      500,
      error.message
    );
  }
};

// GET ARCHIVED EVENTS
const getArchivedEvents = async (
  req,
  res
) => {
  try {
    const events =
      await eventService.getArchivedEvents();

    return sendSuccess(
      res,
      200,
      "Archived events retrieved",
      events
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      500,
      error.message
    );
  }
};

// GET EVENT BY ID
const getEventById = async (req, res) => {
  try {
    const event =
      await eventService.getEventById(
        req.params.id
      );

    return sendSuccess(
      res,
      200,
      "Event retrieved",
      event
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      getErrorStatus(error),
      error.message
    );
  }
};

// UPDATE EVENT
const updateEvent = async (req, res) => {
  try {
    const event =
      await eventService.updateEvent(
        req.params.id,
        req.body,
        req.user.uid
      );

    return sendSuccess(
      res,
      200,
      "Event updated successfully",
      event
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      getErrorStatus(error),
      error.message
    );
  }
};

// UPDATE EVENT RECORD STATUS
const updateRecordStatus = async (
  req,
  res
) => {
  try {
    const event =
      await eventService.updateRecordStatus(
        req.params.id,
        req.body.recordStatus,
        req.user.uid
      );

    return sendSuccess(
      res,
      200,
      "Event record status updated successfully",
      event
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      getErrorStatus(error),
      error.message
    );
  }
};

// MARK COMPLETED
const markEventCompleted = async (
  req,
  res
) => {
  try {
    const event =
      await eventService.markEventCompleted(
        req.params.id,
        req.user.uid
      );

    return sendSuccess(
      res,
      200,
      "Event marked as completed",
      event
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      getErrorStatus(error),
      error.message
    );
  }
};

// CANCEL EVENT
const cancelEvent = async (req, res) => {
  try {
    const event =
      await eventService.cancelEvent(
        req.params.id,
        req.user.uid
      );

    return sendSuccess(
      res,
      200,
      "Event cancelled successfully",
      event
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      getErrorStatus(error),
      error.message
    );
  }
};

// ARCHIVE EVENT
const archiveEvent = async (req, res) => {
  try {
    const event =
      await eventService.archiveEvent(
        req.params.id,
        req.user.uid
      );

    return sendSuccess(
      res,
      200,
      "Event archived successfully",
      event
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      getErrorStatus(error),
      error.message
    );
  }
};

// RESTORE EVENT
const restoreEvent = async (req, res) => {
  try {
    const event =
      await eventService.restoreEvent(
        req.params.id,
        req.user.uid
      );

    return sendSuccess(
      res,
      200,
      "Event restored successfully",
      event
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      getErrorStatus(error),
      error.message
    );
  }
};

// DELETE EVENT
const deleteEvent = async (req, res) => {
  try {
    const result =
      await eventService.deleteEvent(
        req.params.id
      );

    return sendSuccess(
      res,
      200,
      "Event deleted permanently",
      result
    );
  } catch (error) {
    console.error(error);

    return sendError(
      res,
      getErrorStatus(error),
      error.message
    );
  }
};

module.exports = {
  createEvent,
  getAllEvents,
  getArchivedEvents,
  getEventById,
  updateEvent,
  updateRecordStatus,
  markEventCompleted,
  cancelEvent,
  archiveEvent,
  restoreEvent,
  deleteEvent,
};