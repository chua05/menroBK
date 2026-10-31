const crypto = require("node:crypto");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { resolveVerifiedPlantingCohortConfig } = require("../config/verifiedPlantingCohort");

const cohorts = db.collection("verifiedPlantingCohorts");
const BASELINE_STATUSES = new Set(["NOT_STARTED", "IN_PROGRESS", "REGISTERED"]);
const CONDITION_VALUES = new Set(["Healthy", "Damaged", "Dead", "Unknown"]);

function disabledError() {
  const error = new Error("Verified planting cohort workflow is disabled.");
  error.code = "COHORT_WORKFLOW_DISABLED";
  error.status = 409;
  return error;
}

function cohortIdFor(reportId) {
  if (typeof reportId !== "string" || !reportId || reportId.includes("/")) {
    throw new Error("Invalid planting report ID.");
  }
  return `VPC-${crypto.createHash("sha256").update(reportId).digest("hex").slice(0, 24)}`;
}

function normalizedSpecies(event = {}, report = {}) {
  const items = Array.isArray(event.seedlingItems) ? event.seedlingItems : [];
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const inventoryId = String(item?.inventoryId || "").trim();
    const species = String(item?.species || "").trim();
    const key = `${inventoryId}|${species}`;
    if ((!inventoryId && !species) || seen.has(key)) continue;
    seen.add(key);
    output.push({ inventoryId, species, releasedQuantity: Number(item?.quantity || 0) || 0 });
  }
  if (!output.length && String(report.species || "").trim()) {
    output.push({ inventoryId: String(report.inventoryId || "").trim(), species: String(report.species).trim(), releasedQuantity: 0 });
  }
  return output;
}

function authoritativeQuantity(report = {}) {
  const isParent = report.reportType === "parent";
  const eligible = isParent
    ? report.reportingProgress === "Completed"
    : report.verificationStatus === "Approved";
  const quantity = Number(isParent ? report.acceptedQuantity : report.quantityPlanted);
  return eligible && Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
}

async function ensureCohortForAuthoritativeReportInTransaction(transaction, {
  reportId, report, now = Timestamp.now(),
}) {
  const config = resolveVerifiedPlantingCohortConfig();
  if (!config.enabled) return null;
  const verifiedPlantedQuantity = authoritativeQuantity(report);
  if (!verifiedPlantedQuantity) return null;

  const ref = cohorts.doc(cohortIdFor(reportId));
  const existing = await transaction.get(ref);
  if (existing.exists) {
    const current = existing.data();
    if (current.source?.plantingReportId !== reportId) {
      throw new Error("Verified planting cohort source is inconsistent.");
    }
    return { id: ref.id, ...current, created: false };
  }

  let event = {};
  if (report.eventId) {
    const eventDoc = await transaction.get(db.collection("events").doc(report.eventId));
    if (eventDoc.exists) event = eventDoc.data();
  }
  const data = {
    schemaVersion: config.schemaVersion,
    recordType: "verifiedPlantingCohort",
    source: {
      plantingReportId: reportId,
      requestId: String(report.requestId || event.sourceRequestId || "").trim(),
      eventId: String(report.eventId || "").trim(),
      distributionId: String(report.distributionId || report.requestId || "").trim(),
      siteId: String(report.siteId || event.plantingSiteId || "").trim(),
      species: normalizedSpecies(event, report),
    },
    verifiedPlantedQuantity,
    authoritativeAt: now,
    baselineStatus: "NOT_STARTED",
    baselineVersion: 0,
    baseline: null,
    samplingWorkflowEnabled: false,
    createdAt: now,
    updatedAt: now,
  };
  transaction.create(ref, data);
  return { id: ref.id, ...data, created: true };
}

function safeCohort(id, data) {
  return { id, ...data };
}

async function getVerifiedPlantingCohort(id) {
  const doc = await cohorts.doc(id).get();
  if (!doc.exists) {
    const error = new Error("Verified planting cohort not found.");
    error.status = 404;
    throw error;
  }
  return safeCohort(doc.id, doc.data());
}

function parseCoordinate(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be a valid coordinate.`);
  }
  return number;
}

function normalizeSampleUnits(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Baseline sample units must contain up to 1000 entries.");
  const ids = new Set();
  return value.map((unit) => {
    const permanentId = String(unit?.permanentId || "").trim();
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(permanentId) || ids.has(permanentId)) {
      throw new Error("Each baseline sample must have a unique permanent tree or plot ID.");
    }
    ids.add(permanentId);
    const unitType = String(unit?.unitType || "").trim();
    if (!new Set(["tree", "plot"]).has(unitType)) throw new Error("Baseline sample unit type must be tree or plot.");
    const condition = String(unit?.condition || "Unknown").trim();
    if (!CONDITION_VALUES.has(condition)) throw new Error("Baseline sample condition is invalid.");
    const heightMeters = unit?.heightMeters === undefined || unit?.heightMeters === "" ? null : Number(unit.heightMeters);
    const diameterCentimeters = unit?.diameterCentimeters === undefined || unit?.diameterCentimeters === "" ? null : Number(unit.diameterCentimeters);
    if ((heightMeters !== null && (!Number.isFinite(heightMeters) || heightMeters < 0)) ||
        (diameterCentimeters !== null && (!Number.isFinite(diameterCentimeters) || diameterCentimeters < 0))) {
      throw new Error("Baseline height and diameter must be non-negative numbers.");
    }
    const photoReferences = Array.isArray(unit?.photoReferences) ? unit.photoReferences : [];
    if (photoReferences.length > 10 || photoReferences.some((photo) => !/^[A-Za-z0-9_-]{3,128}$/.test(String(photo?.evidenceId || "")))) {
      throw new Error("Baseline photo references are invalid.");
    }
    return {
      permanentId, unitType,
      latitude: parseCoordinate(unit?.latitude, "Baseline latitude", -90, 90),
      longitude: parseCoordinate(unit?.longitude, "Baseline longitude", -180, 180),
      condition, heightMeters, diameterCentimeters,
      photoReferences: photoReferences.map((photo) => ({ evidenceId: String(photo.evidenceId), capturedAt: photo.capturedAt || null })),
    };
  });
}

async function registerBaseline({ cohortId, expectedVersion, status = "REGISTERED", sampleUnits, actorId }) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabledError();
  if (!BASELINE_STATUSES.has(status)) throw new Error("Baseline status is invalid.");
  if (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 0) {
    throw new Error("A valid expected baseline version is required.");
  }
  const units = normalizeSampleUnits(sampleUnits);
  if (status === "REGISTERED" && !units.length) throw new Error("At least one baseline sample is required to register a baseline.");
  const ref = cohorts.doc(cohortId);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists) {
      const error = new Error("Verified planting cohort not found.");
      error.status = 404;
      throw error;
    }
    const current = doc.data();
    if (Number(current.baselineVersion || 0) !== Number(expectedVersion)) {
      const error = new Error("This baseline changed while you were editing. Refresh and try again.");
      error.status = 409;
      throw error;
    }
    const now = Timestamp.now();
    transaction.update(ref, {
      baselineStatus: status,
      baselineVersion: Number(current.baselineVersion || 0) + 1,
      baseline: { registeredBy: actorId, registeredAt: now, sampleUnits: units },
      updatedAt: now,
    });
  });
  return getVerifiedPlantingCohort(cohortId);
}

module.exports = {
  cohortIdFor,
  ensureCohortForAuthoritativeReportInTransaction,
  getVerifiedPlantingCohort,
  registerBaseline,
  _test: { authoritativeQuantity, normalizeSampleUnits },
};
