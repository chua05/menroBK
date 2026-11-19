// READ-ONLY Monitoring Lifecycle preflight for Google Cloud Shell, using the operator's own Application
// Default Credentials (ADC). Separate from the backend's production Firebase initialization
// (src/config/firebase.js is never loaded here) and never uses a service-account key.
//
// Order (each step must pass before the next; Firestore is initialized only after steps 1-5):
//   1. Arguments: exactly --expected-project=menrosystem-ddfac and --expected-principal=<operator email>.
//   2. Environment: production mode declared for the expected project; no emulator, test, key-file or
//      service-account-key settings; any ambient project setting must match.
//   3. Identity: ADC resolves to the expected project and to the expected principal (tokeninfo).
//   4. Permissions: the principal holds Firestore read permissions on the project (testIamPermissions).
//   5. Database: projects/<project>/databases/(default) exists and is Firestore Native.
//   6. Preflight: the approved two-report plan (monitoringLifecycleBackfill.service) inside a Firestore
//      read-only transaction. No document, record, counter or policy is created or changed.
//
// Usage (Cloud Shell, after `gcloud config set project menrosystem-ddfac`):
//   NODE_ENV=production FIREBASE_PROJECT_ID=menrosystem-ddfac \
//     node scripts/cloudShellMonitoringPreflight.js --expected-project=menrosystem-ddfac --expected-principal=<you@example.com>
const { PRODUCTION_PROJECT, createMonitoringLifecycleBackfill } = require("../src/services/monitoringLifecycleBackfill.service");
const policy = require("../src/services/monitoringLifecyclePolicy");
const { lifecycleId } = require("../src/utils/monitoringLifecycleId.util");

