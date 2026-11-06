const os = require("node:os");
const path = require("node:path");

const DEMO_PROJECT_ID = "demo-menro-phase2";
const PHASE3C_ISOLATED_PROJECT_ID = "demo-menro-phase3c-isolated";
const PHASE3C_ISOLATED_STORAGE_BUCKET = "demo-menro-phase3c-isolated.firebasestorage.app";
const FIRESTORE_HOST = "127.0.0.1:8080";
const MPDO_FIRESTORE_HOST = "127.0.0.1:8180";
const REQUEST_LETTER_FIRESTORE_HOST = "127.0.0.1:8181";
const BASELINE_EVIDENCE_FIRESTORE_HOST = "127.0.0.1:8181";
const AUTH_HOST = "127.0.0.1:9099";
const STORAGE_HOST = "127.0.0.1:9199";
const PHASE3C_ISOLATED_FIRESTORE_HOST = "127.0.0.1:8281";
const PHASE3C_ISOLATED_AUTH_HOST = "127.0.0.1:9299";
const PHASE3C_ISOLATED_STORAGE_HOST = "127.0.0.1:9298";
const LEGACY_MONITORING_ISOLATED_PROJECT_ID = "demo-menro-legacy-monitoring-20261106";
const LEGACY_MONITORING_ISOLATED_STORAGE_BUCKET = "demo-menro-legacy-monitoring-20261106.firebasestorage.app";
const LEGACY_MONITORING_ISOLATED_FIRESTORE_HOST = "127.0.0.1:8381";
const LEGACY_MONITORING_ISOLATED_AUTH_HOST = "127.0.0.1:9399";
const LEGACY_MONITORING_ISOLATED_STORAGE_HOST = "127.0.0.1:9398";
const STORAGE_BUCKET = "demo-menro-phase2.firebasestorage.app";

function enabled(env = process.env) {
  return String(env.MENRO_INTEGRATION_TEST || "").toLowerCase() === "true";
}

function mpdoAcceptanceEnabled(env = process.env) {
  return String(env.MENRO_MPDO_BOUNDARY_ACCEPTANCE || "").toLowerCase() === "true";
}

function requestLetterAcceptanceEnabled(env = process.env) {
  return String(env.MENRO_REQUEST_LETTER_ACCEPTANCE || "").toLowerCase() === "true";
}

function baselineEvidenceAcceptanceEnabled(env = process.env) {
  return String(env.MENRO_BASELINE_EVIDENCE_ACCEPTANCE || "").toLowerCase() === "true";
}

