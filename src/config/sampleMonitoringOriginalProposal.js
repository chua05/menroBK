// Local proposed-policy diagnostics only. This is not MENRO policy approval.
const { validateIntegrationEnvironment, LEGACY_MONITORING_ISOLATED_PROJECT_ID } = require("./integrationEnvironment");
const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
function requireOriginalProposal(env = process.env) {
  if (env.MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL === undefined || env.MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL === "false") {
    throw problem(404, "ORIGINAL_PROPOSAL_DISABLED", "Original-photo proposal testing is not enabled.");
  }
  try {
    if (env.MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL !== "true" || env.NODE_ENV !== "test" ||
        env.MENRO_INTEGRATION_TEST !== "true" || env.MENRO_SAMPLE_MONITORING_FORM_ACCEPTANCE !== "true" ||
        ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG", "FIREBASE_TOKEN", "GOOGLE_CLOUD_PROJECT"].some(key => env[key] !== undefined)) throw new Error();
    const state = validateIntegrationEnvironment(env);
    if (!state.legacyMonitoringIsolated || state.projectId !== LEGACY_MONITORING_ISOLATED_PROJECT_ID) throw new Error();
    return Object.freeze({ policyStatus: "PROPOSED_PENDING_MENRO_APPROVAL", linkingEnabled: true,
      accuracyPolicy: "UNKNOWN_REQUIRES_EXPLICIT_ADMIN_REVIEW", proposalVersion: "local-original-exif-review-v1" });
  } catch {
    throw problem(503, "ORIGINAL_PROPOSAL_ISOLATION_REQUIRED", "Original-photo proposal testing requires the complete credential-free isolated monitoring environment.");
  }
}
module.exports = { requireOriginalProposal };
