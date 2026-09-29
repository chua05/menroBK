const {
  plantingEvidenceForUser,
  monitoringEvidenceForUser,
} = require("../services/evidenceAccess.service");
const { sendError } = require("../utils/response.util");

function evidenceStatus(error) {
  if (error.code === "EVIDENCE_FORBIDDEN") return 403;
  if (["EVIDENCE_NOT_FOUND", "INVALID_EVIDENCE_PATH"].includes(error.code) ||
      ["Planting report not found.", "Monitoring record not found."].includes(error.message)) {
    return 404;
  }
  return 500;
}

function sendEvidence(res, evidence) {
  res.setHeader("Content-Type", evidence.contentType);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.sendFile(evidence.absolutePath);
}

function handleEvidenceError(res, error) {
  const status = evidenceStatus(error);
  if (status === 500) console.error("Evidence retrieval failed:", error);
  return sendError(
    res,
    status,
    status === 403
      ? "Forbidden"
      : status === 404
        ? "Photo is unavailable."
        : "Unable to load the photo. Please try again."
  );
}

async function getPlantingEvidence(req, res) {
  try {
    return sendEvidence(res, await plantingEvidenceForUser(
      req.params.reportId,
      req.params.photoIndex,
      req.user
    ));
  } catch (error) {
    return handleEvidenceError(res, error);
  }
}

async function getMonitoringEvidence(req, res) {
  try {
    return sendEvidence(res, await monitoringEvidenceForUser(
      req.params.recordId,
      req.params.entryIndex,
      req.user
    ));
  } catch (error) {
    return handleEvidenceError(res, error);
  }
}

module.exports = { getPlantingEvidence, getMonitoringEvidence };
