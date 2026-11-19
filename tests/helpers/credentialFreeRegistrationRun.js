// Child-process harness reproducing the Cloud Shell registration conditions: NODE_ENV=production for
// menrosystem-ddfac, NO FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY, and an injected (ADC-style) Firestore.
// Runs the real CLI entry (runCloudShellRegistration) end to end against an in-memory Firestore and prints
// a JSON summary. Used by tests/cloudShellRegistrationCredentialFree.test.js; never touches a real project.
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const { createMemoryFirestore } = require("./memoryFirestore");
const { PRODUCTION_PROJECT, PRODUCTION_TARGETS } = require(path.join(root, "src/services/monitoringLifecycleBackfill.service"));
const { REQUIRED_READ_PERMISSIONS } = require(path.join(root, "scripts/cloudShellMonitoringPreflight"));
const { CONFIRM_REPORTS, REQUIRED_WRITE_PERMISSIONS, runCloudShellRegistration } = require(path.join(root, "scripts/cloudShellMonitoringRegistration"));
const { Timestamp } = require("firebase-admin/firestore");

const PRINCIPAL = "operator@example.org";
const COUNTER_ID = `monitoringRecords_${new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric" }).format(new Date())}`;
const scenario = process.argv[2];

function productionLikeStore() {
  const store = createMemoryFirestore({ projectId: PRODUCTION_PROJECT });
  for (const target of PRODUCTION_TARGETS) {
    store.seed("plantingReports", target.reportId, { reportNumber: target.reportNumber, participantId: `participant-${target.reportId}`, eventId: target.reportId.replace("event_", ""),
      siteId: "site-bical", siteName: "Bical Site", acceptedQuantity: 20, plantingDate: "2026-10-01", verificationStatus: "Completed", reportingProgress: "Completed",
      reportingPolicy: { definition: { monitoring: "STAFF_SPOT_CHECK", reporting: "REQUIRED" }, policyVersion: 0 }, history: [{ id: "report-history" }] });
  }
  store.seed("plantingReports", "event_UNRELATED", { reportNumber: "RPT-2026-999", verificationStatus: "Completed", reportingPolicy: { definition: { monitoring: "STAFF_SPOT_CHECK" } } });
  return store;
}

function cli(store, extra = []) {
  const request = async (method, url, options = {}) => {
    if (url.includes("tokeninfo")) return { status: 200, json: { email: PRINCIPAL, email_verified: "true" } };
    if (url.includes(":testIamPermissions")) return { status: 200, json: { permissions: [...REQUIRED_READ_PERMISSIONS, ...REQUIRED_WRITE_PERMISSIONS].filter((p) => options.json.permissions.includes(p)) } };
    if (url.includes("/databases/")) return { status: 200, json: { name: `projects/${PRODUCTION_PROJECT}/databases/(default)`, type: "FIRESTORE_NATIVE" } };
    throw new Error(`unexpected request ${url}`);
  };
  return runCloudShellRegistration({ argv: [`--expected-project=${PRODUCTION_PROJECT}`, `--expected-principal=${PRINCIPAL}`, ...extra], env: process.env,
    auth: { getProjectId: async () => PRODUCTION_PROJECT, getAccessToken: async () => "adc-token" }, request,
    initFirestore: async ({ projectId }) => ({ db: store, app: { options: { projectId } } }) });
}
const execute = (store, digest) => cli(store, ["--execute", `--confirm-project=${PRODUCTION_PROJECT}`, `--confirm-reports=${CONFIRM_REPORTS}`, `--confirm-plan=${digest}`]);
const loaded = (pattern) => Object.keys(require.cache).some((file) => pattern.test(file));
const stamp = (value) => (value instanceof Timestamp ? "Timestamp" : value);

(async () => {
  const out = { env: { NODE_ENV: process.env.NODE_ENV, hasClientEmail: Boolean(process.env.FIREBASE_CLIENT_EMAIL), hasPrivateKey: Boolean(process.env.FIREBASE_PRIVATE_KEY) } };
  const store = productionLikeStore();
  const reportsBefore = JSON.stringify(PRODUCTION_TARGETS.map((t) => store.read("plantingReports", t.reportId)));
  if (scenario === "full") {
    const dry = await cli(store);
    out.dry = { executable: dry.executable, blockers: dry.blockers, actions: dry.preflight.plan.map((r) => r.action), counterState: dry.preflight.numberIntegrity.counterState, writesAfterDryRun: store.appliedWrites.length };
    const first = await execute(store, dry.planDigest);
    out.first = { status: first.status, results: (first.results || first.completed || []).map((r) => [r.reportId, r.status, r.monitoringNumber, r.lifecycleId]), post: first.postVerification, failedReportId: first.failedReportId, error: first.error };
    out.lifecycles = store.ids("monitoringRecords").map((id) => { const r = store.read("monitoringRecords", id);
      return { id, plantingReportId: r.plantingReportId, monitoringNumber: r.monitoringNumber, monitoringMethod: r.monitoringMethod, scheduleStatus: r.scheduleStatus,
        dates: [r.startMonitoringDate, r.nextMonitoringDate, r.monitoringEndDate], history: r.history, archived: r.archived, registeredAt: stamp(r.registeredAt) }; });
    out.counter = store.read("counters", COUNTER_ID) && { ...store.read("counters", COUNTER_ID), updatedAt: stamp(store.read("counters", COUNTER_ID).updatedAt) };
    out.writes = store.appliedWrites;
    if (first.status !== "COMPLETED") { out.writes = store.appliedWrites; process.stdout.write(JSON.stringify({ ...out, loadedConfigFirebase: loaded(/src[\\/]config[\\/]firebase\.js$/) })); return; }
    const again = await cli(store);
    const repeat = await execute(store, again.planDigest);
    out.repeat = { actions: again.preflight.plan.map((r) => r.action), results: repeat.results.map((r) => [r.status, r.monitoringNumber]), writesTotal: store.appliedWrites.length };
  } else if (scenario === "partial") {
    const dry = await cli(store);
    store.failWriteTransaction(2);
    const partial = await execute(store, dry.planDigest);
    out.partial = { status: partial.status, completed: partial.completed.map((r) => [r.reportId, r.status, r.monitoringNumber]), failedReportId: partial.failedReportId,
      error: partial.error, recovery: partial.recovery, lifecycleIds: store.ids("monitoringRecords"), counter: store.read("counters", COUNTER_ID)?.lastNumber };
    store.failWriteTransaction(0);
    let staleDigestError = null;
    try { await execute(store, dry.planDigest); } catch (error) { staleDigestError = error.message; }
    const retryDry = await cli(store);
    const retried = await execute(store, retryDry.planDigest);
    out.retry = { staleDigestError, actions: retryDry.preflight.plan.map((r) => r.action), results: retried.results.map((r) => [r.status, r.monitoringNumber]), post: retried.postVerification.ok,
      counter: store.read("counters", COUNTER_ID).lastNumber };
  }
  out.reportsUnchanged = JSON.stringify(PRODUCTION_TARGETS.map((t) => store.read("plantingReports", t.reportId))) === reportsBefore;
  out.unrelatedUntouched = !store.appliedWrites.some((w) => w.includes("UNRELATED"));
  out.loadedConfigFirebase = loaded(/src[\\/]config[\\/]firebase\.js$/);
  out.loadedMonitoringService = loaded(/src[\\/]services[\\/]monitoring\.service\.js$/);
  process.stdout.write(JSON.stringify(out));
})().catch((error) => { process.stdout.write(JSON.stringify({ crashed: error.message })); process.exitCode = 1; });
