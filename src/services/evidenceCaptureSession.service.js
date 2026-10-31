const crypto = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("../config/firebase");
const { isPointWithinMunicipality } = require("../config/municipality");
const {
  calculateDistanceMeters,
  isPointInPolygon,
} = require("../utils/geo.util");
const {
  generateImageHash,
  validateImageBuffer,
} = require("../utils/imageVerification.util");

const COLLECTION = "evidenceCaptureSessions";
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_ACCURACY_METERS = 50;
// Keep camera capture-session validation aligned with Planting Report submission.
// GPS accuracy has its own, separate 50 m policy.
const SITE_FALLBACK_METERS = 50;
const WORKFLOWS = new Set([
  "planting-report",
  "monitoring-early",
  "monitoring-official",
  "monitoring-resubmit",
]);

class CaptureSessionError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const problem = (code, status, message) => new CaptureSessionError(code, status, message);
const cleanId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
  ? value : "";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined && item !== "").sort(([a], [b]) => a.localeCompare(b)),
));
const timestampMillis = (value) => typeof value?.toMillis === "function" ? value.toMillis()
  : Number(value?._seconds ?? value?.seconds) * 1000;

function parseBinding(workflow, input = {}) {
  if (!WORKFLOWS.has(workflow)) throw problem("CAPTURE_SESSION_INVALID", 400, "Unsupported evidence capture workflow.");
  const binding = { workflow };
  if (workflow === "planting-report") {
    binding.siteId = cleanId(input.siteId);
    binding.eventId = cleanId(input.eventId);
    binding.distributionId = cleanId(input.distributionId);
    if (!binding.siteId || !binding.eventId || !binding.distributionId) {
      throw problem("CAPTURE_SESSION_INVALID", 400, "Site, event, and distribution are required for camera capture.");
    }
  } else {
    binding.plantingReportId = cleanId(input.plantingReportId);
    binding.siteId = cleanId(input.siteId);
    if (!binding.plantingReportId || !binding.siteId) {
      throw problem("CAPTURE_SESSION_INVALID", 400, "Planting report and site are required for monitoring capture.");
    }
    if (workflow === "monitoring-resubmit") {
      binding.monitoringId = cleanId(input.monitoringId);
      binding.observationId = cleanId(input.observationId);
      binding.expectedVersion = Number(input.expectedVersion);
      if (!binding.monitoringId || !binding.observationId || !Number.isInteger(binding.expectedVersion)) {
        throw problem("CAPTURE_SESSION_INVALID", 400, "Monitoring observation and version are required for replacement capture.");
      }
    }
  }
  return binding;
}

async function loadBoundResources(actorId, binding) {
  const siteRef = db.collection("sites").doc(binding.siteId);
  const reads = [siteRef.get()];
  if (binding.workflow === "planting-report") {
    reads.push(db.collection("events").doc(binding.eventId).get());
    reads.push(db.collection("distributions").doc(binding.distributionId).get());
  } else {
    reads.push(db.collection("plantingReports").doc(binding.plantingReportId).get());
  }
  const docs = await Promise.all(reads);
  if (!docs[0].exists) throw problem("CAPTURE_SESSION_INVALID", 404, "Planting site was not found.");
  const site = docs[0].data();
  if (String(site.status || "").toLowerCase() === "inactive") {
    throw problem("CAPTURE_SESSION_INVALID", 422, "The assigned planting site is inactive.");
  }
  if (binding.workflow === "planting-report") {
    if (!docs[1].exists || !docs[2].exists) throw problem("CAPTURE_SESSION_INVALID", 404, "The event or distribution was not found.");
    const event = docs[1].data();
    const distribution = docs[2].data();
    if (String(event.plantingSiteId || "") !== binding.siteId ||
        (distribution.plantingSiteId && String(distribution.plantingSiteId) !== binding.siteId) ||
        (distribution.eventId && String(distribution.eventId) !== binding.eventId) ||
        String(distribution.status || "") !== "Released") {
      throw problem("CAPTURE_SESSION_FORBIDDEN", 403, "The camera capture target is not available to this workflow.");
    }
  } else {
    if (!docs[1].exists) throw problem("CAPTURE_SESSION_INVALID", 404, "Planting report was not found.");
    const report = docs[1].data();
    if (String(report.siteId || "") !== binding.siteId ||
        (report.participantId && String(report.participantId) !== actorId)) {
      throw problem("CAPTURE_SESSION_FORBIDDEN", 403, "The monitoring capture target is not available to this participant.");
    }
  }
  return site;
}

async function createCaptureSession({ actorId, workflow, ...input }) {
  if (!cleanId(actorId)) throw problem("CAPTURE_SESSION_FORBIDDEN", 403, "Authenticated participant is required.");
  const binding = parseBinding(workflow, input);
  await loadBoundResources(actorId, binding);
  const sessionId = crypto.randomUUID();
  const nonce = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  await db.collection(COLLECTION).doc(sessionId).create({
    schemaVersion: 1,
    actorId,
    actorRole: "participant",
    ...binding,
    bindingHash: sha256(canonical(binding)),
    nonceHash: sha256(nonce),
    state: "OPEN",
    issuedAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + SESSION_TTL_MS),
    verificationPolicyVersion: 1,
  });
  return {
    captureSessionId: sessionId,
    nonce,
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    constraints: {
      maximumAccuracyMeters: MAX_ACCURACY_METERS,
      maximumCaptureAgeSeconds: SESSION_TTL_MS / 1000,
      acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
      maximumBytes: 10 * 1024 * 1024,
    },
  };
}

