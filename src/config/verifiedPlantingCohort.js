const isEnabled = (env = process.env) => String(
  env.VERIFIED_PLANTING_COHORT_ENABLED || ""
).trim().toLowerCase() === "true";

function resolveVerifiedPlantingCohortConfig(env = process.env) {
  return Object.freeze({
    enabled: isEnabled(env),
    schemaVersion: 1,
    samplingWorkflowEnabled: false,
    // This calculation is intentionally limited to isolated Phase 2 testing.
    // It is stored with each plan so a later MENRO policy can supersede it
    // without reinterpreting an already-reviewed record.
    provisionalSamplingPolicy: "test-only-ceil-10-percent-min-1-v1",
    // The provisional rule is never a MENRO policy: outside isolated tests a cohort must carry an
    // Admin-approved purpose-policy snapshot before a sampling plan can be saved or approved.
    provisionalSamplingAllowed: String(env.NODE_ENV || "") === "test",
  });
}

module.exports = { resolveVerifiedPlantingCohortConfig };
