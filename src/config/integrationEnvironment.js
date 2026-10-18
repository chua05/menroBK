const os = require("node:os");
const path = require("node:path");

const DEMO_PROJECT_ID = "demo-menro-phase2";
const FIRESTORE_HOST = "127.0.0.1:8080";
const AUTH_HOST = "127.0.0.1:9099";

function enabled(env = process.env) {
  return String(env.MENRO_INTEGRATION_TEST || "").toLowerCase() === "true";
}

function validateIntegrationEnvironment(env = process.env) {
  const integration = enabled(env);
  const hasEmulatorSetting = Boolean(env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST);
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
  if (env.FIRESTORE_EMULATOR_HOST !== FIRESTORE_HOST || env.FIREBASE_AUTH_EMULATOR_HOST !== AUTH_HOST) {
    throw new Error("Integration testing requires the approved loopback Firestore and Auth emulator hosts.");
  }
  return { integration: true, projectId: DEMO_PROJECT_ID };
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
  AUTH_HOST, DEMO_PROJECT_ID, FIRESTORE_HOST, enabled,
  resolveUploadRoot, validateIntegrationEnvironment,
};
