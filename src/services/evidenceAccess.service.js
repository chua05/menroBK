const fs = require("fs/promises");
const path = require("path");
const { getPlantingReportById } = require("./plantingReport.service");
const {
  getMonitoringRecordById,
  getAllMonitoringRecords,
} = require("./monitoring.service");

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");
const EVIDENCE_ROOTS = {
  planting: path.resolve(UPLOAD_ROOT, "planting-reports"),
  monitoring: path.resolve(UPLOAD_ROOT, "monitoring"),
};

const contentTypes = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function evidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseIndex(value) {
  if (!/^\d+$/.test(String(value || ""))) {
    throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  }
  return Number(value);
}

function storedReferencePath(reference) {
  if (typeof reference !== "string" || !reference.trim()) {
    throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  }

  let pathname;
  try {
    pathname = new URL(reference, "http://local.invalid").pathname;
    pathname = decodeURIComponent(pathname);
  } catch {
    throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  }

  if (pathname.includes("\0") || pathname.includes("\\")) {
    throw evidenceError("INVALID_EVIDENCE_PATH", "Invalid evidence path.");
  }

  const marker = "/uploads/";
  const markerIndex = pathname.indexOf(marker);
  const relative = markerIndex >= 0
    ? pathname.slice(markerIndex + marker.length)
    : pathname.replace(/^\/+/, "");

  const segments = relative.split("/");
  if (!relative || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw evidenceError("INVALID_EVIDENCE_PATH", "Invalid evidence path.");
  }

  return segments.join(path.sep);
}

async function resolveStoredEvidence(reference, kind) {
  const allowedRoot = EVIDENCE_ROOTS[kind];
  const relative = storedReferencePath(reference);
  const resolved = path.resolve(UPLOAD_ROOT, relative);
  const allowedPrefix = `${allowedRoot}${path.sep}`;

  if (!resolved.startsWith(allowedPrefix)) {
    throw evidenceError("INVALID_EVIDENCE_PATH", "Invalid evidence path.");
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
    }
    throw error;
  }

  if (!stat.isFile()) {
    throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  }

  const [realFile, realAllowedRoot] = await Promise.all([
    fs.realpath(resolved),
    fs.realpath(allowedRoot),
  ]);
  if (!realFile.startsWith(`${realAllowedRoot}${path.sep}`)) {
    throw evidenceError("INVALID_EVIDENCE_PATH", "Invalid evidence path.");
  }

  const contentType = contentTypes[path.extname(realFile).toLowerCase()];
  if (!contentType) {
    throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  }

  return { absolutePath: realFile, contentType };
}

function plantingPhotos(report) {
  if (Array.isArray(report.photos) && report.photos.length > 0) return report.photos;
  if (report.photoURL || report.photoPath) {
    return [{ photoURL: report.photoURL, photoPath: report.photoPath }];
  }
  return [];
}

async function plantingEvidenceForUser(reportId, photoIndex, user) {
  const report = await getPlantingReportById(reportId);
  const contributor = (report.submissions || []).some(
    (submission) => submission.contributorId === user.uid
  );
  const authorized = ["admin", "staff"].includes(user.role) ||
    report.participantId === user.uid || contributor;

  if (!authorized) {
    throw evidenceError("EVIDENCE_FORBIDDEN", "Evidence access forbidden.");
  }

  const photo = plantingPhotos(report)[parseIndex(photoIndex)];
  if (!photo) throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  return resolveStoredEvidence(photo.photoPath || photo.photoURL, "planting");
}

async function monitoringRecord(recordId) {
  try {
    return await getMonitoringRecordById(recordId);
  } catch (error) {
    if (error.message !== "Monitoring record not found.") throw error;
    const records = await getAllMonitoringRecords({ includeArchived: true });
    const legacy = records.find((record) => record.id === recordId);
    if (!legacy) throw error;
    return legacy;
  }
}

async function monitoringEvidenceForUser(recordId, entryIndex, user) {
  const record = await monitoringRecord(recordId);
  const authorized = ["admin", "staff"].includes(user.role) ||
    record.participantId === user.uid;

  if (!authorized) {
    throw evidenceError("EVIDENCE_FORBIDDEN", "Evidence access forbidden.");
  }

  const history = Array.isArray(record.history) ? record.history : [];
  const entry = history[parseIndex(entryIndex)];
  if (!entry?.photoUrl) {
    throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  }
  return resolveStoredEvidence(entry.photoUrl, "monitoring");
}

module.exports = {
  plantingEvidenceForUser,
  monitoringEvidenceForUser,
  resolveStoredEvidence,
};
