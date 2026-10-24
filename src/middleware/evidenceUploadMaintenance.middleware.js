const { sendError } = require("../utils/response.util");
const {
  resolveEvidenceUploadMaintenance,
} = require("../config/evidenceUploadMaintenance");

const EVIDENCE_UPLOAD_MAINTENANCE_MESSAGE =
  "Evidence uploads are temporarily unavailable. Please try again later.";

function evidenceUploadMaintenanceGate(req, res, next) {
  if (!resolveEvidenceUploadMaintenance()) return next();
  return sendError(res, 503, EVIDENCE_UPLOAD_MAINTENANCE_MESSAGE);
}

module.exports = {
  EVIDENCE_UPLOAD_MAINTENANCE_MESSAGE,
  evidenceUploadMaintenanceGate,
};