function nonceMatches(savedHash, nonce) {
  if (typeof savedHash !== "string" || typeof nonce !== "string") return false;
  const actual = Buffer.from(sha256(nonce), "hex");
  const expected = Buffer.from(savedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validateLocation(site, input) {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const accuracyMeters = Number(input.accuracy);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw problem("CAPTURE_LOCATION_INVALID", 422, "A valid device location is required for camera evidence.");
  }
  if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > MAX_ACCURACY_METERS) {
    throw problem("CAPTURE_LOCATION_INACCURATE", 422, "Camera evidence requires GPS accuracy of 50 meters or better.");
  }
  if (!isPointWithinMunicipality(latitude, longitude)) {
    throw problem("CAPTURE_LOCATION_OUTSIDE_BULAN", 422, "Camera evidence must be captured within the Municipality of Bulan.");
  }
  const siteLatitude = Number(site.latitude);
  const siteLongitude = Number(site.longitude);
  if (!Number.isFinite(siteLatitude) || !Number.isFinite(siteLongitude)) {
    throw problem("CAPTURE_SITE_GEOMETRY_UNAVAILABLE", 503, "The assigned planting site cannot currently be verified.");
  }
  const distanceMeters = calculateDistanceMeters(latitude, longitude, siteLatitude, siteLongitude);
  const radius = Number(site.coverageRadiusMeters);
  const hasConfiguredRadius = Number.isFinite(radius) && radius > 0;
  const hasSitePolygon = Array.isArray(site.polygon) && site.polygon.length >= 3;
  const insideAssignedSite = hasConfiguredRadius
    ? distanceMeters <= radius
    : hasSitePolygon
      ? isPointInPolygon(latitude, longitude, site.polygon)
      : distanceMeters <= SITE_FALLBACK_METERS;
  if (!insideAssignedSite) {
    throw problem("CAPTURE_LOCATION_OUTSIDE_SITE", 422, "Camera evidence must be captured within the assigned planting site.");
  }
  return {
    latitude, longitude, accuracyMeters, distanceMeters,
    boundaryRule: hasConfiguredRadius ? "configured-radius" : hasSitePolygon ? "site-polygon" : "50m-fallback",
    boundaryLimitMeters: hasConfiguredRadius ? radius : hasSitePolygon ? null : SITE_FALLBACK_METERS,
  };
}

