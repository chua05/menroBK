// Real Auth/Firestore/Storage emulators: a verified report stored as Staff Spot-Check goes through the simplified first visit
// over HTTP (list, start, capture, draft, submit, return, resubmit, approve, visit 2) without touching the report.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const sharp = require("sharp");

for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG", "MENRO_PHASE3C_ISOLATED_EMULATORS",
  "PERMANENT_SAMPLE_PILOT_ENABLED", "PERMANENT_SAMPLE_PILOT_USER_IDS", "PERMANENT_SAMPLE_PILOT_COHORT_IDS"]) delete process.env[key];
process.env.MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS = "true";
const topology = require("../helpers/emulatorTestTopology");
Object.assign(process.env, {
  NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", GCLOUD_PROJECT: topology.project, FIREBASE_PROJECT_ID: topology.project,
  FIRESTORE_EMULATOR_HOST: topology.firestore, FIREBASE_AUTH_EMULATOR_HOST: topology.auth, FIREBASE_STORAGE_EMULATOR_HOST: topology.storage, FIREBASE_STORAGE_BUCKET: topology.bucket,
  EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true", EVIDENCE_CLOUD_READ_ENABLED: "true", PERMANENT_SAMPLE_WRITE_PAUSED: "false",
  VERIFIED_PLANTING_COHORT_ENABLED: "true", PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "true", PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true", VERIFIED_REPORT_FIRST_VISIT_ENABLED: "true",
  MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-verified-report-${process.pid}`),
});
const validation = require("../../src/config/integrationEnvironment").validateIntegrationEnvironment();
assert.equal(validation.integration, true); assert.match(validation.projectId, /^demo-/); assert.match(topology.firestore, /^127\.0\.0\.1:/);

const { db, auth, getStorageBucket } = require("../../src/config/firebase");
const app = require("../../src/app");
const visitService = require("../../src/services/sampleMonitoringVisit.service");
const { cohortIdFor } = require("../../src/services/verifiedPlantingCohortEligibility");
const schedule = require("../../src/config/permanentSampleSchedule");

const prefix = `verified-report-${crypto.randomUUID()}`;
const ids = Object.fromEntries(["staffA", "staffB", "admin"].map(role => [role, `${prefix}-${role}`]));
const cleanupCreated = require("../helpers/emulatorCreatedResources").trackEmulatorCreatedResources({ db, auth, getBucket: getStorageBucket, prefix, users: ids });
const password = "Local-Verified-Report-Fixture-2026!", SITE = { latitude: 12.662301, longitude: 123.932983 }, siteId = `${prefix}-site`, tokens = {};
const today = schedule.dateOnlyInManila();
const V1_DATE = schedule.addCalendarMonths(today, 0), PLANTING_DATE = "2026-09-01";
let server, base;

async function api(route, role = "staffA", method = "GET", body) {
  const response = await fetch(base + route, { method, headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const start = (reportId, role = "staffA", visitDate = V1_DATE) => api(`/verified-sample-monitoring/verified-reports/${reportId}/first-visit`, role, "POST", { visitDate });
const listRows = async role => { const rows = []; let cursor = ""; do { const { body } = await api(`/verified-sample-monitoring/verified-reports${cursor ? `?cursor=${cursor}` : ""}`, role); rows.push(...body.data.cohorts); cursor = body.data.nextCursor; } while (cursor); return rows; };
async function seed(key, reportingPolicy, extra = {}) {
  const reportId = `${prefix}-report-${key}`;
  await db.collection("plantingReports").doc(reportId).set({ reportNumber: `RPT-${key}-${prefix.slice(-4).toUpperCase()}`, reportType: "parent", reportingProgress: "Completed", verificationStatus: "Completed",
    acceptedQuantity: 15, quantityPlanted: 15, siteId, species: "Narra", plantingDate: PLANTING_DATE, testFixture: prefix, ...(reportingPolicy ? { reportingPolicy } : {}), ...extra });
  return reportId;
}
async function capture(visitId, sampleId) {
  const visit = await visitService.get(visitId), assessment = visit.sampleAssessments.find(row => row.sampleId === sampleId), revision = Number(assessment.assessmentRevision || 0);
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: `#${crypto.randomBytes(3).toString("hex")}` } }).jpeg().toBuffer();
  const created = await api("/evidence-capture-sessions", "staffA", "POST", { workflow: "sample-monitoring", cohortId: visit.cohortId, siteId: visit.siteId, visitId, sampleId,
    samplingPlanVersion: visit.samplingPlanVersion, baselineVersion: visit.baselineVersion, visitVersion: visit.version, assessmentRevision: revision });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const session = created.body.data;
  const verify = new FormData(); verify.set("photo", new Blob([bytes], { type: "image/jpeg" }), "capture.jpg");
  for (const [key, value] of Object.entries({ nonce: session.nonce, capturedAt: new Date().toISOString(), latitude: SITE.latitude, longitude: SITE.longitude, accuracy: 5,
    clientImageSha256: crypto.createHash("sha256").update(bytes).digest("hex") })) verify.set(key, String(value));
  const response = await fetch(`${base}/evidence-capture-sessions/${session.captureSessionId}/verify`, { method: "POST", headers: { authorization: `Bearer ${tokens.staffA}` }, body: verify });
  const verified = (await response.json()).data; assert.equal(response.status, 200);
  const form = new FormData(); form.set("expectedVisitVersion", String(visit.version)); form.set("assessmentRevision", String(revision));
  form.set("evidenceManifest", JSON.stringify([{ source: "browser-camera", captureSessionId: session.captureSessionId, nonce: session.nonce, verificationId: verified.verificationId, imageSha256: verified.imageSha256 }]));
  form.set("photos", new Blob([bytes], { type: "image/jpeg" }), "tree.jpg");
  const uploaded = await fetch(`${base}/verified-sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence`, { method: "PUT", headers: { authorization: `Bearer ${tokens.staffA}`, "Idempotency-Key": `vr_${crypto.randomBytes(8).toString("hex")}` }, body: form });
  assert.equal(uploaded.status, 200, JSON.stringify(await uploaded.json()));
}
const save = async (visitId, trees, submit) => api(`/verified-sample-monitoring/visits/${visitId}`, "staffA", "PUT", { expectedVersion: (await visitService.get(visitId)).version, submit, dateMonitored: V1_DATE,
  assessments: trees.map(sampleId => ({ sampleId, condition: "Healthy", heightCentimeters: 40, stemDiameterMillimeters: 6, remarks: "Registered" })) });
const review = async (visitId, approve, reasons = "") => api(`/verified-sample-monitoring/visits/${visitId}/review`, "admin", "POST", { expectedVersion: (await visitService.get(visitId)).version, approve, reasons });

test.before(async () => {
  for (const [role, uid] of Object.entries(ids)) {
    const email = `${uid}@example.test`.toLowerCase();
    await auth.createUser({ uid, email, password, emailVerified: true });
    await db.collection("users").doc(uid).set({ uid, email, role: role === "admin" ? "admin" : "staff", fullName: role, status: "active", testFixture: prefix });
  }
  await db.collection("sites").doc(siteId).set({ siteName: "Emulator Site", barangay: "Zone 1", status: "Active", ...SITE, coverageRadiusMeters: 500, testFixture: prefix });
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}/api`;
  for (const role of Object.keys(ids)) {
    const response = await fetch(`http://${topology.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${ids[role]}@example.test`.toLowerCase(), password, returnSecureToken: true }) });
    tokens[role] = (await response.json()).idToken; assert.ok(tokens[role]);
  }
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  const bucket = await getStorageBucket();
  for (const report of (await db.collection("plantingReports").where("testFixture", "==", prefix).get()).docs) {
    const cohortId = cohortIdFor(report.id);
    for (const visit of (await db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortId).get()).docs) {
      for (const row of visit.data().sampleAssessments || []) for (const entry of row.evidenceHistory || []) if (entry.privateEvidence?.objectName) await bucket.file(entry.privateEvidence.objectName).delete().catch(() => undefined);
      for (const hash of (await db.collection("sampleMonitoringEvidenceHashes").where("visitId", "==", visit.id).get()).docs) await hash.ref.delete();
      await visit.ref.delete();
    }
    await db.collection("verifiedPlantingCohorts").doc(cohortId).delete(); await report.ref.delete();
  }
  await db.collection("sites").doc(siteId).delete();
  await cleanupCreated();
  for (const uid of Object.values(ids)) { await db.collection("users").doc(uid).delete(); await auth.deleteUser(uid).catch(() => undefined); }
});

