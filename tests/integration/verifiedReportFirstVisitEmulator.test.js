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
// The official (whole-cohort and planting) figures; the sample survival KPI is expected to follow approvals.
const officialSummary = async () => { const { sampleSurvivalRate, ...official } = (await api("/analytics/dashboard", "admin")).body.data?.summary || {}; void sampleSurvivalRate; return JSON.stringify(official); };
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

// Modelled on RPT-2026-024: an Admin-verified report that already has an aggregate MON monitoring record.
test("a verified report with an earlier aggregate monitoring record starts Visit 1 once; the MON record stays unchanged and is never Visit 1", async () => {
  const reportId = await seed("LEGACY", { definition: { monitoring: "STAFF_SPOT_CHECK", reporting: "REQUIRED" }, policyVersion: 0 });
  const monRef = db.collection("monitoringRecords").doc(`${prefix}-mon`);
  await monRef.set({ monitoringNumber: "MON-2026-024", plantingReportId: reportId, siteId, status: "Active Monitoring", quantityPlanted: 15, testFixture: prefix,
    history: [{ monitoringDate: "2026-10-01", healthyCount: 15, damagedCount: 0, deadCount: 0, totalMonitored: 15 }] });
  try {
    const before = JSON.stringify((await monRef.get()).data());
    const row = (await listRows("staffA")).find(entry => entry.plantingReportId === reportId);
    assert.deepEqual([row.canCreateVisit, row.nextVisitNumber, row.sampleTarget], [true, 1, 2]);
    const results = await Promise.all([start(reportId), start(reportId), start(reportId)]);
    assert.deepEqual(results.map(result => result.status), [201, 201, 201], JSON.stringify(results.map(result => result.body.code)));
    const visit = results[0].body.data;
    assert.equal(new Set(results.map(result => result.body.data.id)).size, 1);
    assert.deepEqual([visit.visitNumber, visit.registersBaseline, visit.priorVisitId], [1, true, null]);
    assert.ok(visit.sampleAssessments.every(entry => entry.condition === null && entry.evidenceHistory.length === 0), "nothing is copied from the aggregate record");
    assert.equal(JSON.stringify((await monRef.get()).data()), before);
    // Save Tree Assessment: refused without the tree's own photo, saved for that tree only with it.
    const [treeA, treeB] = visit.sampleAssessments.map(entry => entry.sampleId);
    const put = async body => api(`/verified-sample-monitoring/visits/${visit.id}`, "staffA", "PUT", { expectedVersion: (await visitService.get(visit.id)).version, submit: false, dateMonitored: V1_DATE, ...body });
    const assessments = [{ sampleId: treeA, condition: "Healthy", heightCentimeters: 40, stemDiameterMillimeters: 6, remarks: "" }, { sampleId: treeB, condition: "Needs Rechecking", remarks: "", recheckReason: "", searchFindings: "Tag not visible" }];
    const refused = await put({ assessments, assessedSampleId: treeA });
    assert.deepEqual([refused.status, refused.body.code], [409, "CURRENT_SAMPLE_EVIDENCE_REQUIRED"]);
    await capture(visit.id, treeA);
    const saved = await put({ assessments, assessedSampleId: treeA });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const reopened = (await api(`/verified-sample-monitoring/visits/${visit.id}`)).body.data;
    assert.equal(reopened.status, "DRAFT");
    assert.deepEqual(reopened.sampleAssessments.map(entry => [entry.condition, entry.evidenceHistory.length]), [["Healthy", 1], ["Needs Rechecking", 0]]);
    assert.equal(reopened.sampleAssessments[1].searchFindings, "Tag not visible");
    assert.equal((await api(`/verified-sample-monitoring/visits/${visit.id}`, "staffB")).status, 404);
  } finally { await monRef.delete(); }
});

test("unverified, archived, zero-quantity and invalid-site reports cannot start, and nothing is created", async () => {
  for (const [key, extra] of [["PEND", { verificationStatus: "Pending", reportingProgress: "Submitted" }], ["ARCH", { archived: true }], ["ZERO", { acceptedQuantity: 0, quantityPlanted: 0 }], ["NOSITE", { siteId: `${prefix}-missing` }]]) {
    const reportId = await seed(key, { definition: { monitoring: "STAFF_SPOT_CHECK" } }, extra);
    assert.notEqual((await start(reportId)).status, 201, key);
    assert.equal((await db.collection("verifiedPlantingCohorts").doc(cohortIdFor(reportId)).get()).exists, false, key);
    const row = (await listRows("staffA")).find(entry => entry.plantingReportId === reportId);
    assert.ok(!row || row.canCreateVisit === false, key);
  }
});