function validateIntegrationEnvironment(env = process.env) {
  const integration = enabled(env);
  const hasEmulatorSetting = Boolean(env.MENRO_PHASE3C_ISOLATED_EMULATORS === "true" || env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST ||
    env.FIREBASE_STORAGE_EMULATOR_HOST !== undefined || env.MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS !== undefined);
  if (!integration) {
    if (hasEmulatorSetting) {
      throw new Error("Firebase emulator hosts require MENRO_INTEGRATION_TEST=true.");
    }
    return { integration: false };
  }
  if (env.NODE_ENV === "production") throw new Error("Integration testing is disabled in production mode.");
  const mpdoAcceptance = mpdoAcceptanceEnabled(env);
  const requestLetterAcceptance = requestLetterAcceptanceEnabled(env);
  const baselineEvidenceAcceptance = baselineEvidenceAcceptanceEnabled(env);
  const phase3cIsolated = env.MENRO_PHASE3C_ISOLATED_EMULATORS === "true";
  const legacyMonitoringIsolated = env.MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS === "true";
  if (phase3cIsolated && legacyMonitoringIsolated) throw new Error("Isolated emulator topologies cannot be combined.");
  if ((phase3cIsolated || legacyMonitoringIsolated) && (env.NODE_ENV !== "test" ||
      ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]
        .some(key => env[key] !== undefined))) {
    throw new Error("Isolated emulators require credential-free test mode.");
  }
  const requiredProject = legacyMonitoringIsolated ? LEGACY_MONITORING_ISOLATED_PROJECT_ID
    : phase3cIsolated ? PHASE3C_ISOLATED_PROJECT_ID : DEMO_PROJECT_ID;
  if (env.GCLOUD_PROJECT !== requiredProject || env.FIREBASE_PROJECT_ID !== requiredProject) throw new Error(`Integration testing requires project ${requiredProject}.`);
  if (env.MENRO_PHASE3C_ISOLATED_EMULATORS !== undefined && !phase3cIsolated) throw new Error("MENRO_PHASE3C_ISOLATED_EMULATORS must be exactly true when supplied.");
  if (env.MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS !== undefined && !legacyMonitoringIsolated) throw new Error("MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS must be exactly true when supplied.");
  if ([mpdoAcceptance, requestLetterAcceptance, baselineEvidenceAcceptance].filter(Boolean).length > 1) {
    throw new Error("Integration acceptance gates cannot be combined.");
  }
  if (env.MENRO_REQUEST_LETTER_ACCEPTANCE !== undefined && !requestLetterAcceptance) {
    throw new Error("MENRO_REQUEST_LETTER_ACCEPTANCE must be exactly true when supplied.");
  }
  if (env.MENRO_MPDO_BOUNDARY_ACCEPTANCE !== undefined && !mpdoAcceptance) {
    throw new Error("MENRO_MPDO_BOUNDARY_ACCEPTANCE must be exactly true when supplied.");
  }
  if (env.MENRO_BASELINE_EVIDENCE_ACCEPTANCE !== undefined && !baselineEvidenceAcceptance) {
    throw new Error("MENRO_BASELINE_EVIDENCE_ACCEPTANCE must be exactly true when supplied.");
  }
  if (mpdoAcceptance && env.MENRO_TEST_BOUNDARY_SOURCE !== "mpdo-candidate") {
    throw new Error("MPDO boundary acceptance requires the inactive MPDO candidate source.");
  }
  if (!mpdoAcceptance && env.MENRO_TEST_BOUNDARY_SOURCE === "mpdo-candidate") {
    throw new Error("The MPDO candidate requires the explicit MPDO acceptance gate in integration mode.");
  }
  const requiredFirestoreHost = legacyMonitoringIsolated ? LEGACY_MONITORING_ISOLATED_FIRESTORE_HOST
    : phase3cIsolated ? PHASE3C_ISOLATED_FIRESTORE_HOST : baselineEvidenceAcceptance ? BASELINE_EVIDENCE_FIRESTORE_HOST : requestLetterAcceptance
    ? REQUEST_LETTER_FIRESTORE_HOST
    : mpdoAcceptance ? MPDO_FIRESTORE_HOST : FIRESTORE_HOST;
  const requiredAuthHost = legacyMonitoringIsolated ? LEGACY_MONITORING_ISOLATED_AUTH_HOST
    : phase3cIsolated ? PHASE3C_ISOLATED_AUTH_HOST : AUTH_HOST;
  const requiredStorageHost = legacyMonitoringIsolated ? LEGACY_MONITORING_ISOLATED_STORAGE_HOST
    : phase3cIsolated ? PHASE3C_ISOLATED_STORAGE_HOST : STORAGE_HOST;
  const requiredStorageBucket = legacyMonitoringIsolated ? LEGACY_MONITORING_ISOLATED_STORAGE_BUCKET
    : phase3cIsolated ? PHASE3C_ISOLATED_STORAGE_BUCKET : STORAGE_BUCKET;
  if (env.FIRESTORE_EMULATOR_HOST !== requiredFirestoreHost || env.FIREBASE_AUTH_EMULATOR_HOST !== requiredAuthHost) {
    throw new Error("Integration testing requires the approved loopback Firestore and Auth emulator hosts.");
  }
  const hasStorageHost = env.FIREBASE_STORAGE_EMULATOR_HOST !== undefined;
  const hasStorageBucket = env.FIREBASE_STORAGE_BUCKET !== undefined;
  if (phase3cIsolated || legacyMonitoringIsolated || hasStorageHost || hasStorageBucket) {
    if (env.FIREBASE_STORAGE_EMULATOR_HOST !== requiredStorageHost) {
      throw new Error("Storage integration testing requires the approved loopback Storage emulator host.");
    }
    if (env.FIREBASE_STORAGE_BUCKET !== requiredStorageBucket) {
      throw new Error("Storage integration testing requires the synthetic demo Storage bucket.");
    }
  }
  return { integration: true, projectId: requiredProject, mpdoAcceptance, requestLetterAcceptance,
    baselineEvidenceAcceptance, phase3cIsolated, legacyMonitoringIsolated };
}

function resolveUploadRoot(env = process.env, cwd = process.cwd()) {
  const state = validateIntegrationEnvironment(env);
  const normalRoot = path.resolve(cwd, "uploads");
  if (!state.integration) return normalRoot;
  if (!env.MENRO_UPLOAD_ROOT) throw new Error("MENRO_UPLOAD_ROOT is required in integration mode.");
  const root = path.resolve(env.MENRO_UPLOAD_ROOT);
  const tempRoot = path.resolve(os.tmpdir());
  if (root === normalRoot || root.startsWith(`${normalRoot}${path.sep}`) ||
      root === tempRoot || !root.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error("MENRO_UPLOAD_ROOT must be a dedicated directory beneath the system temporary directory.");
  }
  return root;
}

module.exports = {
  AUTH_HOST, DEMO_PROJECT_ID, PHASE3C_ISOLATED_PROJECT_ID, PHASE3C_ISOLATED_STORAGE_BUCKET, FIRESTORE_HOST, MPDO_FIRESTORE_HOST, REQUEST_LETTER_FIRESTORE_HOST, BASELINE_EVIDENCE_FIRESTORE_HOST,
  STORAGE_HOST, STORAGE_BUCKET, PHASE3C_ISOLATED_FIRESTORE_HOST, PHASE3C_ISOLATED_AUTH_HOST, PHASE3C_ISOLATED_STORAGE_HOST, enabled, mpdoAcceptanceEnabled, requestLetterAcceptanceEnabled, baselineEvidenceAcceptanceEnabled,
  LEGACY_MONITORING_ISOLATED_PROJECT_ID, LEGACY_MONITORING_ISOLATED_STORAGE_BUCKET,
  LEGACY_MONITORING_ISOLATED_FIRESTORE_HOST, LEGACY_MONITORING_ISOLATED_AUTH_HOST,
  LEGACY_MONITORING_ISOLATED_STORAGE_HOST,
  resolveUploadRoot, validateIntegrationEnvironment,
};
