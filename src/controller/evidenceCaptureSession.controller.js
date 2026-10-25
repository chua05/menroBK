const service = require("../services/evidenceCaptureSession.service");

function sendError(res, error) {
  const status = Number(error.status) || 400;
  return res.status(status).json({ success: false, code: error.code || "CAPTURE_SESSION_INVALID", message: error.message });
}

async function create(req, res) {
  try {
    const data = await service.createCaptureSession({ actorId: req.user.uid, ...(req.body || {}) });
    return res.status(201).json({ success: true, data });
  } catch (error) { return sendError(res, error); }
}

async function verify(req, res) {
  try {
    const data = await service.verifyCaptureSession({ actorId: req.user.uid,
      sessionId: req.params.sessionId, file: req.file, ...(req.body || {}) });
    return res.status(200).json({ success: true, data });
  } catch (error) { return sendError(res, error); }
}

module.exports = { create, verify };
