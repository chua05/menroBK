const {
  listVerifiedPlantingCohorts,
  getVerifiedPlantingCohort,
  saveSamplingPlan: saveSamplingPlanRecord,
  approveSamplingPlan: approveSamplingPlanRecord,
  registerBaselineWithEvidence,
  approveBaseline: approveBaselineRecord,
} = require("../services/verifiedPlantingCohort.service");
const { resolveVerifiedPlantingCohortConfig } = require("../config/verifiedPlantingCohort");

function gate(res) {
  if (resolveVerifiedPlantingCohortConfig().enabled) return false;
  res.status(409).json({ success: false, code: "COHORT_WORKFLOW_DISABLED", message: "Verified planting cohort workflow is disabled." });
  return true;
}

async function getCohort(req, res) {
  try {
    if (gate(res)) return;
    return res.status(200).json({ success: true, data: await getVerifiedPlantingCohort(req.params.id, { actorId: req.user.uid }) });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
}

async function listCohorts(req, res) {
  try {
    if (gate(res)) return;
    return res.status(200).json({ success: true, data: await listVerifiedPlantingCohorts({ actorId: req.user.uid }) });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
}

async function saveSamplingPlan(req, res) {
  try {
    if (gate(res)) return;
    return res.status(200).json({ success: true, data: await saveSamplingPlanRecord({ expectedVersion: req.body?.expectedVersion,
      selectionMethod: req.body?.selectionMethod, selectedSamples: req.body?.selectedSamples, speciesSiteDistribution: req.body?.speciesSiteDistribution,
      notes: req.body?.notes, submitForApproval: req.body?.submitForApproval, cohortId: req.params.id, actorId: req.user.uid }) });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
}

async function approveSamplingPlan(req, res) {
  try {
    if (gate(res)) return;
    return res.status(200).json({ success: true, data: await approveSamplingPlanRecord({ expectedVersion: req.body?.expectedVersion,
      approve: req.body?.approve, remarks: req.body?.remarks, cohortId: req.params.id, actorId: req.user.uid }) });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
}

async function saveBaseline(req, res) {
  try {
    if (gate(res)) return;
    const parse = (value, fallback) => {
      if (value === undefined) return fallback;
      if (typeof value !== "string") return value;
      try { return JSON.parse(value); } catch { const error = new Error("Baseline submission data is invalid."); error.status = 400; throw error; }
    };
    const data = await registerBaselineWithEvidence({ cohortId: req.params.id, actorId: req.user.uid,
      expectedVersion: req.body?.expectedVersion, status: req.body?.status,
      sampleUnits: parse(req.body?.sampleUnits, []), evidenceManifest: parse(req.body?.evidenceManifest, []),
      files: req.files || [], idempotencyKey: req.get("Idempotency-Key") });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
}

async function approveBaseline(req, res) {
  try {
    if (gate(res)) return;
    return res.status(200).json({ success: true, data: await approveBaselineRecord({ expectedVersion: req.body?.expectedVersion,
      approve: req.body?.approve, remarks: req.body?.remarks, cohortId: req.params.id, actorId: req.user.uid }) });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
}

module.exports = { listCohorts, getCohort, saveSamplingPlan, approveSamplingPlan, saveBaseline, approveBaseline };
