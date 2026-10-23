const fs = require("fs/promises");
const path = require("path");
const { UPLOAD_ROOT } = require("../config/uploadRoot");
const { getPlantingReportById } = require("./plantingReport.service");
const {
  getMonitoringRecordById,
  getRawMonitoringRecordById,
  getAllMonitoringRecords,
} = require("./monitoring.service");

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
let cloudRetrieval;
// Monitoring corrections explicitly store null when replacing cloud evidence
// with verified local evidence. Null is a cleared marker, not a cloud reference.
const hasPrivateReference = value => value && Object.hasOwn(value, "privateEvidence") && value.privateEvidence !== null;
function cloudEvidence(reference, recordId, evidenceType) {
  if (!require("../config/evidenceStorage").resolveEvidenceStorageConfig().cloudRead) throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  cloudRetrieval ||= require("./firebaseEvidenceRetrieval.service").createFirebaseEvidenceRetrieval();
  const token = cloudRetrieval.serverResolvedEvidence({ reference, recordId, evidenceType });
  return { provider: "firebase", streamTo: (response, options) => cloudRetrieval.streamTo(token, response, options) };
}

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
    return [{ photoURL: report.photoURL, photoPath: report.photoPath,
      ...(hasPrivateReference(report) ? { privateEvidence: report.privateEvidence } : {}) }];
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
  if (hasPrivateReference(photo)) return cloudEvidence(photo.privateEvidence,
    report.reportType === "parent" ? photo._evidenceRecordId : report.id,
    report.reportType === "parent" ? "planting-contribution" : "planting-report");
  return resolveStoredEvidence(photo.photoPath || photo.photoURL, "planting");
}

async function monitoringRecord(recordId) {
  try {
    return await (getRawMonitoringRecordById || getMonitoringRecordById)(recordId);
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
  const history = Array.isArray(record.history) ? record.history : [];
  const entry = history[parseIndex(entryIndex)];
  const authorized = ["admin", "staff"].includes(user.role) ||
    record.participantId === user.uid || entry?.originalReporterId === user.uid ||
    entry?.monitoredBy === user.uid;

  if (!authorized) {
    throw evidenceError("EVIDENCE_FORBIDDEN", "Evidence access forbidden.");
  }

  if (hasPrivateReference(entry)) return cloudEvidence(entry.privateEvidence, entry.id,
    entry.observationType === "early" ? "monitoring-early" : "monitoring-official");
  if (!entry?.photoUrl) {
    throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  }
  return resolveStoredEvidence(entry.photoUrl, "monitoring");
}

async function monitoringRevisionEvidenceForUser(recordId, observationId, revisionNumber, user) {
  const record = await getRawMonitoringRecordById(recordId);
  const history = Array.isArray(record.history) ? record.history : [];
  const matches = history.filter((entry) => entry?.id === observationId);
  if (matches.length !== 1) throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  const observation = matches[0];
  const authorized = ["admin", "staff"].includes(user.role) ||
    observation.originalReporterId === user.uid || observation.monitoredBy === user.uid;
  if (!authorized) throw evidenceError("EVIDENCE_FORBIDDEN", "Evidence access forbidden.");
  const revision = (observation.revisionHistory || []).find(
    (entry) => Number(entry.revisionNumber) === Number(revisionNumber)
  );
  if (hasPrivateReference(revision?.evidenceRef)) return cloudEvidence(revision.evidenceRef.privateEvidence, observation.id,
    observation.observationType === "early" ? "monitoring-early" : "monitoring-official");
  if (!revision?.evidenceRef?.photoUrl) throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence photo not found.");
  return resolveStoredEvidence(revision.evidenceRef.photoUrl, "monitoring");
}

module.exports = {
  plantingEvidenceForUser,
  monitoringEvidenceForUser,
  monitoringRevisionEvidenceForUser,
  resolveStoredEvidence,
};