test("a Staff Spot-Check report runs list, start, draft, submit, return, resubmit and approval; Tree IDs lock and visit 2 is scheduled", async () => {
  const reportId = await seed("SPOT", { definition: { monitoring: "STAFF_SPOT_CHECK", reporting: "REQUIRED" }, policyVersion: 0 });
  const reportRef = db.collection("plantingReports").doc(reportId), before = JSON.stringify((await reportRef.get()).data()), lifecycles = (await db.collection("monitoringRecords").get()).size;
  const row = (await listRows("staffA")).find(entry => entry.plantingReportId === reportId);
  assert.equal(row.canCreateVisit, true); assert.equal(row.sampleTarget, 2);
  assert.equal((await start(reportId, "admin")).status, 403); assert.equal((await start(reportId, null)).status, 401);
  const started = await start(reportId); assert.equal(started.status, 201, JSON.stringify(started.body));
  const visitId = started.body.data.id, trees = started.body.data.sampleAssessments.map(entry => entry.sampleId);
  assert.equal(trees.length, 2); assert.equal((await start(reportId)).body.data.id, visitId); assert.equal((await start(reportId, "staffB")).body.code, "OPEN_VISIT_EXISTS");
  assert.equal((await save(visitId, trees, false)).status, 200);
  assert.equal((await save(visitId, trees, true)).status, 409, "submit still needs verified photo and GPS evidence");
  for (const tree of trees) await capture(visitId, tree);
  const withRuleOff = async action => { process.env.VERIFIED_REPORT_FIRST_VISIT_ENABLED = "false"; try { const result = await action(); assert.equal(result.body.code, "REPORT_NOT_ELIGIBLE", JSON.stringify(result.body)); } finally { process.env.VERIFIED_REPORT_FIRST_VISIT_ENABLED = "true"; } };
  await withRuleOff(() => save(visitId, trees, true));
  const submitted = await save(visitId, trees, true); assert.equal(submitted.status, 200, JSON.stringify(submitted.body)); assert.equal(submitted.body.data.status, "PENDING_ADMIN_APPROVAL");
  assert.equal((await review(visitId, false, "Retake the photos.")).body.data.status, "RETURNED");
  const resubmitted = await save(visitId, trees, true); assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
  await withRuleOff(() => review(visitId, true));
  const approved = await review(visitId, true); assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.data.status, "APPROVED");
  const cohort = (await db.collection("verifiedPlantingCohorts").doc(cohortIdFor(reportId)).get()).data();
  assert.equal(cohort.samplingPlan.status, "APPROVED"); assert.equal(cohort.baseline.approvalStatus, "APPROVED"); assert.deepEqual(cohort.baseline.sampleUnits.map(unit => unit.permanentId), trees);
  assert.equal(cohort.eligibilityAuthorization.originalMethod, "STAFF_SPOT_CHECK");
  assert.equal((await start(reportId)).body.code, "FIRST_VISIT_ALREADY_REGISTERED");
  const readiness = (await api("/verified-sample-monitoring/readiness")).body.data.cohorts.find(entry => entry.cohortId === cohortIdFor(reportId));
  assert.equal(readiness.nextVisitNumber, 2); assert.equal(readiness.nextScheduledDueDate, schedule.addCalendarMonths(V1_DATE, 1));
  assert.deepEqual(readiness.reasons.map(entry => entry.code), ["VISIT_NOT_OPEN"]);
  assert.equal(JSON.stringify((await reportRef.get()).data()), before, "the report and its stored policy are unchanged");
  assert.equal((await db.collection("monitoringRecords").get()).size, lifecycles, "aggregate monitoring is unchanged");
});

