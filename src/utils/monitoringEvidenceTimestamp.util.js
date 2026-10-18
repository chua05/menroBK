const { dateOnlyInManila } = require("./earlyMonitoring.util");

function timestampError(message) {
  const error = new Error(message);
  error.code = "INVALID_EVIDENCE_TIMESTAMP";
  error.status = 400;
  return error;
}

function normalizeCaptureTimestamp(metadata = {}) {
  const raw = metadata.capturedAt;
  if (!raw) throw timestampError("The monitoring photo must contain a valid original capture timestamp.");
  const parsed = raw instanceof Date ? raw : raw?.toDate?.() || new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw timestampError("The monitoring photo capture timestamp could not be read. Upload the original photo.");
  }
  const offsetAware = Boolean(metadata.captureOffset) ||
    (typeof raw === "string" && /(Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim()));
  if (offsetAware) return { instant: parsed, raw: String(raw), timezoneSource: "EXIF offset" };

  const year = parsed.getFullYear(), month = parsed.getMonth() + 1, day = parsed.getDate();
  const hour = parsed.getHours(), minute = parsed.getMinutes(), second = parsed.getSeconds();
  const instant = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+08:00`);
  return { instant, raw: String(raw), timezoneSource: "Assumed Asia/Manila (timezone-naive EXIF)" };
}

function validateMonitoringEvidenceTimestamp(metadata, monitoredDate, submittedAt = new Date()) {
  const normalized = normalizeCaptureTimestamp(metadata);
  if (normalized.instant.getTime() > submittedAt.getTime()) {
    throw timestampError("The monitoring photo capture time cannot be in the future.");
  }
  const captureDateManila = dateOnlyInManila(normalized.instant);
  if (captureDateManila !== monitoredDate) {
    throw timestampError(`The monitoring photo was captured on ${captureDateManila}, but Date Monitored is ${monitoredDate}. These dates must match.`);
  }
  return { captureTimestamp: normalized.instant, captureTimestampRaw: normalized.raw,
    captureDateManila, captureTimezoneSource: normalized.timezoneSource, captureTimestampValid: true };
}

module.exports = { normalizeCaptureTimestamp, validateMonitoringEvidenceTimestamp };
