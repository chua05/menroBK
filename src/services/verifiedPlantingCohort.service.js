const crypto = require("node:crypto");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { resolveVerifiedPlantingCohortConfig } = require("../config/verifiedPlantingCohort");

const cohorts = db.collection("verifiedPlantingCohorts");
const BASELINE_STATUSES = new Set(["NOT_STARTED", "IN_PROGRESS", "REGISTERED"]);
const CONDITION_VALUES = new Set(["Healthy", "Damaged", "Dead", "Unknown"]);
const PLAN_STATUSES = new Set(["DRAFT", "PENDING_ADMIN_APPROVAL", "APPROVED", "RETURNED"]);
const SELECTION_METHODS = new Set(["systematic", "stratified", "documented-manual"]);

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

// Private evidence storage accepts only identifier-safe record IDs. Keep the
// cohort/sample association deterministic without leaking either identifier to
// the object namespace or using a delimiter the storage contract rejects.
function baselineEvidenceRecordId(cohortId, sampleId) {
  return `VPCB-${crypto.createHash("sha256").update(`${cohortId}\u0000${sampleId}`).digest("hex").slice(0, 48)}`;
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

function safePhotoReference(reference = {}) {
  const { privateEvidence, ...safe } = reference;
  return safe;
}

function safeCohort(id, data) {
  const redactBaselineEntry = (entry) => ({ ...entry, sampleUnits: Array.isArray(entry?.sampleUnits)
    ? entry.sampleUnits.map(unit => ({ ...unit, photoReferences: (unit.photoReferences || []).map(safePhotoReference) }))
    : entry?.sampleUnits });
  const baseline = data?.baseline ? {
    ...data.baseline,
    sampleUnits: (data.baseline.sampleUnits || []).map(unit => ({ ...unit,
      photoReferences: (unit.photoReferences || []).map(safePhotoReference) })),
  } : data?.baseline;
  return { id, ...data, baseline,
    baselineHistory: Array.isArray(data?.baselineHistory) ? data.baselineHistory.map(redactBaselineEntry) : data?.baselineHistory };
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

async function listVerifiedPlantingCohorts() {
  const snapshot = await cohorts.get();
  return snapshot.docs.map((doc) => safeCohort(doc.id, doc.data()));
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function asNonEmptyString(value, label, maximum = 240) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is required.`);
  return normalized;
}

function provisionalTarget(verifiedPlantedQuantity) {
  const quantity = Number(verifiedPlantedQuantity);
  return Number.isSafeInteger(quantity) && quantity > 0 ? Math.max(1, Math.ceil(quantity * 0.1)) : 0;
}

function normalizePlannedSamples(value, target) {
  if (!Array.isArray(value) || value.length !== target) {
    throw new Error(`Select exactly the provisional target of ${target} permanent sample trees or plots.`);
  }
  const seen = new Set();
  return value.map((sample) => {
    const permanentId = asNonEmptyString(sample?.permanentId, "Each permanent sample ID", 80);
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(permanentId) || seen.has(permanentId)) {
      throw new Error("Each planned sample must have a unique permanent tree or plot ID.");
    }
    seen.add(permanentId);
    const unitType = String(sample?.unitType || "").trim();
    if (!new Set(["tree", "plot"]).has(unitType)) throw new Error("Each planned sample must be a tree or plot.");
    return {
      permanentId,
      unitType,
      species: asNonEmptyString(sample?.species, "Sample species", 120),
      siteReference: asNonEmptyString(sample?.siteReference, "Sample site or plot reference", 160),
      selectionReason: asNonEmptyString(sample?.selectionReason, "Sample-selection note", 240),
    };
  });
}

function normalizeDistribution(value, plannedSamples) {
  const rows = Array.isArray(value) ? value : [];
  if (!rows.length) throw new Error("Document the species and site distribution used for sample selection.");
  const plannedIds = new Set(plannedSamples.map((sample) => sample.permanentId));
  const accounted = new Set();
  return rows.map((row) => {
    const sampleIds = Array.isArray(row?.sampleIds) ? row.sampleIds.map((id) => String(id || "").trim()) : [];
    if (!sampleIds.length || sampleIds.some((id) => !plannedIds.has(id) || accounted.has(id))) {
      throw new Error("Species/site distribution must account for each selected sample once.");
    }
    sampleIds.forEach((id) => accounted.add(id));
    return {
      species: asNonEmptyString(row?.species, "Distribution species", 120),
      siteReference: asNonEmptyString(row?.siteReference, "Distribution site reference", 160),
      sampleIds,
    };
  }).map((row, index, all) => {
    if (index === all.length - 1 && accounted.size !== plannedIds.size) {
      throw new Error("Species/site distribution must account for each selected sample once.");
    }
    return row;
  });
}

function samplingPlanSnapshot(plan) {
  return {
    version: plan.version,
    status: plan.status,
    provisionalPolicy: plan.provisionalPolicy,
    provisionalTarget: plan.provisionalTarget,
    selectionMethod: plan.selectionMethod,
    selectedSamples: plan.selectedSamples,
    speciesSiteDistribution: plan.speciesSiteDistribution,
    notes: plan.notes,
    submittedBy: plan.submittedBy,
    submittedAt: plan.submittedAt,
    reviewedBy: plan.reviewedBy || null,
    reviewedAt: plan.reviewedAt || null,
    reviewRemarks: plan.reviewRemarks || null,
  };
}

async function saveSamplingPlan({ cohortId, actorId, expectedVersion, selectionMethod, selectedSamples, speciesSiteDistribution, notes, submitForApproval = false }) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabledError();
  if (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 0) throw new Error("A valid expected sampling-plan version is required.");
  if (!SELECTION_METHODS.has(String(selectionMethod || ""))) throw new Error("Select a documented sample-selection method.");
  const ref = cohorts.doc(cohortId);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists) { const error = new Error("Verified planting cohort not found."); error.status = 404; throw error; }
    const current = doc.data();
    const currentPlan = current.samplingPlan || { version: 0, status: "DRAFT" };
    if (Number(currentPlan.version || 0) !== Number(expectedVersion)) throw conflict("This sampling plan changed while you were editing. Refresh and try again.");
    if (currentPlan.status === "APPROVED") throw conflict("An approved sampling plan cannot be replaced. Submit an approved replacement through MENRO policy.");
    const target = provisionalTarget(current.verifiedPlantedQuantity);
    if (!target) throw new Error("This cohort has no authoritative planted quantity for sampling.");
    const samples = normalizePlannedSamples(selectedSamples, target);
    const distribution = normalizeDistribution(speciesSiteDistribution, samples);
    const now = Timestamp.now();
    const plan = {
      schemaVersion: 1,
      version: Number(currentPlan.version || 0) + 1,
      status: submitForApproval ? "PENDING_ADMIN_APPROVAL" : "DRAFT",
      provisionalPolicy: resolveVerifiedPlantingCohortConfig().provisionalSamplingPolicy,
      provisionalTarget: target,
      selectionMethod,
      selectedSamples: samples,
      speciesSiteDistribution: distribution,
      notes: String(notes || "").trim().slice(0, 1000),
      submittedBy: actorId,
      submittedAt: now,
    };
    const history = Array.isArray(current.samplingPlanHistory) ? current.samplingPlanHistory : [];
    transaction.update(ref, { samplingPlan: plan, samplingPlanHistory: [...history, samplingPlanSnapshot(plan)], updatedAt: now });
  });
  return getVerifiedPlantingCohort(cohortId);
}

async function approveSamplingPlan({ cohortId, actorId, expectedVersion, approve = true, remarks = "" }) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabledError();
  const ref = cohorts.doc(cohortId);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists) { const error = new Error("Verified planting cohort not found."); error.status = 404; throw error; }
    const current = doc.data(); const plan = current.samplingPlan;
    if (!plan || plan.status !== "PENDING_ADMIN_APPROVAL") throw conflict("Only a pending sampling plan can be reviewed.");
    if (Number(plan.version) !== Number(expectedVersion)) throw conflict("This sampling plan changed while you were editing. Refresh and try again.");
    const now = Timestamp.now();
    const reviewed = { ...plan, status: approve ? "APPROVED" : "RETURNED", reviewedBy: actorId, reviewedAt: now, reviewRemarks: String(remarks || "").trim().slice(0, 1000) };
    const history = Array.isArray(current.samplingPlanHistory) ? current.samplingPlanHistory : [];
    transaction.update(ref, { samplingPlan: reviewed, samplingPlanHistory: [...history, samplingPlanSnapshot(reviewed)], updatedAt: now });
  });
  return getVerifiedPlantingCohort(cohortId);
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
    const remarks = String(unit?.remarks || "").trim();
    if (remarks.length > 1000) throw new Error("Baseline remarks are too long.");
    const captureDate = String(unit?.captureDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(captureDate)) throw new Error("Baseline capture date is required.");
    if (!photoReferences.length) throw new Error("At least one baseline photo reference is required for every sample.");
    return {
      permanentId, unitType,
      latitude: parseCoordinate(unit?.latitude, "Baseline latitude", -90, 90),
      longitude: parseCoordinate(unit?.longitude, "Baseline longitude", -180, 180),
      condition, heightMeters, diameterCentimeters,
      photoReferences: photoReferences.map((photo) => ({ evidenceId: String(photo.evidenceId), capturedAt: photo.capturedAt || null })),
      remarks, captureDate,
    };
  });
}

async function registerBaselineImpl({ cohortId, expectedVersion, status = "REGISTERED", sampleUnits, actorId, workflowOperation = null, captureEvidence = [], uploadedReferences = new Map() }) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabledError();
  if (!BASELINE_STATUSES.has(status)) throw new Error("Baseline status is invalid.");
  if (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 0) {
    throw new Error("A valid expected baseline version is required.");
  }
  let units = normalizeSampleUnits(sampleUnits);
  if (uploadedReferences.size) units = units.map(unit => ({ ...unit,
    photoReferences: uploadedReferences.get(unit.permanentId) || unit.photoReferences }));
  if (status === "REGISTERED" && !units.length) throw new Error("At least one baseline sample is required to register a baseline.");
  const ref = cohorts.doc(cohortId);
  await db.runTransaction(async (transaction) => {
    const duplicateRefs = workflowOperation ? [...uploadedReferences.values()].flat().map(reference =>
      db.collection("baselineEvidenceHashes").doc(reference.imageSha256)) : [];
    const reads = await Promise.all([transaction.get(ref), ...duplicateRefs.map((duplicateRef) => transaction.get(duplicateRef))]);
    const doc = reads[0];
    if (reads.slice(1).some((duplicate) => duplicate.exists)) throw conflict("A baseline photo was already used by another sample.");
    if (!doc.exists) {
      const error = new Error("Verified planting cohort not found.");
      error.status = 404;
      throw error;
    }
    const current = doc.data();
    const plan = current.samplingPlan;
    if (!plan || plan.status !== "APPROVED") throw conflict("An approved sampling plan is required before baseline registration.");
    if (Number(current.baselineVersion || 0) !== Number(expectedVersion)) {
      const error = new Error("This baseline changed while you were editing. Refresh and try again.");
      error.status = 409;
      throw error;
    }
    const now = Timestamp.now();
    // Both helpers perform transaction reads and return write closures. Await
    // those reads before this transaction starts writing; otherwise Firestore
    // aborts the baseline link after the private upload has completed.
    const completeEvidence = workflowOperation ? await require("./evidenceWorkflow.service").workflow().prepareLink(transaction, workflowOperation) : null;
    const consumeCaptures = workflowOperation ? await require("./evidenceCaptureSession.service").prepareConsumption(transaction, captureEvidence) : null;
    const plannedIds = new Set(plan.selectedSamples.map((sample) => sample.permanentId));
    if (units.length !== plannedIds.size || units.some((unit) => !plannedIds.has(unit.permanentId))) {
      throw new Error("Baseline samples must match the Admin-approved sampling plan. Replacements require a new approved plan.");
    }
    const baseline = { registeredBy: actorId, registeredAt: now, sampleUnits: units, approvalStatus: "PENDING_ADMIN_APPROVAL" };
    const history = Array.isArray(current.baselineHistory) ? current.baselineHistory : [];
    transaction.update(ref, {
      baselineStatus: status === "IN_PROGRESS" ? "IN_PROGRESS" : "REGISTERED",
      baselineVersion: Number(current.baselineVersion || 0) + 1,
      baseline,
      baselineHistory: [...history, { version: Number(current.baselineVersion || 0) + 1, status: "PENDING_ADMIN_APPROVAL", registeredBy: actorId, registeredAt: now, sampleUnits: units }],
      updatedAt: now,
    });
    if (workflowOperation) {
      for (const [sampleId, references] of uploadedReferences) for (const reference of references) {
        const duplicateRef = db.collection("baselineEvidenceHashes").doc(reference.imageSha256);
        transaction.create(duplicateRef, { cohortId, sampleId, createdAt: now });
      }
      consumeCaptures?.(cohortId);
      completeEvidence?.({ cohortId });
    }
  });
  return getVerifiedPlantingCohort(cohortId);
}

async function registerBaselineWithEvidence({ cohortId, actorId, sampleUnits, evidenceManifest, files, idempotencyKey, ...rest }) {
  if (!Array.isArray(files) || !files.length) throw new Error("A verified baseline photo is required for every permanent sample.");
  const manifest = Array.isArray(evidenceManifest) ? evidenceManifest : [];
  const normalizedUnits = Array.isArray(sampleUnits) ? sampleUnits : [];
  if (manifest.length !== files.length || manifest.length !== normalizedUnits.length) {
    throw new Error("Baseline evidence does not match the submitted samples.");
  }
  const submittedIds = normalizedUnits.map(unit => String(unit?.permanentId || "").trim());
  if (new Set(submittedIds).size !== submittedIds.length || manifest.some((entry, index) =>
    String(entry?.sampleId || "").trim() !== submittedIds[index])) {
    throw new Error("Each baseline sample requires matching evidence.");
  }
  const payload = { ...rest, cohortId, expectedVersion: Number(rest.expectedVersion), sampleUnits: normalizedUnits.map(unit => ({
    permanentId: unit?.permanentId, unitType: unit?.unitType, latitude: unit?.latitude, longitude: unit?.longitude,
    condition: unit?.condition, heightMeters: unit?.heightMeters, diameterCentimeters: unit?.diameterCentimeters,
    remarks: unit?.remarks, captureDate: unit?.captureDate,
  })), evidenceManifest: manifest.map(entry => ({ source: entry?.source, sampleId: entry?.sampleId, captureSessionId: entry?.captureSessionId })) };
  return require("./evidenceWorkflow.service").runWorkflow({ actor: { uid: actorId }, workflow: "cohort-baseline",
    target: cohortId, key: idempotencyKey, payload, files },
  async operation => {
    // Validate before reserving an object, but inside the idempotency callback:
    // an acknowledged retry must resolve an already completed workflow even
    // though its expected baseline version is now stale.
    const cohort = await getVerifiedPlantingCohort(cohortId);
    const plan = cohort.samplingPlan;
    if (!plan || plan.status !== "APPROVED") throw conflict("An approved sampling plan is required before baseline registration.");
    if (Number(cohort.baselineVersion || 0) !== Number(rest.expectedVersion)) {
      throw conflict("This baseline changed while you were editing. Refresh and try again.");
    }
    const plannedIds = new Set(plan.selectedSamples.map(sample => sample.permanentId));
    if (submittedIds.length !== plannedIds.size || submittedIds.some(id => !plannedIds.has(id))) {
      throw new Error("Baseline samples must match the Admin-approved sampling plan. Replacements require a new approved plan.");
    }
    const sessions = await require("./evidenceCaptureSession.service").resolveSubmissionEvidence({ actorId,
      workflow: "cohort-baseline", binding: { cohortId, samplingPlanVersion: plan.version }, files, manifest });
    if (sessions.length !== files.length || manifest.length !== files.length) throw new Error("Baseline evidence does not match the submitted samples.");
    const bySample = new Map();
    for (let index = 0; index < sessions.length; index += 1) {
      const sampleId = String(manifest[index]?.sampleId || "").trim();
      if (!sampleId || bySample.has(sampleId)) throw new Error("Each baseline sample requires one distinct verified photo.");
      const session = sessions[index];
      const privateEvidence = await require("./evidenceWorkflow.service").workflow().upload(operation, index, files[index], {
        recordId: baselineEvidenceRecordId(cohortId, sampleId), evidenceType: "cohort-baseline", verification: {
          capturedAt: session.capturedAtClient?.toDate?.().toISOString?.() || null,
          latitude: session.latitude, longitude: session.longitude, gpsValid: session.insideAssignedSite === true,
          timestampValid: true, evidenceSource: "browser-camera", locationSource: "Browser Capture Session",
          locationAccuracyMeters: session.accuracyMeters, verificationPolicyVersion: session.verificationPolicyVersion || 1,
        },
      });
      bySample.set(sampleId, [{ evidenceId: session.id, capturedAt: session.capturedAtClient || null,
        imageSha256: session.imageSha256, contentType: session.contentType, sizeBytes: session.sizeBytes,
        latitude: session.latitude, longitude: session.longitude, accuracyMeters: session.accuracyMeters,
        distanceMeters: session.distanceMeters, boundaryRule: session.boundaryRule,
        verificationStatus: session.insideAssignedSite ? "VERIFIED" : "NEEDS_REVIEW", privateEvidence }]);
    }
    const enriched = normalizedUnits.map(unit => ({ ...unit, photoReferences: bySample.get(String(unit?.permanentId || "")) || [] }));
    return registerBaselineImpl({ cohortId, actorId, sampleUnits: enriched, workflowOperation: operation, captureEvidence: sessions, uploadedReferences: bySample, ...rest });
  }, link => getVerifiedPlantingCohort(link.cohortId));
}

async function registerBaseline(data) { return registerBaselineImpl(data); }

async function approveBaseline({ cohortId, actorId, expectedVersion, approve = true, remarks = "" }) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabledError();
  const ref = cohorts.doc(cohortId);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists) { const error = new Error("Verified planting cohort not found."); error.status = 404; throw error; }
    const current = doc.data();
    if (Number(current.baselineVersion || 0) !== Number(expectedVersion)) throw conflict("This baseline changed while you were editing. Refresh and try again.");
    if (!current.baseline || current.baseline.approvalStatus !== "PENDING_ADMIN_APPROVAL") throw conflict("Only a pending baseline can be reviewed.");
    const now = Timestamp.now();
    const baseline = { ...current.baseline, approvalStatus: approve ? "APPROVED" : "RETURNED", reviewedBy: actorId, reviewedAt: now, reviewRemarks: String(remarks || "").trim().slice(0, 1000) };
    const history = Array.isArray(current.baselineHistory) ? current.baselineHistory : [];
    transaction.update(ref, { baseline, baselineHistory: [...history, { version: current.baselineVersion, status: baseline.approvalStatus, reviewedBy: actorId, reviewedAt: now, reviewRemarks: baseline.reviewRemarks }], updatedAt: now });
  });
  return getVerifiedPlantingCohort(cohortId);
}

module.exports = {
  cohortIdFor,
  ensureCohortForAuthoritativeReportInTransaction,
  listVerifiedPlantingCohorts,
  getVerifiedPlantingCohort,
  saveSamplingPlan,
  approveSamplingPlan,
  registerBaseline,
  registerBaselineWithEvidence,
  approveBaseline,
  _test: { authoritativeQuantity, normalizeSampleUnits, provisionalTarget, normalizePlannedSamples, baselineEvidenceRecordId },
};
