const { getDashboard, getMapTrees } = require("../services/analytics.service");
const { sendSuccess, sendError } = require("../utils/response.util");

async function dashboard(req, res) {
  try {
    return sendSuccess(res, 200, "Dashboard analytics retrieved", await getDashboard(req.query));
  } catch (error) {
    console.error(error);
    const isFilterError = /date filter|Date From/.test(error.message || "");
    return sendError(
      res,
      isFilterError ? 400 : 500,
      isFilterError ? error.message : "Failed to retrieve dashboard analytics."
    );
  }
}

async function mapTrees(req, res) {
  try {
    return sendSuccess(res, 200, "Map tree markers retrieved", await getMapTrees());
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "Failed to retrieve monitored tree markers.");
  }
}

module.exports = { dashboard, mapTrees };
