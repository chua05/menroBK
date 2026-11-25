// Child-process harness for tests/historicalCohortRecovery.test.js: the real recovery CLI dry run under Cloud Shell
// conditions (NODE_ENV=production, no service-account values) with an injected in-memory Firestore. Never touches a real project.
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const { createMemoryFirestore } = require("./memoryFirestore");
const { runRecoveryCli } = require(path.join(root, "scripts/recoverHistoricalCohorts"));
const { REQUIRED_READ_PERMISSIONS } = require(path.join(root, "scripts/cloudShellMonitoringPreflight"));
const { PRODUCTION_PROJECT } = require(path.join(root, "src/services/monitoringLifecycleBackfill.service"));

const store = createMemoryFirestore({ projectId: PRODUCTION_PROJECT });
store.seed("sites", "site", { status: "active" });
store.seed("plantingReports", "event_FIXTURE", { reportNumber: "RPT-FIXTURE", reportType: "parent", reportingProgress: "Completed", acceptedQuantity: 20, siteId: "site",
  plantingDate: "2026-09-01", reportingPolicy: { definition: { monitoring: "PERMANENT_SAMPLE" } } });
const request = async (method, url, options = {}) => {
  if (url.includes("tokeninfo")) return { status: 200, json: { email: "operator@example.org", email_verified: "true" } };
  if (url.includes(":testIamPermissions")) return { status: 200, json: { permissions: REQUIRED_READ_PERMISSIONS.filter(p => options.json.permissions.includes(p)) } };
  if (url.includes("/databases/")) return { status: 200, json: { name: `projects/${PRODUCTION_PROJECT}/databases/(default)`, type: "FIRESTORE_NATIVE" } };
  throw new Error(`unexpected request ${url}`);
};
const loaded = pattern => Object.keys(require.cache).some(file => pattern.test(file));
runRecoveryCli({ argv: ["--reports=event_FIXTURE", `--expected-project=${PRODUCTION_PROJECT}`, "--expected-principal=operator@example.org"], env: process.env, request,
  auth: () => ({ getProjectId: async () => PRODUCTION_PROJECT, getAccessToken: async () => "adc-token" }), initFirestore: async () => ({ db: store }) })
  .then(result => process.stdout.write(JSON.stringify({ hasKey: Boolean(process.env.FIREBASE_PRIVATE_KEY || process.env.FIREBASE_CLIENT_EMAIL), decision: result.reports[0].decision,
    writes: store.appliedWrites.length, loadedConfigFirebase: loaded(/src[\\/]config[\\/]firebase\.js$/), loadedCohortService: loaded(/verifiedPlantingCohort\.service\.js$/) })))
  .catch(error => { process.stdout.write(JSON.stringify({ crashed: error.message })); process.exitCode = 1; });
