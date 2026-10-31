const isEnabled = (env = process.env) => String(
  env.VERIFIED_PLANTING_COHORT_ENABLED || ""
).trim().toLowerCase() === "true";

function resolveVerifiedPlantingCohortConfig(env = process.env) {
  return Object.freeze({
    enabled: isEnabled(env),
    schemaVersion: 1,
    samplingWorkflowEnabled: false,
  });
}

module.exports = { resolveVerifiedPlantingCohortConfig };
