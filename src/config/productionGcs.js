// Production evidence storage is a separate, fail-closed path. Merely setting
// the provider or bucket never enables it; activation is an explicit deployment
// decision after the readiness checklist and backup gates have been approved.
const PRODUCTION_TARGET = Object.freeze({
  projectId: "menrosystem-ddfac",
  bucket: "menrosystem-ddfac.firebasestorage.app",
  serviceAccountEmail: "firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com",
});

const PRODUCTION_FIELDS = [
  "EVIDENCE_GCS_PRODUCTION_APPROVAL",
];

function resolveProductionGcs(env = process.env) {
  const flag = env.MENRO_GCS_PRODUCTION;
  if (flag === undefined || flag === "false") {
    if (PRODUCTION_FIELDS.some(key => env[key] !== undefined)) {
      throw new Error("Inactive production GCS configuration must not contain activation settings.");
    }
    return null;
  }
  if (flag !== "true" || env.NODE_ENV !== "production" || env.MENRO_GCS_DEVELOPMENT !== undefined ||
      env.MENRO_INTEGRATION_TEST !== undefined ||
      ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST",
        "STORAGE_EMULATOR_HOST", "MENRO_HISTORICAL_MIGRATION", "GOOGLE_APPLICATION_CREDENTIALS"]
        .some(key => env[key] !== undefined)) {
    throw new Error("Production GCS requires an isolated production runtime with no emulator, migration, or ADC selectors.");
  }
  if (env.FIREBASE_PROJECT_ID !== PRODUCTION_TARGET.projectId ||
      env.FIREBASE_STORAGE_BUCKET !== PRODUCTION_TARGET.bucket ||
      env.FIREBASE_CLIENT_EMAIL !== PRODUCTION_TARGET.serviceAccountEmail ||
      !env.FIREBASE_PRIVATE_KEY ||
      env.EVIDENCE_GCS_PRODUCTION_APPROVAL !== "AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION") {
    throw new Error("Production GCS target, runtime identity, credentials, or activation approval is invalid.");
  }
  return Object.freeze({ ...PRODUCTION_TARGET, prefix: "menro-production/" });
}

module.exports = { PRODUCTION_TARGET, resolveProductionGcs };
