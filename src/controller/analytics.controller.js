const { getDashboard } = require("../services/analytics.service");
const { sendSuccess, sendError } = require("../utils/response.util");

async function dashboard(req, res) {
  try {
    return sendSuccess(res, 200, "Dashboard analytics retrieved", await getDashboard());
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "Failed to retrieve dashboard analytics.");
  }
}

module.exports = { dashboard };
