const {
  getVerifiedPlantingCohort,
  registerBaseline,
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
    return res.status(200).json({ success: true, data: await getVerifiedPlantingCohort(req.params.id) });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
}

async function saveBaseline(req, res) {
  try {
    if (gate(res)) return;
    const data = await registerBaseline({ cohortId: req.params.id, actorId: req.user.uid, ...req.body });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
}

module.exports = { getCohort, saveBaseline };
