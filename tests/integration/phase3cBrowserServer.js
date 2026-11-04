const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const isolated = process.env.MENRO_PHASE3C_ISOLATED_EMULATORS === "true";
const extended = process.env.MENRO_PHASE3D4_ACCEPTANCE === "true";
if (extended && !isolated) throw new Error("Phase 3D/4 acceptance requires isolated emulators.");
if (extended) Object.assign(process.env, { MONITORING_INFORMATION_ENABLED: "true", PERMANENT_SAMPLE_ANALYTICS_ENABLED: "true" });
const topology = isolated ? { project: "demo-menro-phase3c-isolated", firestore: "127.0.0.1:8281", auth: "127.0.0.1:9299", storage: "127.0.0.1:9298", bucket: "demo-menro-phase3c-isolated.firebasestorage.app" } : { project: "demo-menro-phase2", firestore: "127.0.0.1:8181", auth: "127.0.0.1:9099", storage: "127.0.0.1:9199", bucket: "demo-menro-phase2.firebasestorage.app" };
Object.assign(process.env, {
  NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", MENRO_REQUEST_LETTER_ACCEPTANCE: "true",
  GCLOUD_PROJECT: topology.project, FIREBASE_PROJECT_ID: topology.project,
  FIRESTORE_EMULATOR_HOST: topology.firestore, FIREBASE_AUTH_EMULATOR_HOST: topology.auth,
  FIREBASE_STORAGE_EMULATOR_HOST: topology.storage, STORAGE_EMULATOR_HOST: `http://${topology.storage}`, FIREBASE_STORAGE_BUCKET: topology.bucket,
  EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true", EVIDENCE_CLOUD_READ_ENABLED: "true",
  VERIFIED_PLANTING_COHORT_ENABLED: "true", MENRO_PHASE3C_BROWSER_ACCEPTANCE: "true", MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-phase3c-browser-${process.pid}`),
});
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) delete process.env[key];

const assert = require("node:assert/strict");
const { auth, db } = require("../../src/config/firebase");
const app = require("../../src/app");
const visitService = require("../../src/services/sampleMonitoringVisit.service");
const prefix = `phase3c-browser-${randomUUID()}`;
const ids = Object.fromEntries(["admin", "staff", "participant", "otherStaff"].map((role) => [role, `${prefix}-${role}`]));
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
  const visitId = visitService._test.id(cohortId, "2099-01-01");
  await fs.writeFile(manifestPath(prefix), JSON.stringify({ prefix, project: topology.project, visitId }), { encoding: "utf8", flag: "wx" });
  for (const [role, uid] of Object.entries(ids)) {
    const email = `${role}.${prefix}@example.test`;
    await auth.createUser({ uid, email, password, emailVerified: true });
    await db.collection("users").doc(uid).set({ role: role === "otherStaff" ? "staff" : role, status: "active", profileComplete: true, testFixture: prefix,
      ...(extended ? { fullName: "Isolated acceptance user", username: `${role}-${prefix}`, contactNumber: "09123456789", userType: "Other", userTypeDetail: "Disposable emulator fixture" } : {}) });
  }
  await db.collection("sites").doc(siteId).set({ siteName: "Phase 3C browser fixture", latitude: 12.662301, longitude: 123.932983, coverageRadiusMeters: 50, status: "Active", testFixture: prefix });
  if (extended) {
    await db.collection("seedlingRequests").doc(`${prefix}-source`).set({ participantId: ids.participant, testFixture: prefix });
    await db.collection("plantingReports").doc(`${prefix}-report`).set({ requestId: `${prefix}-source`, verificationStatus: "Approved", quantityPlanted: 10, testFixture: prefix });
  }
  await db.collection("verifiedPlantingCohorts").doc(cohortId).set({ source: { siteId, plantingReportId: `${prefix}-report`, ...(extended ? { requestId: `${prefix}-source` } : {}) }, baselineVersion: 1,
    samplingPlan: { status: "APPROVED", version: 1, selectedSamples: [{ permanentId: "TREE-001" }] },
    baseline: { approvalStatus: "APPROVED", sampleUnits: [{ permanentId: "TREE-001", condition: "Healthy" }] }, testFixture: prefix });
  const visit = await visitService.create({ cohortId, actorId: ids.staff, visitDate: "2099-01-01", testOnly: true });
  assert.equal(visit.status, "DRAFT");
  await fs.writeFile(fixturePath, JSON.stringify({ prefix, project: topology.project, password, visitId: visit.id, diagnosticPath, emails: Object.fromEntries(Object.keys(ids).map((role) => [role, `${role}.${prefix}@example.test`])) }), "utf8");
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
