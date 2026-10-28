const os = require("node:os");
const path = require("node:path");

const DEMO_PROJECT_ID = "demo-menro-phase2";
const FIRESTORE_HOST = "127.0.0.1:8080";
const MPDO_FIRESTORE_HOST = "127.0.0.1:8180";
const REQUEST_LETTER_FIRESTORE_HOST = "127.0.0.1:8181";
const AUTH_HOST = "127.0.0.1:9099";
const STORAGE_HOST = "127.0.0.1:9199";
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

function validateIntegrationEnvironment(env = process.env) {
  const integration = enabled(env);
  const hasEmulatorSetting = Boolean(env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST ||
    env.FIREBASE_STORAGE_EMULATOR_HOST !== undefined);
  if (!integration) {
    if (hasEmulatorSetting) {
      throw new Error("Firebase emulator hosts require MENRO_INTEGRATION_TEST=true.");
    }
    return { integration: false };
  }
  if (env.NODE_ENV === "production") throw new Error("Integration testing is disabled in production mode.");
  if (env.GCLOUD_PROJECT !== DEMO_PROJECT_ID || env.FIREBASE_PROJECT_ID !== DEMO_PROJECT_ID) {
    throw new Error(`Integration testing requires project ${DEMO_PROJECT_ID}.`);
  }
  const mpdoAcceptance = mpdoAcceptanceEnabled(env);
  const requestLetterAcceptance = requestLetterAcceptanceEnabled(env);
  if (mpdoAcceptance && requestLetterAcceptance) throw new Error("Integration acceptance gates cannot be combined.");
  if (env.MENRO_REQUEST_LETTER_ACCEPTANCE !== undefined && !requestLetterAcceptance) {
    throw new Error("MENRO_REQUEST_LETTER_ACCEPTANCE must be exactly true when supplied.");
  }
  if (env.MENRO_MPDO_BOUNDARY_ACCEPTANCE !== undefined && !mpdoAcceptance) {
    throw new Error("MENRO_MPDO_BOUNDARY_ACCEPTANCE must be exactly true when supplied.");
  }
  if (mpdoAcceptance && env.MENRO_TEST_BOUNDARY_SOURCE !== "mpdo-candidate") {
    throw new Error("MPDO boundary acceptance requires the inactive MPDO candidate source.");
  }
  if (!mpdoAcceptance && env.MENRO_TEST_BOUNDARY_SOURCE === "mpdo-candidate") {
    throw new Error("The MPDO candidate requires the explicit MPDO acceptance gate in integration mode.");
  }
  const requiredFirestoreHost = requestLetterAcceptance
    ? REQUEST_LETTER_FIRESTORE_HOST
    : mpdoAcceptance ? MPDO_FIRESTORE_HOST : FIRESTORE_HOST;
  if (env.FIRESTORE_EMULATOR_HOST !== requiredFirestoreHost || env.FIREBASE_AUTH_EMULATOR_HOST !== AUTH_HOST) {
    throw new Error("Integration testing requires the approved loopback Firestore and Auth emulator hosts.");
  }
  const hasStorageHost = env.FIREBASE_STORAGE_EMULATOR_HOST !== undefined;
  const hasStorageBucket = env.FIREBASE_STORAGE_BUCKET !== undefined;
  if (hasStorageHost || hasStorageBucket) {
    if (env.FIREBASE_STORAGE_EMULATOR_HOST !== STORAGE_HOST) {
      throw new Error("Storage integration testing requires the approved loopback Storage emulator host.");
    }
    if (env.FIREBASE_STORAGE_BUCKET !== STORAGE_BUCKET) {
      throw new Error("Storage integration testing requires the synthetic demo Storage bucket.");
    }
  }
  return { integration: true, projectId: DEMO_PROJECT_ID, mpdoAcceptance, requestLetterAcceptance };
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
  AUTH_HOST, DEMO_PROJECT_ID, FIRESTORE_HOST, MPDO_FIRESTORE_HOST, REQUEST_LETTER_FIRESTORE_HOST,
  STORAGE_HOST, STORAGE_BUCKET, enabled, mpdoAcceptanceEnabled, requestLetterAcceptanceEnabled,
  resolveUploadRoot, validateIntegrationEnvironment,
};
