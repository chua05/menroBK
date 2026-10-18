const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const { validateIntegrationEnvironment } = require("./integrationEnvironment");

require("dotenv").config();

let credential;
const integration = validateIntegrationEnvironment();

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
  ? { projectId: integration.projectId }
  : { credential });

const db = getFirestore(app);
const auth = getAuth(app);

module.exports = {
  app,
  db,
  auth,
};
