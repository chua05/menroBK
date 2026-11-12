const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const formAcceptance = process.env.MENRO_SAMPLE_MONITORING_FORM_ACCEPTANCE === "true";
if (formAcceptance) {
  require("node:assert/strict").equal(process.env.MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS, "true");
  require("node:assert/strict").equal(process.env.MENRO_PHASE3C_ISOLATED_EMULATORS, undefined);
  require("node:assert/strict").equal(require("../../src/config/integrationEnvironment").validateIntegrationEnvironment().legacyMonitoringIsolated, true);
}
const isolated = process.env.MENRO_PHASE3C_ISOLATED_EMULATORS === "true" || formAcceptance;
const extended = process.env.MENRO_PHASE3D4_ACCEPTANCE === "true" || formAcceptance;
const combinedWorkflow = process.env.MENRO_COMBINED_WORKFLOW_ACCEPTANCE === "true";
if (combinedWorkflow && !isolated) throw new Error("Combined workflow acceptance requires isolated demo emulators.");
const evidenceReadOnly = process.env.MENRO_PHASE3D4_EVIDENCE_READ_ONLY === "true";
const releaseAcceptance = process.env.MENRO_PERMANENT_SAMPLE_RELEASE_ACCEPTANCE;
if (releaseAcceptance !== undefined && (!extended || !isolated || !["paused", "pilot"].includes(releaseAcceptance))) throw new Error("Release acceptance requires an explicit isolated Phase 3D/4 fixture.");
if (releaseAcceptance) for (const name of ["PERMANENT_SAMPLE_WRITE_PAUSED", "PERMANENT_SAMPLE_PILOT_ENABLED", "PERMANENT_SAMPLE_PILOT_USER_IDS", "PERMANENT_SAMPLE_PILOT_COHORT_IDS"]) {
  if (process.env[name] !== undefined) throw new Error("Release acceptance owns its process-local control values.");
}
if (evidenceReadOnly && (!extended || !isolated)) throw new Error("Read-only evidence acceptance requires isolated Phase 3D/4 mode.");
if (extended && !isolated) throw new Error("Phase 3D/4 acceptance requires isolated emulators.");
if (extended) Object.assign(process.env, { MONITORING_INFORMATION_ENABLED: "true", PERMANENT_SAMPLE_ANALYTICS_ENABLED: "true" });
const topology = formAcceptance ? { project: "demo-menro-legacy-monitoring-20261106", firestore: "127.0.0.1:8381", auth: "127.0.0.1:9399", storage: "127.0.0.1:9398", bucket: "demo-menro-legacy-monitoring-20261106.firebasestorage.app" } : isolated ? { project: "demo-menro-phase3c-isolated", firestore: "127.0.0.1:8281", auth: "127.0.0.1:9299", storage: "127.0.0.1:9298", bucket: "demo-menro-phase3c-isolated.firebasestorage.app" } : { project: "demo-menro-phase2", firestore: "127.0.0.1:8181", auth: "127.0.0.1:9099", storage: "127.0.0.1:9199", bucket: "demo-menro-phase2.firebasestorage.app" };
Object.assign(process.env, {
  NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", MENRO_REQUEST_LETTER_ACCEPTANCE: "true",
  GCLOUD_PROJECT: topology.project, FIREBASE_PROJECT_ID: topology.project,
  FIRESTORE_EMULATOR_HOST: topology.firestore, FIREBASE_AUTH_EMULATOR_HOST: topology.auth,
  FIREBASE_STORAGE_EMULATOR_HOST: topology.storage, STORAGE_EMULATOR_HOST: `http://${topology.storage}`, FIREBASE_STORAGE_BUCKET: topology.bucket,
  EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true", EVIDENCE_CLOUD_READ_ENABLED: "true",
  VERIFIED_PLANTING_COHORT_ENABLED: "true", MENRO_PHASE3C_BROWSER_ACCEPTANCE: "true", MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-phase3c-browser-${process.pid}`),
});
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) delete process.env[key];
if (evidenceReadOnly) process.env.EVIDENCE_CLOUD_WORKFLOW_ENABLED = "false";

const assert = require("node:assert/strict");
const { auth, db } = require("../../src/config/firebase");
const app = require("../../src/app");
const visitService = require("../../src/services/sampleMonitoringVisit.service");
const prefix = `phase3c-browser-${randomUUID()}`;
const ids = Object.fromEntries(["admin", "staff", "participant", "otherStaff"].map((role) => [role, `${prefix}-${role}`]));
// The real dashboard may number a fixture report on first read. Keep those
// real counter transactions UUID-scoped in this acceptance mode only.
if (formAcceptance) {
  const originalCollection = db.collection.bind(db);
  db.collection = (name, ...args) => {
    const collection = originalCollection(name, ...args);
    if (name === "counters") {
      const doc = collection.doc.bind(collection);
      collection.doc = id => {
        require("node:assert/strict").equal(typeof id, "string");
        const scoped = id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`;
        require("node:fs").appendFileSync(path.join(os.tmpdir(), "menro-phase3c-test-evidence", `${prefix}.counter-refs.jsonl`), `${JSON.stringify(scoped)}\n`);
        return doc(scoped);
      };
    }
    return collection;
  };
}
const password = "Phase3c-Browser-Only-2026!";
const siteId = `${prefix}-site`, cohortId = `${prefix}-cohort`;
const { cleanupFixture, fixturePath, manifestPath } = require("./phase3cBrowserFixtureCleanup");
const evidenceDirectory = path.join(os.tmpdir(), "menro-phase3c-test-evidence");
const diagnosticPath = path.join(evidenceDirectory, `${prefix}.backend.log`);
let server, stopping = false, diagnosticReady = false;

