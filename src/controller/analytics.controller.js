const { getDashboard } = require("../services/analytics.service");
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

module.exports = { dashboard };
