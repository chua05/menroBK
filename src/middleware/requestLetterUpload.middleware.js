const multer = require("multer");

const uploadRequestLetter = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 2,
    fieldSize: 1024 * 1024,
    parts: 3,
    fieldNameSize: 100,
  },
}).single("requestLetter");

function parseRequestLetterSubmission(req, res, next) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("multipart/form-data")) {
    return next();
  }
  return uploadRequestLetter(req, res, error => {
    if (error) return res.status(400).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "The request letter must not exceed 10 MB."
        : error.message || "Invalid request-letter upload.",
    });
    try {
      if (typeof req.body?.request !== "string") throw new Error("Request data is required.");
      const parsed = JSON.parse(req.body.request);
      if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error();
      req.body = parsed;
      return next();
    } catch {
      return res.status(400).json({ success: false, message: "Request data is invalid." });
    }
  });
}

module.exports = { parseRequestLetterSubmission };
