const service = require("../services/officialPlantingReport.service");
function handler(action) {
  return async (req, res) => {
    try { return res.status(req.method === "POST" ? 201 : 200).json({ success: true, data: await action(req) }); }
    catch (error) {
      const status = [400, 401, 403, 404, 409, 413, 429, 503].includes(error.status) ? error.status : 500;
      if (status === 500) console.error("Official planting report operation failed", { code: error.code || "UNAVAILABLE" });
      return res.status(status).json({ success: false, message: status === 500 ? "Official planting reporting is temporarily unavailable." : error.message,
        ...(status < 500 && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}) });
    }
  };
}
module.exports = {
  listOptions: handler(req => service.listReleasedOptions(req.user, req.query)), submit: handler(req => service.submitOfficialReport(req.user, req.body)),
  uploadAttendance: handler(req => require("../services/plantingAttendance.service").uploadAttendance(req.user, req.params.id, req.file)),
  async downloadAttendance(req, res) {
    try { await require("../services/plantingAttendance.service").streamAttendance(req.user, req.params.id, res); }
    catch (error) {
      if (res.headersSent) return res.destroy();
      const status = [401, 403, 404, 409, 503].includes(error.status) ? error.status : 500;
      return res.status(status).json({ success: false, message: status === 500 ? "Private attendance is temporarily unavailable." : error.message });
    }
  },
};