// The three live lifecycles, with their real quantities, species and stored policies (read-only observation, 2026-11-26).
for (const [number, mon, quantity, species, monitoring] of [["RPT-2026-020", "MON-2026-001", 60, "Pili", "STAFF_SPOT_CHECK"], ["RPT-2026-024", "MON-2026-002", 50, "Pili", "STAFF_SPOT_CHECK"], ["RPT-2026-030", "MON-2026-003", 100, "Kalamansi", "PENDING_MENRO_POLICY"]]) {
  test(`${mon} / ${number}: the existing lifecycle runs Visit 1 to approval, then Visit 2 and the Visit 3 schedule, without a second lifecycle`, async () => {
    const planted = schedule.addCalendarMonths(`${Number(today.slice(0, 4)) - 1}${today.slice(4)}`, 9);
    const reportId = await seed(number.slice(-3), { policyVersion: 0, monitoring, definition: { monitoring, reporting: "REQUIRED" } }, { reportNumber: number, acceptedQuantity: quantity, quantityPlanted: quantity, species, plantingDate: planted });
    const monRef = db.collection("monitoringRecords").doc(`${prefix}-${mon}`);
    await monRef.set({ id: monRef.id, recordType: "monitoringLifecycle", monitoringNumber: mon, plantingReportId: reportId, plantingReportNumber: number, siteId, species: "", quantityPlanted: quantity, authoritativePlantingDate: planted,
      startMonitoringDate: null, nextMonitoringDate: null, monitoringEndDate: null, scheduleStatus: "AWAITING_MONITORING_POLICY", monitoringMethod: monitoring, history: [], archived: false, testFixture: prefix });
    try {
      const stored = JSON.stringify((await monRef.get()).data()), lifecycles = (await db.collection("monitoringRecords").get()).size, analyticsBefore = await officialSummary();
      const lifecycle = async () => (await api("/monitoring", "admin")).body.data.find(row => row.monitoringNumber === mon);
      // Approved Monitor Planted Trees results in the main analytics: this report's cohort, or undefined while it has no approved visit.
      const sampleAnalytics = async () => (await api("/analytics/dashboard", "admin")).body.data.permanentSample;
      const sampleRow = async () => (await sampleAnalytics()).cohorts.find(entry => entry.reportNumber === number);
      const markers = async (query = "") => (await api(`/analytics/dashboard${query}`, "admin")).body.data.permanentSample.trees.filter(tree => tree.reportNumber === number);
      // Every marker sits exactly at the registered position stored on the approved cohort baseline.
      const registered = async () => Object.fromEntries((await db.collection("verifiedPlantingCohorts").doc(cohortIdFor(reportId)).get()).data().baseline.sampleUnits.map(unit => [unit.permanentId, [unit.latitude, unit.longitude]]));
      const state = async () => { const { permanentSample: p } = await lifecycle(); return [p.startMonitoringDate, p.startProvisional, p.nextMonitoringDate, p.openVisit?.status || null]; };
      assert.deepEqual(await state(), [null, false, null, null]);
      const row = (await listRows("staffA")).find(entry => entry.plantingReportId === reportId);
      assert.deepEqual([row.canCreateVisit, row.sampleTarget, row.nextVisitNumber], [true, Math.ceil(quantity / 10), 1]);
      const started = await start(reportId, "staffA", today); assert.equal(started.status, 201, JSON.stringify(started.body));
      const visit = started.body.data, trees = visit.sampleAssessments.map(entry => entry.sampleId);
      assert.deepEqual(trees, Array.from({ length: quantity / 10 }, (_, i) => `${number}-T${String(i + 1).padStart(3, "0")}`)); assert.equal(visit.openingDate, planted);
      assert.deepEqual(await state(), [null, false, null, "DRAFT"]);
      // One month before today, so Visit 2 falls due today: Visit 1 has no fixed date.
      const v1Date = schedule.addCalendarMonths(`${Number(today.slice(0, 4)) - 1}${today.slice(4)}`, 11);
      const put = async (id, body) => api(`/verified-sample-monitoring/visits/${id}`, "staffA", "PUT", { expectedVersion: (await visitService.get(id)).version, ...body });
      const rows = height => trees.map(sampleId => ({ sampleId, condition: "Healthy", heightCentimeters: height, stemDiameterMillimeters: 6, remarks: "Registered" }));
      assert.equal((await put(visit.id, { assessments: rows(40), submit: false, dateMonitored: v1Date })).status, 200);
      assert.deepEqual(await state(), [null, false, null, "DRAFT"], "a draft never sets the start date");
      for (const tree of trees) await capture(visit.id, tree);
      assert.equal((await put(visit.id, { assessments: rows(40), submit: false, assessedSampleId: trees[0], dateMonitored: v1Date })).status, 200);
      assert.equal((await put(visit.id, { assessments: rows(40), submit: true, dateMonitored: schedule.addCalendarMonths(`${Number(planted.slice(0, 4)) - 1}${planted.slice(4)}`, 11) })).body.code, "VISIT_BEFORE_ELIGIBILITY");
      const submitted = await put(visit.id, { assessments: rows(40), submit: true, dateMonitored: v1Date }); assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
      assert.deepEqual(await state(), [v1Date, true, null, "PENDING_ADMIN_APPROVAL"]);
      assert.equal(await sampleRow(), undefined, "a visit awaiting Admin review is not in the analytics");
      assert.deepEqual(await markers(), [], "no tree marker before Admin approval");
      assert.equal((await review(visit.id, false, "Re-measure the first tree.")).body.data.status, "RETURNED");
      assert.deepEqual(await state(), [null, false, null, "RETURNED"], "a returned visit schedules nothing");
      assert.equal(await sampleRow(), undefined, "a returned visit is not in the analytics");
      assert.deepEqual(await markers(), [], "no tree marker for a returned visit");
      const corrected = rows(40); corrected[0].heightCentimeters = 41;
      assert.equal((await put(visit.id, { assessments: corrected, submit: false, assessedSampleId: trees[0], dateMonitored: v1Date })).status, 200);
      await capture(visit.id, trees[0]);
      assert.equal((await put(visit.id, { assessments: corrected, submit: true, dateMonitored: v1Date })).status, 200);
      const approved = await review(visit.id, true); assert.equal(approved.status, 200, JSON.stringify(approved.body));
      const due2 = schedule.addCalendarMonths(v1Date, 1), due3 = schedule.addCalendarMonths(due2, 3);
      assert.deepEqual(await state(), [v1Date, false, due2, null]);
      assert.deepEqual(await sampleRow(), { cohortId: cohortIdFor(reportId), reportNumber: number, siteName: "Emulator Site", barangay: "Zone 1", visitNumber: 1, date: v1Date,
        total: trees.length, Healthy: trees.length, Damaged: 0, Dead: 0, "Needs Rechecking": 0, survivalRate: 100 }, "the approved Visit 1 appears at once");
      const positions = await registered(), visit1Markers = await markers();
      assert.deepEqual(visit1Markers.map(tree => tree.treeId), trees, "one marker per permanent Tree ID");
      for (const tree of visit1Markers) {
        assert.deepEqual([tree.latitude, tree.longitude], positions[tree.treeId], `${tree.treeId} is drawn at its stored registration GPS`);
        assert.deepEqual([tree.condition, tree.visitNumber, tree.dateMonitored, tree.siteName], ["Healthy", 1, v1Date, "Emulator Site"]);
      }
      assert.deepEqual
([approved.body.data.visitDate, approved.body.data.startedOn], [v1Date, today]);
      assert.deepEqual((await db.collection("verifiedPlantingCohorts").doc(cohortIdFor(reportId)).get()).data().baseline.sampleUnits.map(unit => unit.permanentId), trees);
      // Visit 2 is due on the day Visit 1 was opened: it must still be its own visit.
      const second = await api(`/verified-sample-monitoring/cohorts/${cohortIdFor(reportId)}/visits`, "staffA", "POST", { visitDate: due2 }); assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.notEqual(second.body.data.id, visit.id); assert.deepEqual([second.body.data.visitNumber, second.body.data.priorVisitId, second.body.data.sampleAssessments.map(entry => entry.sampleId).join()], [2, visit.id, trees.join()]);
      const again = await api(`/verified-sample-monitoring/cohorts/${cohortIdFor(reportId)}/visits`, "staffA", "POST", { visitDate: due2 }); assert.equal(again.body.data?.id, second.body.data.id, JSON.stringify(again.body));
      for (const tree of trees) await capture(second.body.data.id, tree);
      const visit2Rows = rows(50);
      visit2Rows[0] = { ...visit2Rows[0], condition: "Damaged" };
      visit2Rows[1] = { sampleId: trees[1], condition: "Dead", mortalityCause: "Drought", remarks: "Dried out" };
      const submit2 = await put(second.body.data.id, { assessments: visit2Rows, submit: true, dateMonitored: today }); assert.equal(submit2.status, 200, JSON.stringify(submit2.body));
      assert.deepEqual([submit2.body.data.sampleAssessments[0].heightDifferenceCm, submit2.body.data.sampleAssessments.at(-1).heightDifferenceCm], [9, 10]);
      const rate2 = Number((((trees.length - 1) / trees.length) * 100).toFixed(2));
      assert.equal((await sampleRow()).visitNumber, 1, "Visit 2 awaiting review leaves Visit 1 as the latest approved result");
      const visitsBefore = (await sampleAnalytics()).summary.approvedVisits;
      assert.equal((await review(second.body.data.id, true)).status, 200);
      const sample = await sampleAnalytics(), latestRow = sample.cohorts.find(entry => entry.reportNumber === number);
      assert.deepEqual(latestRow, { cohortId: cohortIdFor(reportId), reportNumber: number, siteName: "Emulator Site", barangay: "Zone 1", visitNumber: 2, date: today,
        total: trees.length, Healthy: trees.length - 2, Damaged: 1, Dead: 1, "Needs Rechecking": 0, survivalRate: rate2 }, "Visit 2 replaces Visit 1: the same Tree IDs count once, damaged trees survive");
      assert.deepEqual([sample.summary.totalSampleTrees, sample.summary.approvedVisits], [sample.cohorts.reduce((total, entry) => total + entry.total, 0), visitsBefore + 1],
        "trees count once per planting; the approval adds one visit");
      const filtered = (await api("/analytics/dashboard?barangay=Zone%201", "admin")).body.data.permanentSample;
      assert.ok(filtered.cohorts.some(entry => entry.reportNumber === number));
      assert.deepEqual((await api("/analytics/dashboard?barangay=Bical", "admin")).body.data.permanentSample.cohorts, []);
      const visit2Markers = await markers();
      assert.deepEqual(visit2Markers.map(tree => [tree.treeId, tree.condition, tree.visitNumber]), trees.map((tree, i) => [tree, i === 0 ? "Damaged" : i === 1 ? "Dead" : "Healthy", 2]),
        "Visit 2 updates the same Tree IDs in place: no second marker");
      assert.deepEqual(visit2Markers.map(tree => [tree.latitude, tree.longitude]), trees.map(tree => positions[tree]), "approval never moves a registered tree");
      assert.equal(visit2Markers[0].heightCentimeters, 50); assert.equal(visit2Markers[1].heightCentimeters, null, "a dead tree has no height");
      const dashboard = (await api("/analytics/dashboard", "admin")).body.data;
      assert.equal(dashboard.summary.sampleSurvivalRate, dashboard.permanentSample.summary.survivalRate, "the Sample Survival Rate KPI is the permanent-sample rate");
      assert.ok(dashboard.barangaySurvival.find(row => row.barangay === "Zone 1").sampleMonitored >= trees.length);
      assert.deepEqual(await markers("?barangay=Bical"), []);
      const visit1Only = (await api(`/analytics/dashboard?dateFrom=${v1Date}&dateTo=${v1Date}`, "admin")).body.data.permanentSample.cohorts.find(entry => entry.reportNumber === number);
      assert.deepEqual([visit1Only.visitNumber, visit1Only.survivalRate], [1, 100], "a date range ending before Visit 2 shows the Visit 1 result");
      const final = await lifecycle();
      assert.deepEqual([final.permanentSample.startMonitoringDate, final.permanentSample.nextMonitoringDate, final.permanentSample.approvedVisits, final.permanentSample.nextVisitNumber, final.permanentSample.latest.survivalRate], [v1Date, due3, 2, 3, rate2]);
      assert.equal(JSON.stringify((await monRef.get()).data()), stored, "the lifecycle document is never rewritten");
      assert.equal((await db.collection("monitoringRecords").get()).size, lifecycles, "no lifecycle is created");
      assert.equal(await officialSummary(), analyticsBefore, "official aggregate analytics are unchanged (only the sample survival KPI moves)");
    } finally { await monRef.delete(); }
  });
}