test("six simultaneous starts by two Staff create one cohort and one visit", async () => {
  const reportId = await seed("RACE", { monitoring: "PENDING_MENRO_POLICY", definition: { monitoring: "PENDING_MENRO_POLICY" }, policyStatus: "PENDING_MENRO_POLICY" });
  const results = await Promise.all(["staffA", "staffB", "staffA", "staffB", "staffA", "staffB"].map(role => start(reportId, role)));
  assert.equal(new Set(results.filter(result => result.status === 201).map(result => result.body.data.id)).size, 1);
  assert.ok(results.filter(result => result.status !== 201).every(result => result.body.code === "OPEN_VISIT_EXISTS"), JSON.stringify(results.map(result => [result.status, result.body.code])));
  assert.equal((await db.collection("verifiedPlantingCohorts").where("source.plantingReportId", "==", reportId).get()).size, 1);
  assert.equal((await db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortIdFor(reportId)).get()).size, 1);
});

test("paused writes list the report but refuse the start, and nothing is created", async () => {
  const reportId = await seed("PAUSE", { monitoring: "STAFF_SPOT_CHECK" });
  process.env.PERMANENT_SAMPLE_WRITE_PAUSED = "true";
  try {
    const row = (await listRows("staffA")).find(entry => entry.plantingReportId === reportId); assert.equal(row.canCreateVisit, false);
    assert.equal((await start(reportId)).status, 503);
  } finally { process.env.PERMANENT_SAMPLE_WRITE_PAUSED = "false"; }
  assert.equal((await db.collection("verifiedPlantingCohorts").doc(cohortIdFor(reportId)).get()).exists, false);
});
