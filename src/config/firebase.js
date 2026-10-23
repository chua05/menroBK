const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const { validateIntegrationEnvironment } = require("./integrationEnvironment");
const { resolveEvidenceStorageConfig } = require("./evidenceStorage");

if (process.env.MENRO_GCS_DEVELOPMENT !== "true") require("dotenv").config();

let credential;
const integration = validateIntegrationEnvironment();
const evidenceStorage = resolveEvidenceStorageConfig();

if (integration.integration) {
  console.log(`[firebase] Emulator integration mode enabled for ${integration.projectId}.`);
} else if (process.env.NODE_ENV === "production") {
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } = process.env;

  const missingVariables = [];

  if (!FIREBASE_PROJECT_ID) {
    missingVariables.push("FIREBASE_PROJECT_ID");
  }

  if (!FIREBASE_CLIENT_EMAIL) {
    missingVariables.push("FIREBASE_CLIENT_EMAIL");
  }

  if (!FIREBASE_PRIVATE_KEY) {
    missingVariables.push("FIREBASE_PRIVATE_KEY");
  }

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing Firebase environment variables: ${missingVariables.join(", ")}`
    );
  }

  credential = cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });
} else {
  const serviceAccountPath = path.join(
    process.cwd(),
    "serviceAccountKey.json"
  );

  const serviceAccount = require(serviceAccountPath);

  credential = cert(serviceAccount);
}

const app = initializeApp(integration.integration
  ? { projectId: integration.projectId, ...(evidenceStorage.storageEmulator ? { storageBucket: evidenceStorage.bucket } : {}) }
  : { credential, ...(evidenceStorage.bucket ? { storageBucket: evidenceStorage.bucket } : {}) });

const db = getFirestore(app);
const auth = getAuth(app);

// Phase 1 exposes a client handle for isolated SDK checks only. No object I/O.
// Production cloud access stays unavailable until the private adapter is approved.
function getStorageBucket() {
  const current = resolveEvidenceStorageConfig();
  if (current.gcsDevelopment && evidenceStorage.gcsDevelopment && current.cloudRead &&
      current.bucket === evidenceStorage.bucket) {
    return require('../services/developmentGcs.service').getDevelopmentStorageBucket();
  }
  if (current.gcsProduction && evidenceStorage.gcsProduction && current.cloudRead &&
      current.bucket === evidenceStorage.bucket &&
      current.gcsProduction.serviceAccountEmail === evidenceStorage.gcsProduction.serviceAccountEmail) {
    const { getStorage } = require("firebase-admin/storage");
    return getStorage(app).bucket(current.bucket);
  }
  if (!current.storageEmulator || !evidenceStorage.storageEmulator ||
      current.bucket !== evidenceStorage.bucket) {
    throw new Error("Storage client access is restricted to the configured demo emulator in Phase 1.");
  }
  const { getStorage } = require("firebase-admin/storage");
  return getStorage(app).bucket(current.bucket);
}

module.exports = {
  app,
  db,
  auth,
  getStorageBucket,
};
