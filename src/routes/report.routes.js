const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { sendSuccess, sendError } = require("../utils/response.util");
const reports = require("../services/generatedReport.service");

router.use(verifyToken, authorizeRoles("staff", "admin"));

router.get("/", async (req, res) => {
  try {
    return sendSuccess(res, 200, "Generated reports retrieved", await reports.listGeneratedReports());
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "Failed to retrieve generated reports.");
  }
});

router.post("/", async (req, res) => {
  try {
    return sendSuccess(res, 201, "Report generated", await reports.generateReport(req.body, req.user));
  } catch (error) {
    if (error.message === "Invalid report type or filters." ||
        error.message === "A date range is required for monthly and annual reports.") {
      return sendError(res, 400, error.message);
    }
    console.error(error);
    return sendError(res, 500, "Failed to generate report.");
  }
});

router.get("/:id/download", async (req, res) => {
  try {
    const { fileName, bytes } = await reports.generatedPdf(req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(bytes);
  } catch (error) {
    if (error.message === "Generated report not found.") return sendError(res, 404, error.message);
    console.error(error);
    return sendError(res, 500, "Failed to download generated report.");
  }
});

module.exports = router;
