// Original-photo rules. The proposal mode is local diagnostics only and is not MENRO policy approval.
const { validateIntegrationEnvironment, LEGACY_MONITORING_ISOLATED_PROJECT_ID } = require("./integrationEnvironment");
const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
// PERMANENT_SAMPLE_ORIGINAL_PHOTO_ENABLED is the release switch for "Upload Existing Photo". Off unless exactly "true";
// MENRO must approve the original-photo rules before it is set. Every server check (EXIF GPS, capture date, site,
// duplicates, unknown accuracy with explicit Admin review) applies the same way.
function originalPhotosReleased(env = process.env) {
  const raw = env.PERMANENT_SAMPLE_ORIGINAL_PHOTO_ENABLED;
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw !== "true") throw problem(503, "ORIGINAL_PHOTO_CONFIGURATION_INVALID", "Original-photo configuration is invalid.");
  return true;
}
const originalPhotosConfigured = (env = process.env) => originalPhotosReleased(env) || env.MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL === "true";
function requireOriginalProposal(env = process.env) {
  if (originalPhotosReleased(env)) return Object.freeze({ policyStatus: "ENABLED_BY_MENRO_CONFIGURATION", linkingEnabled: true,
    accuracyPolicy: "UNKNOWN_REQUIRES_EXPLICIT_ADMIN_REVIEW", proposalVersion: "original-exif-review-v1" });
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
module.exports = { requireOriginalProposal, originalPhotosConfigured };