// The evidence service emits this exact, sanitized channel only when the
// isolated Phase 3C browser-acceptance mode is enabled.  Preserve its normal
// stdout behavior while keeping a fixture-scoped copy for failed Playwright
// runs, where the web-server process output is otherwise discarded.
const originalInfo = console.info;
const originalError = console.error;
const captureDiagnostic = (channel, value) => {
  const safe = value instanceof Error
    ? { name: value.name, code: value.code || null, status: Number(value.status) || null }
    : { type: typeof value };
  return fs.appendFile(diagnosticPath, `${JSON.stringify({ channel, ...safe })}\n`, "utf8").catch(() => undefined);
};
console.info = (...args) => {
  const line = args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
  if (diagnosticReady && line.startsWith("[phase3c-evidence-linkage]")) {
    void fs.appendFile(diagnosticPath, `${line}\n`, "utf8").catch(() => undefined);
  }
  originalInfo(...args);
};
console.error = (...args) => {
  if (diagnosticReady) void captureDiagnostic("error", args[0]);
  originalError(...args);
};

async function cleanup() { return cleanupFixture(prefix); }

async function main() {
  assert.equal(process.env.GCLOUD_PROJECT, topology.project);
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, topology.firestore);
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, topology.auth);
  assert.equal(process.env.FIREBASE_STORAGE_EMULATOR_HOST, topology.storage);
  await fs.mkdir(evidenceDirectory, { recursive: true });
  await fs.writeFile(diagnosticPath, "", { encoding: "utf8", flag: "wx" });
  diagnosticReady = true;
  const visitDate = formAcceptance ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()) : "2099-01-01";
  const visitId = visitService._test.id(cohortId, visitDate);
  await fs.writeFile(manifestPath(prefix), JSON.stringify({ prefix, project: topology.project, visitId, visitDate, formAcceptance, combinedWorkflow }), { encoding: "utf8", flag: "wx" });
  for (const [role, uid] of Object.entries(ids)) {
    const email = `${role}.${prefix}@example.test`;
    await auth.createUser({ uid, email, password, emailVerified: true });
    await db.collection("users").doc(uid).set({ role: role === "otherStaff" ? "staff" : role, status: "active", profileComplete: true, testFixture: prefix,
      ...(extended || combinedWorkflow ? { fullName: "Isolated acceptance user", username: `${role}-${prefix}`, contactNumber: "09123456789", userType: "Other", userTypeDetail: "Disposable emulator fixture" } : {}) });
  }
  await db.collection("sites").doc(siteId).set({ siteName: "Phase 3C browser fixture", latitude: 12.662301, longitude: 123.932983, coverageRadiusMeters: 50, status: "Active", testFixture: prefix });
  if (extended) {
    await db.collection("seedlingRequests").doc(`${prefix}-source`).set({ participantId: ids.participant, testFixture: prefix });
    await db.collection("plantingReports").doc(`${prefix}-report`).set({ requestId: `${prefix}-source`, verificationStatus: "Approved", quantityPlanted: formAcceptance ? 20 : 10, testFixture: prefix });
  }
  await db.collection("verifiedPlantingCohorts").doc(cohortId).set({ source: { siteId, plantingReportId: `${prefix}-report`, ...(extended ? { requestId: `${prefix}-source` } : {}) }, baselineVersion: 1,
    verifiedPlantedQuantity: formAcceptance ? 20 : 10,
    samplingPlan: { status: "APPROVED", version: 1, selectedSamples: (formAcceptance ? ["TREE-001", "TREE-002"] : ["TREE-001"]).map(permanentId => ({ permanentId, species: "Narra" })) },
    baseline: { approvalStatus: "APPROVED", sampleUnits: (formAcceptance ? ["TREE-001", "TREE-002"] : ["TREE-001"]).map((permanentId, index) => ({ permanentId, condition: "Healthy", ...(formAcceptance ? { heightMeters: 1, diameterCentimeters: 5, latitude: 12.662301 + index * 0.00003, longitude: 123.932983, captureDate: visitDate } : {}) })) }, testFixture: prefix });
  const visit = await visitService.create({ cohortId, actorId: ids.staff, visitDate, testOnly: true });
  assert.equal(visit.status, "DRAFT");
  const workflowFixture = combinedWorkflow ? await require("./combinedWorkflowFixture").seed(prefix) : {};
  const releaseFixture = releaseAcceptance ? await require("./permanentSampleReleaseFixture").seed({ prefix, ids, cohortId, siteId, visit }) : {};
  if (releaseAcceptance === "paused") process.env.PERMANENT_SAMPLE_WRITE_PAUSED = "true";
  if (releaseAcceptance === "pilot") Object.assign(process.env, { PERMANENT_SAMPLE_PILOT_ENABLED: "true",
    PERMANENT_SAMPLE_PILOT_USER_IDS: JSON.stringify([ids.staff, ids.admin, ids.participant]), PERMANENT_SAMPLE_PILOT_COHORT_IDS: JSON.stringify([cohortId]) });
  require("../../src/config/permanentSampleRelease").resolve();
  await fs.writeFile(fixturePath, JSON.stringify({ prefix, project: topology.project,
    releaseAcceptance, ...releaseFixture, ...workflowFixture,
    evidenceWriteEnabled: require("../../src/config/evidenceStorage").resolveEvidenceStorageConfig().cloudWorkflow === true,
    password, visitId: visit.id, visitDate, sampleIds: visit.sampleAssessments.map(row => row.sampleId), diagnosticPath, emails: Object.fromEntries(Object.keys(ids).map((role) => [role, `${role}.${prefix}@example.test`])) }), "utf8");
  server = app.listen(5185, "127.0.0.1", () => console.log("PHASE3C_BROWSER_BACKEND_READY"));
}
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  if (server) await new Promise((resolve) => server.close(resolve));
  await cleanup().catch(() => { code = 1; }); process.exit(code);
}
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
main().catch(async error => {
  originalError({ name: error.name, code: error.code || null,
    source: error.stack?.split("\n").slice(1, 3).map(line => line.trim()) });
  await stop(1);
});