async function verifyCaptureSession({ actorId, sessionId, nonce, file, capturedAt, ...location }) {
  if (!file?.buffer) throw problem("CAPTURE_SESSION_INVALID", 400, "A captured photo is required.");
  const validSessionId = cleanId(sessionId);
  if (!validSessionId) throw problem("CAPTURE_SESSION_INVALID", 400, "Camera capture session is invalid.");
  const ref = db.collection(COLLECTION).doc(validSessionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw problem("CAPTURE_SESSION_INVALID", 404, "Camera capture session was not found.");
  const session = snapshot.data();
  if (session.actorId !== actorId) throw problem("CAPTURE_SESSION_FORBIDDEN", 403, "Camera capture session belongs to another user.");
  if (session.state !== "OPEN") throw problem("CAPTURE_SESSION_REPLAYED", 409, "Camera capture session has already been used.");
  const now = Date.now();
  if (timestampMillis(session.expiresAt) <= now) throw problem("CAPTURE_SESSION_EXPIRED", 410, "Camera capture session expired. Please try again.");
  if (!nonceMatches(session.nonceHash, nonce)) throw problem("CAPTURE_SESSION_INVALID", 400, "Camera capture session could not be verified.");
  const capturedMillis = Date.parse(capturedAt);
  const issuedMillis = timestampMillis(session.issuedAt);
  if (!Number.isFinite(capturedMillis) || capturedMillis < issuedMillis - 30_000 || capturedMillis > now + 30_000) {
    throw problem("CAPTURE_TIMESTAMP_INVALID", 422, "Camera capture timestamp is outside the permitted session window.");
  }
  const imageDetails = await validateImageBuffer(file.buffer);
  const expectedMime = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[imageDetails.format];
  if (!expectedMime || file.mimetype !== expectedMime) {
    throw problem("CAPTURE_IMAGE_MISMATCH", 400, "Captured image type does not match its contents.");
  }
  const site = await loadBoundResources(actorId, session);
  const verifiedLocation = validateLocation(site, location);
  const imageSha256 = generateImageHash(file.buffer);
  if (location.clientImageSha256 && location.clientImageSha256 !== imageSha256) {
    throw problem("CAPTURE_IMAGE_MISMATCH", 409, "Captured image integrity check failed.");
  }
  const duplicate = await db.collection("plantingEvidenceHashes").doc(imageSha256).get();
  const monitoringDuplicate = await db.collection("monitoringEvidenceHashes").doc(imageSha256).get();
  if (duplicate.exists || monitoringDuplicate.exists) throw problem("DUPLICATE_EVIDENCE", 409, "Duplicate evidence image detected.");
  const verificationId = crypto.randomUUID();
  const update = {
    state: "VERIFIED",
    verifiedAt: Timestamp.fromMillis(now),
    verificationIdHash: sha256(verificationId),
    imageSha256,
    contentType: file.mimetype,
    sizeBytes: file.buffer.length,
    capturedAtClient: Timestamp.fromMillis(capturedMillis),
    receivedAtServer: Timestamp.fromMillis(now),
    ...verifiedLocation,
    insideBulan: true,
    insideAssignedSite: true,
    evidenceSource: "browser-camera",
    locationSource: "Browser Capture Session",
  };
  await db.runTransaction(async transaction => {
    const current = await transaction.get(ref);
    if (!current.exists || current.data().state !== "OPEN") {
      throw problem("CAPTURE_SESSION_REPLAYED", 409, "Camera capture session has already been used.");
    }
    transaction.update(ref, update);
  });
  return { verificationId, captureSessionId: sessionId, imageSha256,
    verifiedAt: new Date(now).toISOString(), evidenceSource: "browser-camera",
    location: { latitude: verifiedLocation.latitude, longitude: verifiedLocation.longitude,
      accuracy: verifiedLocation.accuracyMeters, distanceMeters: verifiedLocation.distanceMeters,
      boundaryRule: verifiedLocation.boundaryRule, boundaryLimitMeters: verifiedLocation.boundaryLimitMeters,
      insideBulan: true, insideAssignedSite: true } };
}

function parseEvidenceManifest(value, fileCount) {
  if (!value) return Array.from({ length: fileCount }, () => ({ source: "uploaded-original" }));
  let manifest;
  try { manifest = typeof value === "string" ? JSON.parse(value) : value; } catch {
    throw problem("CAPTURE_SESSION_INVALID", 400, "Evidence manifest is invalid.");
  }
  if (!Array.isArray(manifest) || manifest.length !== fileCount) {
    throw problem("CAPTURE_SESSION_INVALID", 400, "Evidence manifest does not match the submitted photos.");
  }
  return manifest;
}

async function resolveSubmissionEvidence({ actorId, workflow, binding, files, manifest }) {
  const entries = parseEvidenceManifest(manifest, files.length);
  const resolved = [];
  for (let index = 0; index < files.length; index += 1) {
    const entry = entries[index] || {};
    if (entry.source !== "browser-camera") { resolved.push(null); continue; }
    const sessionId = cleanId(entry.captureSessionId);
    if (!sessionId) throw problem("CAPTURE_SESSION_INVALID", 400, "Camera capture descriptor is invalid.");
    const snapshot = await db.collection(COLLECTION).doc(sessionId).get();
    const session = snapshot.data();
    if (!snapshot.exists || session.actorId !== actorId || session.workflow !== workflow ||
        !["VERIFIED", "CONSUMED"].includes(session.state) ||
        !nonceMatches(session.nonceHash, entry.nonce) || !nonceMatches(session.verificationIdHash, entry.verificationId) ||
        generateImageHash(files[index].buffer) !== session.imageSha256 ||
        Object.entries(binding).some(([key, value]) => value && String(session[key] || "") !== String(value))) {
      throw problem("CAPTURE_IMAGE_MISMATCH", 409, "Verified camera evidence no longer matches this submission.");
    }
    if (session.state === "VERIFIED" && timestampMillis(session.expiresAt) <= Date.now()) {
      throw problem("CAPTURE_SESSION_EXPIRED", 410, "Camera capture session expired. Please retake the photo.");
    }
    resolved.push({ id: sessionId, ...session });
  }
  return resolved;
}

async function prepareConsumption(transaction, sessions) {
  const active = sessions.filter(Boolean);
  const documents = await Promise.all(active.map(session => transaction.get(db.collection(COLLECTION).doc(session.id))));
  if (documents.some((document, index) => !document.exists || document.data().state !== "VERIFIED" ||
      document.data().imageSha256 !== active[index].imageSha256)) {
    throw problem("CAPTURE_SESSION_REPLAYED", 409, "Camera evidence has already been consumed.");
  }
  return recordId => active.forEach(session => transaction.update(db.collection(COLLECTION).doc(session.id), {
    state: "CONSUMED", consumedAt: Timestamp.now(), consumedRecordId: recordId,
  }));
}

module.exports = {
  COLLECTION, SESSION_TTL_MS, MAX_ACCURACY_METERS, SITE_FALLBACK_METERS, CaptureSessionError,
  createCaptureSession, verifyCaptureSession, resolveSubmissionEvidence, prepareConsumption,
  _test: { parseBinding, validateLocation, nonceMatches, sha256 },
};