const DATABASE_ID = "(default)";
const REQUIRED_READ_PERMISSIONS = Object.freeze(["datastore.databases.getMetadata", "datastore.entities.get", "datastore.entities.list"]);
// Reported only; the script performs no writes whatever the principal may hold.
const WRITE_PERMISSIONS = Object.freeze(["datastore.entities.create", "datastore.entities.update", "datastore.entities.delete"]);
const FORBIDDEN_ENV = Object.freeze(["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST",
  "FIREBASE_DATABASE_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]);
const AMBIENT_PROJECT_ENV = Object.freeze(["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT"]);
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

class PreflightStop extends Error {
  constructor(step, message) { super(`[${step}] ${message}`); this.step = step; }
}

function parseCloudShellArguments(args) {
  const values = {};
  for (const arg of args) {
    const match = /^--(expected-project|expected-principal)=(.+)$/.exec(arg);
    if (!match || values[match[1]] !== undefined) throw new PreflightStop("arguments", "Only --expected-project and --expected-principal are accepted, once each; write, apply and target options are rejected.");
    values[match[1]] = match[2];
  }
  if (values["expected-project"] !== PRODUCTION_PROJECT) throw new PreflightStop("arguments", `--expected-project must be exactly ${PRODUCTION_PROJECT}.`);
  if (!EMAIL.test(values["expected-principal"] || "")) throw new PreflightStop("arguments", "--expected-principal must be the operator's Google account email.");
  return { expectedProject: PRODUCTION_PROJECT, expectedPrincipal: values["expected-principal"].toLowerCase() };
}

function assertEnvironment(env, expectedProject) {
  const forbidden = FORBIDDEN_ENV.filter(key => env[key] !== undefined && env[key] !== "");
  const menro = Object.keys(env).filter(key => key.startsWith("MENRO_") || /EMULATOR/.test(key));
  if (forbidden.length || menro.length) {
    throw new PreflightStop("environment", `Unset emulator, test, key-file or service-account settings first: ${[...new Set([...forbidden, ...menro])].sort().join(", ")}.`);
  }
  if (env.NODE_ENV !== "production" || env.FIREBASE_PROJECT_ID !== expectedProject) {
    throw new PreflightStop("environment", `Declare NODE_ENV=production and FIREBASE_PROJECT_ID=${expectedProject} for this command.`);
  }
  const mismatched = AMBIENT_PROJECT_ENV.filter(key => env[key] !== undefined && env[key] !== "" && env[key] !== expectedProject);
  if (mismatched.length) throw new PreflightStop("environment", `Ambient project settings point elsewhere: ${mismatched.join(", ")}. Run: gcloud config set project ${expectedProject}`);
}

async function readJson(request, step, method, url, options) {
  let response;
  try { response = await request(method, url, options); }
  catch (error) { throw new PreflightStop(step, `Request failed: ${error.message}`); }
  if (response.status < 200 || response.status >= 300) {
    const detail = response.json?.error?.message || response.json?.error_description || response.json?.error || `HTTP ${response.status}`;
    throw new PreflightStop(step, `Could not be verified (${typeof detail === "string" ? detail : `HTTP ${response.status}`}).`);
  }
  return response.json || {};
}

/**
 * @param {object} deps
 * @param {string[]} deps.argv            CLI arguments
 * @param {object} deps.env               environment (process.env)
 * @param {{getProjectId:Function, getAccessToken:Function}} deps.auth  ADC (google-auth-library GoogleAuth)
 * @param {Function} deps.request         (method, url, {token, json, form}) => {status, json}
 * @param {Function} deps.initFirestore   ({projectId}) => {db, app}; called only after every check passes
 */
async function runCloudShellPreflight({ argv, env, auth, request, initFirestore, now = () => new Date() }) {
  const { expectedProject, expectedPrincipal } = parseCloudShellArguments(argv);
  assertEnvironment(env, expectedProject);

  let adcProject, token;
  try { adcProject = await auth.getProjectId(); token = await auth.getAccessToken(); }
  catch (error) { throw new PreflightStop("identity", `Application Default Credentials are unavailable (${error.message}). In Cloud Shell, sign in as yourself; never use a key file.`); }
  if (adcProject !== expectedProject) throw new PreflightStop("identity", `ADC resolves to project ${adcProject || "(none)"}, not ${expectedProject}.`);
  if (!token) throw new PreflightStop("identity", "ADC returned no access token.");
  const tokenInfo = await readJson(request, "identity", "POST", "https://oauth2.googleapis.com/tokeninfo", { form: { access_token: token } });
  const principal = String(tokenInfo.email || "").toLowerCase();
  if (!principal) throw new PreflightStop("identity", "The ADC principal has no verifiable email (token lacks the userinfo.email scope).");
  if (String(tokenInfo.email_verified) !== "true") throw new PreflightStop("identity", "The ADC principal email is not verified.");
  if (principal !== expectedPrincipal) throw new PreflightStop("identity", `ADC principal ${principal} does not match --expected-principal.`);

  const permissions = new Set((await readJson(request, "permissions", "POST",
    `https://cloudresourcemanager.googleapis.com/v1/projects/${expectedProject}:testIamPermissions`,
    { token, json: { permissions: [...REQUIRED_READ_PERMISSIONS, ...WRITE_PERMISSIONS] } })).permissions || []);
  const missing = REQUIRED_READ_PERMISSIONS.filter(permission => !permissions.has(permission));
  if (missing.length) throw new PreflightStop("permissions", `Principal lacks required read permissions: ${missing.join(", ")}.`);

  const database = await readJson(request, "database", "GET",
    `https://firestore.googleapis.com/v1/projects/${expectedProject}/databases/${encodeURIComponent(DATABASE_ID)}`, { token });
  if (database.name !== `projects/${expectedProject}/databases/${DATABASE_ID}`) throw new PreflightStop("database", "The (default) database name did not match.");
  if (database.type !== "FIRESTORE_NATIVE") throw new PreflightStop("database", `Database type is ${database.type || "unknown"}, not FIRESTORE_NATIVE.`);

  const verification = {
    project: expectedProject, adcProject, databaseId: DATABASE_ID, databaseType: database.type, databaseLocation: database.locationId || null,
    principal, principalType: principal.endsWith(".gserviceaccount.com") ? "serviceAccount" : "user",
    readPermissions: REQUIRED_READ_PERMISSIONS, principalAlsoHoldsWritePermissions: WRITE_PERMISSIONS.filter(permission => permissions.has(permission)),
    emulatorConfiguration: "none", credentialSource: "application-default-credentials (no key file)",
  };

  const { db, app } = await initFirestore({ projectId: expectedProject });
  const preflight = await createMonitoringLifecycleBackfill({ db, app, registration: policy, lifecycleId, now, env })
    .plan({ expectedProject, expectedDatabaseId: DATABASE_ID });
  return { verification, preflight };
}

function defaultRequest(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
  if (form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
  return fetch(url, { method, headers, body }).then(async response => ({ status: response.status, json: await response.json().catch(() => null) }));
}

function defaultAuth() {
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email"] });
  return { getProjectId: () => auth.getProjectId(), getAccessToken: () => auth.getAccessToken() };
}

function defaultInitFirestore({ projectId }) {
  const { initializeApp, applicationDefault } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  // A named app with ADC; the backend's default app and src/config/firebase.js are never touched.
  const app = initializeApp({ credential: applicationDefault(), projectId }, "menro-readonly-monitoring-preflight");
  return { app, db: getFirestore(app) };
}

module.exports = { PreflightStop, REQUIRED_READ_PERMISSIONS, assertEnvironment, parseCloudShellArguments, runCloudShellPreflight };

if (require.main === module) {
  Promise.resolve()
    .then(() => runCloudShellPreflight({ argv: process.argv.slice(2), env: process.env, auth: defaultAuth(), request: defaultRequest, initFirestore: defaultInitFirestore }))
    .then(result => { console.log(JSON.stringify(result, null, 2)); process.exit(0); })
    .catch(error => { console.error(`PREFLIGHT STOPPED ${error.message}`); process.exit(1); });
}
