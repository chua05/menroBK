const siteService = require("../services/site.service");

const {
  sendSuccess,
  sendError,
} = require("../utils/response.util");

// --------------------------------
// DETERMINE HTTP ERROR STATUS
// --------------------------------
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
    message.includes("must") ||
    message.includes("valid") ||
    message.includes("greater than")
  ) {
    return 400;
  }

  return 500;
}

// --------------------------------
// CREATE SITE
// --------------------------------
const createSite = async (
  req,
  res
) => {
  try {
    const site =
      await siteService.createSite({
        ...req.body,

        createdBy:
          req.user.uid,
      });

    return sendSuccess(
      res,
      201,
      "Site created",
      site
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

// --------------------------------
// GET ALL ACTIVE SITES
// --------------------------------
const getAllSites = async (
  req,
  res
) => {
  try {
    const sites =
      await siteService.getAllSites();

    return sendSuccess(
      res,
      200,
      "Sites retrieved",
      sites
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

// --------------------------------
// GET ARCHIVED SITES
// --------------------------------
const getArchivedSites = async (
  req,
  res
) => {
  try {
    const sites =
      await siteService.getArchivedSites();

    return sendSuccess(
      res,
      200,
      "Archived sites retrieved",
      sites
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

// --------------------------------
// GET SITE BY ID
// --------------------------------
const getSiteById = async (
  req,
  res
) => {
  try {
    const site =
      await siteService.getSiteById(
        req.params.id
      );

    return sendSuccess(
      res,
      200,
      "Site retrieved",
      site
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

// --------------------------------
// ARCHIVE SITE
// --------------------------------
const archiveSite = async (
  req,
  res
) => {
  try {
    const site =
      await siteService.archiveSite(
        req.params.id,
        req.user.uid
      );

    return sendSuccess(
      res,
      200,
      "Site archived",
      site
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

// --------------------------------
// RESTORE SITE
// --------------------------------
const restoreSite = async (
  req,
  res
) => {
  try {
    const site =
      await siteService.restoreSite(
        req.params.id,
        req.user.uid
      );

    return sendSuccess(
      res,
      200,
      "Site restored",
      site
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
  createSite,
  getAllSites,
  getArchivedSites,
  getSiteById,
  archiveSite,
  restoreSite,
};