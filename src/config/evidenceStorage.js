const { validateIntegrationEnvironment } = require("./integrationEnvironment");
const { resolveDevelopmentGcs } = require("./developmentGcs");
const { resolveProductionGcs } = require("./productionGcs");

const PRODUCTION_BUCKET = "menrosystem-ddfac.firebasestorage.app";
const PRODUCTION_PROJECT = "menrosystem-ddfac";

function resolveEvidenceStorageConfig(env = process.env) {
  const integration = validateIntegrationEnvironment(env);
  const development = resolveDevelopmentGcs(env);
  const production = resolveProductionGcs(env);
  const provider = env.EVIDENCE_STORAGE_PROVIDER === undefined ? "local" : env.EVIDENCE_STORAGE_PROVIDER;
  const flag = env.EVIDENCE_CLOUD_WORKFLOW_ENABLED;
  if (flag !== undefined && !["true", "false"].includes(flag)) throw new Error("Invalid evidence workflow gate.");
  const cloudWorkflow = flag === "true";
  const readFlag = env.EVIDENCE_CLOUD_READ_ENABLED;
  if (readFlag !== undefined && !["true", "false"].includes(readFlag)) throw new Error("Invalid evidence read gate.");
  if (cloudWorkflow && readFlag === "false") throw new Error("Cloud evidence uploads require cloud reads.");
  // Existing write-enabled demo workflows retain their read capability. Read-only
  // rollback requires its OWN explicit flag; selecting local never enables reads.
  const cloudRead = cloudWorkflow || readFlag === "true";
  if (development && (cloudWorkflow && provider !== "gcs" || !cloudRead)) throw new Error("Development GCS requires explicit write/read gates.");
  if (production) {
    const writeMode = provider === "gcs" && cloudWorkflow && cloudRead;
    const readPreservingRollback = provider === "local" && !cloudWorkflow && cloudRead;
    if (!writeMode && !readPreservingRollback) {
      throw new Error("Production GCS requires explicit write/read gates or the exact read-preserving rollback mode.");
    }
  }
  if (!development && !production && cloudWorkflow && (provider !== "firebase" || !integration.integration ||
      !env.FIREBASE_STORAGE_EMULATOR_HOST ||
      (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT !== "demo-menro-phase2") ||
      ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]
        .some(key => env[key] !== undefined))) throw new Error("Cloud evidence workflows require credential-free demo emulators.");
  if (!development && !production && cloudRead && (!integration.integration || !env.FIREBASE_STORAGE_EMULATOR_HOST ||
      (env.STORAGE_EMULATOR_HOST !== undefined && env.STORAGE_EMULATOR_HOST !== "http://127.0.0.1:9199") ||
      (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT !== "demo-menro-phase2") ||
      ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]
        .some(key => env[key] !== undefined))) throw new Error("Cloud evidence reads require credential-free demo emulators.");
  if (provider === "firebase" && !cloudWorkflow && !cloudRead) {
    throw new Error("The firebase evidence provider is unavailable in Phase 1; use local until the private adapter is approved.");
  }
  if (provider === "gcs" && !development && !production) throw new Error("GCS requires an explicit approved development or production configuration.");
  if (development && provider === "firebase") throw new Error("Do not mix development GCS and the Storage emulator provider.");
  if (!["local", "firebase", "gcs"].includes(provider)) {
    throw new Error("EVIDENCE_STORAGE_PROVIDER must be local in Phase 1.");
  }
  const bucket = development?.bucket || production?.bucket || env.FIREBASE_STORAGE_BUCKET;
  if (!integration.integration && bucket !== undefined) {
    // Explicit bare bucket name only: no gs://, URLs, paths, credentials or fallback.
    if (bucket !== PRODUCTION_BUCKET) {
      throw new Error("FIREBASE_STORAGE_BUCKET does not match the approved MENRO bucket.");
    }
    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_PROJECT_ID !== PRODUCTION_PROJECT) {
      throw new Error("Firebase project and Storage bucket configuration do not match.");
    }
  }
  return Object.freeze({ provider, ...(cloudWorkflow ? { cloudWorkflow: true } : {}), ...(cloudRead ? { cloudRead: true } : {}), bucket: bucket || null,
    ...(development ? { gcsDevelopment: development } : {}),
    ...(production ? { gcsProduction: production } : {}),
    storageEmulator: integration.integration && Boolean(env.FIREBASE_STORAGE_EMULATOR_HOST) });
}

module.exports = { resolveEvidenceStorageConfig };
