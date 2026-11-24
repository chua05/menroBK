// B6: real Auth/Firestore/Storage emulator lifecycle for the permanent-sample first visit as baseline registration.
// Visit 1 registers the 10% sample and baseline (real capture-session evidence), is returned, resubmitted and approved;
// the sample locks; visit 2 opens on visit 1's Date Monitored + 1 calendar month with the same Tree IDs, a carried-forward
// locked death and growth differences; approving visit 2 schedules visit 3 three months after visit 2's planned date.
// No clock is mocked: the visit dates are chosen in the past (or today) relative to the real Asia/Manila date.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const sharp = require("sharp");

// Isolated legacy-monitoring emulator topology (demo project, loopback hosts), credential-free, set for THIS process only.
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG",
  "PERMANENT_SAMPLE_PILOT_ENABLED", "PERMANENT_SAMPLE_PILOT_USER_IDS", "PERMANENT_SAMPLE_PILOT_COHORT_IDS", "PERMANENT_SAMPLE_WRITE_PAUSED",
  "MENRO_PHASE3C_ISOLATED_EMULATORS", "MENRO_BASELINE_EVIDENCE_ACCEPTANCE", "MENRO_REQUEST_LETTER_ACCEPTANCE", "MENRO_MPDO_BOUNDARY_ACCEPTANCE"]) delete process.env[key];
process.env.MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS = "true";
const topology = require("../helpers/emulatorTestTopology");
Object.assign(process.env, {
  NODE_ENV: "test",
  MENRO_INTEGRATION_TEST: "true",
  GCLOUD_PROJECT: topology.project,
  FIREBASE_PROJECT_ID: topology.project,
  FIRESTORE_EMULATOR_HOST: topology.firestore,
  FIREBASE_AUTH_EMULATOR_HOST: topology.auth,
  FIREBASE_STORAGE_EMULATOR_HOST: topology.storage,
  FIREBASE_STORAGE_BUCKET: topology.bucket,
  EVIDENCE_STORAGE_PROVIDER: "firebase",
  EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true",
  EVIDENCE_CLOUD_READ_ENABLED: "true",
  VERIFIED_PLANTING_COHORT_ENABLED: "true",
  PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "true",
  PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true",
  MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-first-visit-baseline-${process.pid}`),
});
const validation = require("../../src/config/integrationEnvironment").validateIntegrationEnvironment();
assert.equal(validation.integration, true);
assert.equal(validation.legacyMonitoringIsolated, true);
assert.equal(validation.projectId, "demo-menro-legacy-monitoring-20261106");
assert.equal(topology.isolated, true);
for (const [key, host] of [["FIRESTORE_EMULATOR_HOST", topology.firestore], ["FIREBASE_AUTH_EMULATOR_HOST", topology.auth], ["FIREBASE_STORAGE_EMULATOR_HOST", topology.storage]]) {
  assert.equal(process.env[key], host); assert.match(host, /^127\.0\.0\.1:\d+$/);
}
for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) assert.equal(process.env[name], undefined);

const { db, auth, getStorageBucket } = require("../../src/config/firebase");
const app = require("../../src/app");
const visitService = require("../../src/services/sampleMonitoringVisit.service");
const cohortService = require("../../src/services/verifiedPlantingCohort.service");
const purposePolicy = require("../../src/services/purposePolicy.service");
const schedule = require("../../src/config/permanentSampleSchedule");

const prefix = `first-visit-baseline-${crypto.randomUUID()}`;
const ids = Object.fromEntries(["staffA", "staffB", "admin"].map(role => [role, `${prefix}-${role}`]));
const cleanupCreated = require("../helpers/emulatorCreatedResources").trackEmulatorCreatedResources({ db, auth, getBucket: getStorageBucket, prefix, users: ids });
const password = "Local-First-Visit-Fixture-2026!";
const SITE = { latitude: 12.662301, longitude: 123.932983 };
const siteId = `${prefix}-site`;
const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
const tokens = {};
let server, base;

// ---- Dates (real Asia/Manila "today", no clock mocking) -------------------------------------------------------------
const pad = n => String(n).padStart(2, "0");
// Independent month arithmetic for expectations (anchor day kept, clamped to month end).
function plusMonths(value, months) {
  const [y, m, d] = value.split("-").map(Number);
  const abs = y * 12 + (m - 1) + months, ty = Math.floor(abs / 12), tm = abs % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${pad(tm + 1)}-${pad(Math.min(d, last))}`;
}
const today = schedule.dateOnlyInManila();
const [ty, tm] = today.split("-").map(Number);
const monthsBack = k => { const abs = ty * 12 + (tm - 1) - k; return [Math.floor(abs / 12), (abs % 12) + 1]; };
const [v1y, v1m] = monthsBack(2);
const V1_DATE = `${v1y}-${pad(v1m)}-15`;              // visit 1 visit date and Date Monitored (two months ago, day 15)
const PLANTING_DATE = `${v1y}-${pad(v1m)}-01`;
const V2_DUE = plusMonths(V1_DATE, 1);                  // one calendar month after visit 1's Date Monitored (in the past)
const V3_DUE = plusMonths(V2_DUE, 3);                   // three calendar months after visit 2's PLANNED date (in the future)
const NOT_OPEN_V2_DUE = plusMonths(today, 1);           // cohort whose visit 1 is monitored today: visit 2 not yet open
assert.ok(V2_DUE <= today && V3_DUE > today && NOT_OPEN_V2_DUE > today, `date setup ${V1_DATE} ${V2_DUE} ${V3_DUE} ${today}`);

// ---- HTTP helpers ----------------------------------------------------------------------------------------------------
async function signIn(email) {
  const response = await fetch(`http://${topology.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.idToken;
}
async function api(route, role = "staffA", method = "GET", body, headers = {}) {
  const response = await fetch(base + route, { method, headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}),
    ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const visitsOf = async cohortId => (await db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortId).get()).docs;
const cohortDoc = async cohortId => (await db.collection("verifiedPlantingCohorts").doc(cohortId).get()).data();
const createVisit = (cohortId, visitDate, role = "staffA") => api(`/verified-sample-monitoring/cohorts/${cohortId}/visits`, role, "POST", { visitDate });
const saveVisit = (visitId, payload, role = "staffA") => api(`/verified-sample-monitoring/visits/${visitId}`, role, "PUT", payload);
const reviewVisit = (visitId, payload, role = "admin") => api(`/verified-sample-monitoring/visits/${visitId}/review`, role, "POST", payload);
const getVisit = (visitId, role = "staffA") => api(`/verified-sample-monitoring/visits/${visitId}`, role);
const row = (visit, sampleId) => visit.sampleAssessments.find(entry => entry.sampleId === sampleId);

// Seeds an Admin-verified single-species planting report with the PERMANENT_SAMPLE policy, then provisions its
// cohort through the real ensureCohortForAuthoritativeReportInTransaction path used when a report is verified.
async function seedReportAndCohort(key, quantity) {
  const reportId = `${prefix}-report-${key}`, reportNumber = `PR-B6${tag}-${key.toUpperCase()}`;
  const reportingPolicy = purposePolicy.releasePolicy({ policyVersion: 1, approvedBy: ids.admin, policyStatus: "APPROVED",
    definition: { purpose: "Reforestation", reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE", quantityThreshold: null },
    sampling: purposePolicy.initialPolicy().sampling }, quantity);
  assert.equal(reportingPolicy.monitoring, "PERMANENT_SAMPLE");
  const report = { reportNumber, siteId, species: "Narra", quantityPlanted: quantity, verificationStatus: "Approved",
    reportingProgress: "Completed", plantingDate: PLANTING_DATE, reportingPolicy, testFixture: prefix };
  await db.collection("plantingReports").doc(reportId).set(report);
  const cohort = await db.runTransaction(tx => cohortService.ensureCohortForAuthoritativeReportInTransaction(tx, { reportId, report }));
  assert.ok(cohort?.created, "cohort must be provisioned from the verified report");
  assert.equal(cohort.verifiedPlantedQuantity, quantity); assert.equal(cohort.source.siteId, siteId);
  assert.equal(cohort.samplingPlan, undefined); assert.equal(cohort.baseline, null);
  return { cohortId: cohort.id, reportId, reportNumber };
}

// Real camera capture-session path: create session -> server GPS/nonce verification -> private upload + link.
const captured = new Map(); // `${visitId}|${sampleId}|${revision}` -> bytes
async function captureEvidence(visitId, sampleId, role = "staffA") {
  const visit = await visitService.get(visitId);
  const assessment = row(visit, sampleId);
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: `#${crypto.randomBytes(3).toString("hex")}` } }).jpeg().toBuffer();
  const sessionResponse = await api("/evidence-capture-sessions", role, "POST", { workflow: "sample-monitoring", cohortId: visit.cohortId, siteId: visit.siteId,
    visitId, sampleId, samplingPlanVersion: visit.samplingPlanVersion, baselineVersion: visit.baselineVersion, visitVersion: visit.version,
    assessmentRevision: Number(assessment.assessmentRevision || 0) });
  assert.equal(sessionResponse.status, 201, JSON.stringify(sessionResponse.body));
  const session = sessionResponse.body.data;
  const verify = new FormData();
  verify.set("photo", new Blob([bytes], { type: "image/jpeg" }), "capture.jpg");
  verify.set("nonce", session.nonce); verify.set("capturedAt", new Date().toISOString());
  verify.set("latitude", String(SITE.latitude)); verify.set("longitude", String(SITE.longitude)); verify.set("accuracy", "5");
  verify.set("clientImageSha256", crypto.createHash("sha256").update(bytes).digest("hex"));
  const verifiedResponse = await fetch(`${base}/evidence-capture-sessions/${session.captureSessionId}/verify`, { method: "POST", headers: { authorization: `Bearer ${tokens[role]}` }, body: verify });
  const verifiedBody = await verifiedResponse.json(); assert.equal(verifiedResponse.status, 200, JSON.stringify(verifiedBody));
  const verified = verifiedBody.data;
  const form = new FormData();
  form.set("expectedVisitVersion", String(visit.version)); form.set("assessmentRevision", String(Number(assessment.assessmentRevision || 0)));
  form.set("evidenceManifest", JSON.stringify([{ source: "browser-camera", captureSessionId: session.captureSessionId, nonce: session.nonce,
    verificationId: verified.verificationId, imageSha256: verified.imageSha256 }]));
  form.set("photos", new Blob([bytes], { type: "image/jpeg" }), "tree.jpg");
  const uploaded = await fetch(`${base}/verified-sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence`, { method: "PUT",
    headers: { authorization: `Bearer ${tokens[role]}`, "Idempotency-Key": `b6_${crypto.randomBytes(8).toString("hex")}` }, body: form });
  const uploadedBody = await uploaded.json(); assert.equal(uploaded.status, 200, JSON.stringify(uploadedBody));
  assert.equal(JSON.stringify(uploadedBody).includes("privateEvidence"), false);
  const stored = row((await db.collection("sampleMonitoringVisits").doc(visitId).get()).data(), sampleId);
  const latest = stored.evidenceHistory.at(-1);
  assert.equal(latest.revision, Number(assessment.assessmentRevision || 0)); assert.ok(latest.privateEvidence?.objectName);
  assert.equal(latest.captureSessionId, session.captureSessionId);
  assert.equal(latest.location.latitude, SITE.latitude); assert.equal(latest.location.longitude, SITE.longitude);
  captured.set(`${visitId}|${sampleId}|${latest.revision}`, bytes);
  return bytes;
}

// Full visit 1 for a small secondary cohort (one tree), used for the "not yet open" and history-redaction checks.
async function completeFirstVisit(cohortId, visitDate, role) {
  const created = await createVisit(cohortId, visitDate, role); assert.equal(created.status, 201, JSON.stringify(created.body));
  const visitId = created.body.data.id, [tree] = created.body.data.sampleAssessments.map(entry => entry.sampleId);
  await captureEvidence(visitId, tree, role);
  const current = (await visitService.get(visitId)).version;
  const submitted = await saveVisit(visitId, { expectedVersion: current, submit: true, dateMonitored: visitDate,
    assessments: [{ sampleId: tree, condition: "Healthy", heightCentimeters: 40, stemDiameterMillimeters: 6, remarks: "Registered" }] }, role);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const approved = await reviewVisit(visitId, { expectedVersion: submitted.body.data.version, approve: true, reasons: "" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.data.status, "APPROVED");
  return { visitId, tree };
}

const main = {}; // shared lifecycle state across the ordered steps
let notOpen, redaction;

test.before(async () => {
  for (const [role, uid] of Object.entries(ids)) {
    const email = `${uid}@example.test`;
    await auth.createUser({ uid, email, password, emailVerified: true });
    await db.collection("users").doc(uid).set({ role: role === "admin" ? "admin" : "staff", status: "active", fullName: `B6 ${role}`, testFixture: prefix });
    tokens[role] = await signIn(email);
  }
  await db.collection("sites").doc(siteId).set({ siteName: "B6 emulator site", ...SITE, coverageRadiusMeters: 50, status: "Active", testFixture: prefix });
  Object.assign(main, await seedReportAndCohort("main", 25));
  notOpen = await seedReportAndCohort("notopen", 8);
  redaction = await seedReportAndCohort("redact", 7);
  main.treeIds = ["T001", "T002", "T003"].map(suffix => `${main.reportNumber}-${suffix}`);
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  const bucket = await getStorageBucket();
  for (const cohort of [main, notOpen, redaction].filter(c => c?.cohortId)) {
    for (const doc of await visitsOf(cohort.cohortId)) {
      for (const assessment of doc.data().sampleAssessments || []) for (const entry of assessment.evidenceHistory || []) {
        if (entry.privateEvidence?.objectName) await bucket.file(entry.privateEvidence.objectName).delete().catch(() => undefined);
      }
      for (const hash of (await db.collection("sampleMonitoringEvidenceHashes").where("visitId", "==", doc.id).get()).docs) await hash.ref.delete();
      await doc.ref.delete();
    }
    await db.collection("verifiedPlantingCohorts").doc(cohort.cohortId).delete();
    await db.collection("plantingReports").doc(cohort.reportId).delete();
  }
  await db.collection("sites").doc(siteId).delete();
  for (const uid of Object.values(ids)) await db.collection("users").doc(uid).delete();
  await cleanupCreated(); await cleanupCreated();
  for (const cohort of [main, notOpen, redaction].filter(c => c?.cohortId)) assert.equal((await visitsOf(cohort.cohortId)).length, 0);
});

test("1-2. seeded verified single-species report (25) is eligible in readiness with FIRST_VISIT_REGISTERS_BASELINE and sampleTarget 3", async () => {
  const cohort = await cohortDoc(main.cohortId);
  assert.equal(cohort.source.plantingReportId, main.reportId); assert.deepEqual(cohort.source.species.map(s => s.species), ["Narra"]);
  const readiness = await api("/verified-sample-monitoring/readiness");
  assert.equal(readiness.status, 200, JSON.stringify(readiness.body));
  const rowFor = list => list.find(entry => entry.cohortId === main.cohortId);
  const ready = rowFor(readiness.body.data.cohorts);
  assert.ok(ready, "main cohort listed");
  assert.equal(ready.registersBaseline, true); assert.equal(ready.sampleTarget, 3); assert.equal(ready.canCreateVisit, true);
  assert.deepEqual(ready.reasons, [{ code: "FIRST_VISIT_REGISTERS_BASELINE", informational: true, sampleTarget: 3 }]);
  assert.equal(ready.reportNumber, main.reportNumber);
  assert.ok(rowFor(readiness.body.data.eligible)); assert.equal(rowFor(readiness.body.data.notEligible), undefined);
  assert.equal(readiness.body.data.schedulingPolicyStatus, "ACTIVE");
  // The 1-tree secondary cohorts: ceil(8 * 10%) = 1 and ceil(7 * 10%) = 1.
  for (const cohort of [notOpen, redaction]) assert.equal(readiness.body.data.cohorts.find(r => r.cohortId === cohort.cohortId).sampleTarget, 1);
});

test("3. Staff A creates visit 1: 3 report-number Tree IDs, DRAFT plan, duplicate creates idempotent or refused", async () => {
  const created = await createVisit(main.cohortId, V1_DATE);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const visit = created.body.data; main.v1 = visit.id;
  assert.equal(visit.registersBaseline, true); assert.equal(visit.visitNumber, 1); assert.equal(visit.status, "DRAFT");
  assert.equal(visit.visitDate, V1_DATE); assert.equal(visit.priorVisitId, null); assert.equal(visit.schedulePolicyVersion, schedule.POLICY_VERSION);
  assert.deepEqual(visit.sampleAssessments.map(entry => entry.sampleId), main.treeIds);
  assert.equal(visit.visitContext.registersBaseline, true); assert.equal(visit.visitContext.sampleTarget, 3);
  let cohort = await cohortDoc(main.cohortId);
  assert.equal(cohort.samplingPlan.status, "DRAFT"); assert.equal(cohort.samplingPlan.origin, "FIRST_VISIT");
  assert.equal(cohort.samplingPlan.version, 1); assert.equal(cohort.samplingPlan.provisionalTarget, 3);
  assert.deepEqual(cohort.samplingPlan.selectedSamples.map(sample => sample.permanentId), main.treeIds);
  assert.equal(cohort.samplingPlanHistory.length, 1);
  // Same actor, same date: idempotent (same visit). Other Staff / other date / concurrent: OPEN_VISIT_EXISTS.
  const again = await createVisit(main.cohortId, V1_DATE); assert.equal(again.status, 201); assert.equal(again.body.data.id, main.v1);
  const otherStaff = await createVisit(main.cohortId, V1_DATE, "staffB"); assert.equal(otherStaff.status, 409); assert.equal(otherStaff.body.code, "OPEN_VISIT_EXISTS");
  const concurrent = await Promise.all([V1_DATE.replace(/-15$/, "-16"), V1_DATE.replace(/-15$/, "-17")].map(date => createVisit(main.cohortId, date)));
  for (const result of concurrent) { assert.equal(result.status, 409, JSON.stringify(result.body)); assert.equal(result.body.code, "OPEN_VISIT_EXISTS"); }
  assert.equal((await visitsOf(main.cohortId)).length, 1);
  cohort = await cohortDoc(main.cohortId);
  assert.equal(cohort.samplingPlan.version, 1); assert.equal(cohort.samplingPlanHistory.length, 1);
});

test("4. real capture-session evidence per tree, draft with cm/mm and a Dead tree with cause persists and reopens", async () => {
  for (const tree of main.treeIds) await captureEvidence(main.v1, tree);
  const [t1, t2, t3] = main.treeIds;
  const version = (await visitService.get(main.v1)).version;
  main.v1Assessments = [
    { sampleId: t1, condition: "Healthy", heightCentimeters: 50, stemDiameterMillimeters: 8, remarks: "Vigorous" },
    { sampleId: t2, condition: "Damaged", heightCentimeters: 45, stemDiameterMillimeters: 7, remarks: "Leaf damage" },
    { sampleId: t3, condition: "Dead", mortalityCause: "Drought", remarks: "Dry and brittle, no live buds" },
  ];
  const draft = await saveVisit(main.v1, { expectedVersion: version, submit: false, dateMonitored: V1_DATE, visitRemarks: "Baseline registration", assessments: main.v1Assessments });
  assert.equal(draft.status, 200, JSON.stringify(draft.body)); assert.equal(draft.body.data.status, "DRAFT");
  const reopened = await getVisit(main.v1);
  assert.equal(reopened.status, 200); const v = reopened.body.data;
  assert.equal(v.status, "DRAFT"); assert.equal(v.dateMonitored, V1_DATE); assert.equal(v.version, version + 1);
  assert.deepEqual([row(v, t1).condition, row(v, t1).heightCentimeters, row(v, t1).stemDiameterMillimeters, row(v, t1).diameterCentimeters], ["Healthy", 50, 8, 0.8]);
  assert.deepEqual([row(v, t2).condition, row(v, t2).heightCentimeters, row(v, t2).stemDiameterMillimeters], ["Damaged", 45, 7]);
  assert.deepEqual([row(v, t3).condition, row(v, t3).mortalityCause, row(v, t3).heightCentimeters, row(v, t3).diameterCentimeters], ["Dead", "Drought", null, null]);
  for (const tree of main.treeIds) {
    assert.equal(row(v, tree).evidenceHistory.length, 1); assert.equal(row(v, tree).assessedOn, today);
    assert.equal(row(v, tree).baselineOnly, true);
  }
  assert.equal(JSON.stringify(reopened.body).includes("privateEvidence"), false);
  assert.deepEqual([v.summary.healthy, v.summary.damaged, v.summary.confirmedDead, v.summary.survivalRate, v.summary.survivalStatus], [1, 1, 1, 66.67, "COMPLETE"]);
  // Draft markers come only from server-verified capture GPS.
  assert.deepEqual(v.visitContext.treeMarkers.map(marker => [marker.sampleId, marker.kind, marker.gpsVerification]), main.treeIds.map(id => [id, "DRAFT", "VERIFIED"]));
});

test("5. submit: visit PENDING, plan PENDING_ADMIN_APPROVAL, Admin notification created", async () => {
  const version = (await visitService.get(main.v1)).version;
  const submitted = await saveVisit(main.v1, { expectedVersion: version, submit: true, dateMonitored: V1_DATE, assessments: main.v1Assessments });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.data.status, "PENDING_ADMIN_APPROVAL"); assert.equal(submitted.body.data.submissionRevision, 1);
  assert.equal((await cohortDoc(main.cohortId)).samplingPlan.status, "PENDING_ADMIN_APPROVAL");
  const notification = await db.collection("notifications").doc(`sample_monitoring_visit_submitted_${main.v1}_1_${ids.admin}`).get();
  assert.equal(notification.exists, true);
  const n = notification.data();
  assert.equal(n.type, "sample_monitoring_visit_submitted"); assert.equal(n.recipientUserId, ids.admin);
  assert.equal(n.relatedRecordType, "sampleMonitoringVisit"); assert.equal(n.relatedRecordId, main.v1);
  assert.deepEqual(n.details.summary, { total: 3, completed: 3, needsRechecking: 0, survivalStatus: "COMPLETE" });
  assert.equal(JSON.stringify(n).includes("privateEvidence"), false);
  // No Staff notification for the submitter.
  assert.equal((await db.collection("notifications").doc(`sample_monitoring_visit_submitted_${main.v1}_1_${ids.staffA}`).get()).exists, false);
  // Pending visit is no longer editable by its creator.
  assert.equal((await saveVisit(main.v1, { expectedVersion: submitted.body.data.version, submit: false, assessments: main.v1Assessments })).status, 409);
});

test("6. Admin returns with a reason; Staff A edits one tree (new evidence revision) and resubmits; Tree IDs unchanged", async () => {
  let visit = await visitService.get(main.v1);
  const blank = await reviewVisit(main.v1, { expectedVersion: visit.version, approve: false, reasons: "  " }); assert.equal(blank.status, 400);
  const returned = await reviewVisit(main.v1, { expectedVersion: visit.version, approve: false, reasons: "Re-measure the damaged tree height." });
  assert.equal(returned.status, 200, JSON.stringify(returned.body)); assert.equal(returned.body.data.status, "RETURNED");
  assert.equal(returned.body.data.reviewReasons, "Re-measure the damaged tree height.");
  let cohort = await cohortDoc(main.cohortId);
  assert.equal(cohort.samplingPlan.status, "RETURNED"); assert.equal(cohort.samplingPlan.reviewRemarks, "Re-measure the damaged tree height.");
  assert.equal(cohort.baseline, null);
  const [, t2] = main.treeIds;
  main.v1Assessments = main.v1Assessments.map(entry => entry.sampleId === t2 ? { ...entry, heightCentimeters: 46, remarks: "Leaf damage, re-measured" } : entry);
  visit = await visitService.get(main.v1);
  const edited = await saveVisit(main.v1, { expectedVersion: visit.version, submit: false, dateMonitored: V1_DATE, assessments: main.v1Assessments });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(row(edited.body.data, t2).assessmentRevision, 1); assert.equal(row(edited.body.data, main.treeIds[0]).assessmentRevision, 0);
  // The correction makes T002's revision-0 photo stale: submit is refused until revision-1 evidence is captured.
  const stale = await saveVisit(main.v1, { expectedVersion: edited.body.data.version, submit: true, dateMonitored: V1_DATE, assessments: main.v1Assessments });
  assert.equal(stale.status, 409, JSON.stringify(stale.body)); assert.equal(stale.body.code, "CURRENT_SAMPLE_EVIDENCE_REQUIRED");
  await captureEvidence(main.v1, t2);
  visit = await visitService.get(main.v1);
  const resubmitted = await saveVisit(main.v1, { expectedVersion: visit.version, submit: true, dateMonitored: V1_DATE, assessments: main.v1Assessments });
  assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
  assert.equal(resubmitted.body.data.status, "PENDING_ADMIN_APPROVAL"); assert.equal(resubmitted.body.data.submissionRevision, 2);
  assert.deepEqual(resubmitted.body.data.sampleAssessments.map(entry => entry.sampleId), main.treeIds);
  cohort = await cohortDoc(main.cohortId);
  assert.equal(cohort.samplingPlan.status, "PENDING_ADMIN_APPROVAL"); assert.equal(cohort.samplingPlan.version, 1);
  assert.deepEqual(cohort.samplingPlan.selectedSamples.map(sample => sample.permanentId), main.treeIds);
  assert.equal((await db.collection("notifications").doc(`sample_monitoring_visit_submitted_${main.v1}_2_${ids.admin}`).get()).exists, true);
});

test("7. Admin approves: plan + baseline APPROVED and locked (409 FIRST_VISIT_BASELINE_ACTIVE); baseline photo resolves", async () => {
  const visit = await visitService.get(main.v1);
  const approved = await reviewVisit(main.v1, { expectedVersion: visit.version, approve: true, reasons: "" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, "APPROVED"); assert.equal(approved.body.data.nextScheduledDueDate, V2_DUE);
  const cohort = await cohortDoc(main.cohortId);
  assert.equal(cohort.samplingPlan.status, "APPROVED"); assert.equal(cohort.samplingPlan.version, 1);
  assert.equal(cohort.baseline.approvalStatus, "APPROVED"); assert.deepEqual(cohort.baseline.source, { type: "FIRST_VISIT", visitId: main.v1 });
  assert.equal(cohort.baselineVersion, 1); assert.equal(cohort.baselineStatus, "REGISTERED");
  assert.deepEqual(cohort.baseline.sampleUnits.map(unit => unit.permanentId), main.treeIds);
  const [t1, t2, t3] = main.treeIds, unit = id => cohort.baseline.sampleUnits.find(u => u.permanentId === id);
  assert.deepEqual([unit(t1).condition, unit(t1).heightMeters, unit(t2).condition, unit(t2).heightMeters, unit(t3).condition], ["Healthy", 0.5, "Damaged", 0.46, "Dead"]);
  assert.equal(unit(t2).photoReferences[0].sourceAssessmentRevision, 1);
  assert.equal(JSON.stringify(cohort.baseline).includes("privateEvidence"), false);
  assert.deepEqual([cohort.permanentSampleSchedule.nextVisitNumber, cohort.permanentSampleSchedule.nextScheduledDueDate, cohort.permanentSampleSchedule.lastActualVisitDate], [2, V2_DUE, V1_DATE]);
  // Locked: legacy plan and baseline routes refuse the FIRST_VISIT cohort.
  const plan = await api(`/verified-planting-cohorts/${main.cohortId}/sampling-plan`, "staffA", "PUT", { expectedVersion: 1, selectionMethod: "documented-manual",
    selectedSamples: main.treeIds.map(permanentId => ({ permanentId, unitType: "tree", species: "Narra", siteReference: siteId, selectionReason: "Replace" })) });
  assert.equal(plan.status, 409, JSON.stringify(plan.body)); assert.equal(plan.body.code, "FIRST_VISIT_BASELINE_ACTIVE");
  const planApprove = await api(`/verified-planting-cohorts/${main.cohortId}/sampling-plan/approve`, "admin", "POST", { expectedVersion: 1, approve: true });
  assert.equal(planApprove.status, 409, JSON.stringify(planApprove.body)); assert.equal(planApprove.body.code, "FIRST_VISIT_BASELINE_ACTIVE");
  await assert.rejects(cohortService.registerBaseline({ cohortId: main.cohortId, actorId: ids.staffA, expectedVersion: 1, status: "REGISTERED",
    sampleUnits: [{ permanentId: t1, unitType: "tree", latitude: SITE.latitude, longitude: SITE.longitude, condition: "Healthy", captureDate: today,
      photoReferences: [{ evidenceId: "b6-replacement-photo", capturedAt: new Date().toISOString() }] }] }),
  error => error.status === 409 && error.code === "FIRST_VISIT_BASELINE_ACTIVE");
  const baselineApprove = await api(`/verified-planting-cohorts/${main.cohortId}/baseline/approve`, "admin", "POST", { expectedVersion: 1, approve: true });
  assert.equal(baselineApprove.status, 409, JSON.stringify(baselineApprove.body)); assert.equal(baselineApprove.body.code, "FIRST_VISIT_BASELINE_ACTIVE");
  const after = await cohortDoc(main.cohortId);
  assert.deepEqual(after.baseline.sampleUnits.map(u => u.permanentId), main.treeIds); assert.equal(after.samplingPlan.version, 1);
  // Approved visit 1 is immutable.
  assert.equal((await saveVisit(main.v1, { expectedVersion: approved.body.data.version, submit: false, assessments: main.v1Assessments })).status, 409);
  // Baseline photo resolves through the first-visit route to the exact current-revision bytes.
  for (const [tree, revision] of [[t1, 0], [t2, 1], [t3, 0]]) {
    const response = await fetch(`${base}/evidence/verified-planting-cohorts/${main.cohortId}/baseline/${tree}/photos/0`, { headers: { authorization: `Bearer ${tokens.admin}` } });
    assert.equal(response.status, 200, tree);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), captured.get(`${main.v1}|${tree}|${revision}`));
  }
  assert.equal((await fetch(`${base}/evidence/verified-planting-cohorts/${main.cohortId}/baseline/${t1}/photos/0`)).status, 401);
});

test("8. visit 2: due = visit 1 Date Monitored + 1 month; not open before due (VISIT_NOT_OPEN); same IDs, locked Dead, growth", async () => {
  // Not-yet-open cohort: visit 1 monitored today, so visit 2 is due one month from today and cannot be created yet.
  const first = await completeFirstVisit(notOpen.cohortId, today, "staffA");
  assert.equal((await visitService.get(first.visitId)).nextScheduledDueDate, NOT_OPEN_V2_DUE);
  const early = await createVisit(notOpen.cohortId, NOT_OPEN_V2_DUE);
  assert.equal(early.status, 409, JSON.stringify(early.body)); assert.equal(early.body.code, "VISIT_NOT_OPEN");
  const earlyToday = await createVisit(notOpen.cohortId, today);
  assert.equal(earlyToday.status, 409); assert.equal(earlyToday.body.code, "VISIT_SCHEDULE_MISMATCH");
  assert.equal((await visitsOf(notOpen.cohortId)).length, 1);
  // Readiness after visit-1 approval is captured here and asserted in step 8b (it must agree with create).
  main.readinessAfterV1 = await api("/verified-sample-monitoring/readiness");

  // Main cohort: visit 2 is due (in the past, overdue) on V2_DUE; any other date is refused, the due date is accepted.
  const mismatch = await createVisit(main.cohortId, today);
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, "VISIT_SCHEDULE_MISMATCH");
  const created = await createVisit(main.cohortId, V2_DUE);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const visit = created.body.data; main.v2 = visit.id;
  assert.deepEqual([visit.visitNumber, visit.scheduledDueDate, visit.openingDate, visit.priorVisitId, visit.scheduleStatus, visit.registersBaseline],
    [2, V2_DUE, V2_DUE, main.v1, V2_DUE < today ? "OVERDUE" : "DUE", undefined]);
  assert.deepEqual(visit.sampleAssessments.map(entry => entry.sampleId), main.treeIds);
  const [t1, t2, t3] = main.treeIds;
  assert.equal(row(visit, t3).condition, "Dead"); assert.equal(row(visit, t3).mortalityCause, "Drought");
  assert.deepEqual(row(visit, t3).inheritedConfirmedDead, { visitId: main.v1, assessmentRevision: 0 });
  assert.equal(row(visit, t1).condition, null);
  // Partial draft: one tree unassessed -> PENDING_INCOMPLETE, no rate.
  const deadRow = { sampleId: t3, condition: "Dead", mortalityCause: "Drought", remarks: row(visit, t3).remarks };
  const partial = await saveVisit(main.v2, { expectedVersion: visit.version, submit: false,
    assessments: [{ sampleId: t1, condition: "Healthy", heightCentimeters: 60, stemDiameterMillimeters: 10, remarks: "Growing" }, { sampleId: t2, condition: null }, deadRow] });
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  assert.deepEqual([partial.body.data.summary.notAssessed, partial.body.data.summary.survivalRate, partial.body.data.summary.survivalStatus], [1, null, "PENDING_INCOMPLETE"]);
  // The carried-forward death is locked.
  const locked = await saveVisit(main.v2, { expectedVersion: partial.body.data.version, submit: false,
    assessments: [{ sampleId: t1, condition: "Healthy", heightCentimeters: 60, stemDiameterMillimeters: 10, remarks: "Growing" }, { sampleId: t2, condition: null },
      { sampleId: t3, condition: "Healthy", heightCentimeters: 10, stemDiameterMillimeters: 2, remarks: "Revived?" }] });
  assert.equal(locked.status, 409, JSON.stringify(locked.body)); assert.equal(locked.body.code, "CONFIRMED_DEAD_LOCKED");
  const lockedCause = await saveVisit(main.v2, { expectedVersion: partial.body.data.version, submit: false,
    assessments: [{ sampleId: t1, condition: "Healthy", heightCentimeters: 60, stemDiameterMillimeters: 10, remarks: "Growing" }, { sampleId: t2, condition: null },
      { ...deadRow, mortalityCause: "Flooding" }] });
  assert.equal(lockedCause.status, 409); assert.equal(lockedCause.body.code, "CONFIRMED_DEAD_LOCKED");
  // Before submission Staff B sees none of Staff A's unapproved visit ids.
  main.staffBDuringDraft = [await api("/verified-sample-monitoring/readiness", "staffB"), await api("/verified-sample-monitoring/visits", "staffB")];
  // Evidence for the living trees only; the inherited Dead row needs no new photo.
  await captureEvidence(main.v2, t1); await captureEvidence(main.v2, t2);
  main.v2Assessments = [
    { sampleId: t1, condition: "Healthy", heightCentimeters: 60, stemDiameterMillimeters: 10, remarks: "Growing" },
    { sampleId: t2, condition: "Damaged", heightCentimeters: 44, stemDiameterMillimeters: 7, remarks: "Tip broken" },
    { sampleId: t3, condition: "Dead", mortalityCause: "Drought", remarks: row(visit, t3).remarks },
  ];
  const current = await visitService.get(main.v2);
  const submitted = await saveVisit(main.v2, { expectedVersion: current.version, submit: true, dateMonitored: V2_DUE, assessments: main.v2Assessments });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const v2 = submitted.body.data;
  assert.equal(v2.status, "PENDING_ADMIN_APPROVAL");
  assert.deepEqual([row(v2, t1).heightDifferenceCm, row(v2, t1).stemDiameterDifferenceMm, row(v2, t1).measurementDecreased], [10, 2, false]);
  assert.deepEqual([row(v2, t2).heightDifferenceCm, row(v2, t2).stemDiameterDifferenceMm, row(v2, t2).measurementDecreased], [-2, 0, true]);
  assert.equal(row(v2, t1).previousMeasurement.visitId, main.v1); assert.equal(row(v2, t1).baselineOnly, false);
  assert.equal(row(v2, t3).evidenceHistory.length, 0); assert.deepEqual(row(v2, t3).inheritedConfirmedDead, { visitId: main.v1, assessmentRevision: 0 });
  assert.deepEqual([v2.summary.healthy, v2.summary.damaged, v2.summary.confirmedDead, v2.summary.living, v2.summary.survivalRate, v2.summary.survivalStatus], [1, 1, 1, 2, 66.67, "COMPLETE"]);
});

test("8b. readiness after visit-1 approval agrees with create: main cohort open on V2_DUE, not-open cohort blocked only by VISIT_NOT_OPEN", async () => {
  const readiness = main.readinessAfterV1;
  assert.equal(readiness.status, 200, JSON.stringify(readiness.body));
  const notOpenRow = readiness.body.data.cohorts.find(entry => entry.cohortId === notOpen.cohortId);
  const mainRow = readiness.body.data.cohorts.find(entry => entry.cohortId === main.cohortId);
  main.readinessEvidence = { notOpen: notOpenRow, main: mainRow };
  assert.equal(notOpenRow.canCreateVisit, false); assert.equal(notOpenRow.nextScheduledDueDate, NOT_OPEN_V2_DUE);
  assert.deepEqual([mainRow.nextVisitNumber, mainRow.nextScheduledDueDate, mainRow.registersBaseline], [2, V2_DUE, undefined]);
  // create() accepted visit 2 on V2_DUE (step 8), so readiness must list it as creatable with no blocking reason.
  assert.deepEqual({ main: mainRow.reasons.map(reason => reason.code), mainCanCreate: mainRow.canCreateVisit, notOpen: notOpenRow.reasons.map(reason => reason.code) },
    { main: [], mainCanCreate: true, notOpen: ["VISIT_NOT_OPEN"] }, JSON.stringify({ main: mainRow.reasons, notOpen: notOpenRow.reasons }));
});

test("9. approving visit 2 schedules visit 3 at visit 2's planned date + 3 months; visit 3 is not open yet", async () => {
  const visit = await visitService.get(main.v2);
  const approved = await reviewVisit(main.v2, { expectedVersion: visit.version, approve: true, reasons: "" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.data.status, "APPROVED");
  assert.equal(approved.body.data.nextScheduledDueDate, V3_DUE);
  const cohort = await cohortDoc(main.cohortId);
  assert.deepEqual([cohort.permanentSampleSchedule.nextVisitNumber, cohort.permanentSampleSchedule.nextScheduledDueDate, cohort.permanentSampleSchedule.lastApprovedVisitId], [3, V3_DUE, main.v2]);
  const early = await createVisit(main.cohortId, V3_DUE);
  assert.equal(early.status, 409); assert.equal(early.body.code, "VISIT_NOT_OPEN");
  assert.equal((await visitsOf(main.cohortId)).length, 2);
});

test("10. history rows (v1, v2, scheduled v3), survival status and Staff B redaction", async () => {
  const response = await getVisit(main.v2);
  assert.equal(response.status, 200);
  const context = response.body.data.visitContext;
  const counts = r => [r.visitNumber, r.status, r.healthy, r.damaged, r.confirmedDead, r.needsRechecking, r.notAssessed, r.survivalRate, r.survivalStatus];
  assert.equal(context.history.length, 3);
  assert.deepEqual(counts(context.history[0]), [1, "APPROVED", 1, 1, 1, 0, 0, 66.67, "COMPLETE"]);
  assert.deepEqual([context.history[0].visitId, context.history[0].dateMonitored, context.history[0].scheduledDueDate], [main.v1, V1_DATE, V1_DATE]);
  assert.deepEqual(counts(context.history[1]), [2, "APPROVED", 1, 1, 1, 0, 0, 66.67, "COMPLETE"]);
  assert.deepEqual([context.history[1].visitId, context.history[1].dateMonitored, context.history[1].scheduledDueDate], [main.v2, V2_DUE, V2_DUE]);
  const scheduled = context.history[2];
  assert.deepEqual([scheduled.visitId, scheduled.visitNumber, scheduled.status, scheduled.scheduledDueDate, scheduled.availability, scheduled.survivalStatus],
    [null, 3, "SCHEDULED", V3_DUE, "NOT_YET_AVAILABLE", null]);
  const [t1, , t3] = main.treeIds;
  assert.deepEqual(context.treeTimeline[t3].map(entry => [entry.visitNumber, entry.condition, entry.mortalityCause]), [[1, "Dead", "Drought"], [2, "Dead", "Drought"]]);
  assert.deepEqual(context.treeTimeline[t1].map(entry => [entry.heightCentimeters, entry.stemDiameterMillimeters]), [[50, 8], [60, 10]]);
  assert.deepEqual(context.treeMarkers.map(marker => [marker.sampleId, marker.kind]), main.treeIds.map(id => [id, "APPROVED"]));

  // Staff B: no route reveals Staff A's visits (draft-time snapshots and now).
  for (const res of main.staffBDuringDraft) {
    assert.equal(res.status, 200); const raw = JSON.stringify(res.body);
    assert.equal(raw.includes(main.v2), false); assert.equal(raw.includes(main.v1), false); assert.equal(raw.includes(ids.staffA), false);
  }
  for (const visitId of [main.v1, main.v2]) assert.equal((await getVisit(visitId, "staffB")).status, 404);
  // History redaction: Staff B's own approved visit 1 in another cohort while Staff A's visit 2 there is unapproved.
  const own = await completeFirstVisit(redaction.cohortId, V1_DATE, "staffB");
  const foreign = await createVisit(redaction.cohortId, plusMonths(V1_DATE, 1), "staffA");
  assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
  const viewByB = await getVisit(own.visitId, "staffB");
  assert.equal(viewByB.status, 200);
  const rowsB = viewByB.body.data.visitContext.history;
  assert.equal(rowsB[0].visitId, own.visitId);
  assert.deepEqual([rowsB[1].visitId, rowsB[1].visitNumber, rowsB[1].status, rowsB[1].healthy, rowsB[1].survivalStatus], [null, 2, "DRAFT", null, null]);
  assert.equal(JSON.stringify(viewByB.body).includes(foreign.body.data.id), false);
  const viewByAdmin = await getVisit(own.visitId, "admin");
  assert.equal(viewByAdmin.body.data.visitContext.history[1].visitId, foreign.body.data.id);
});

test("11. authorization: Staff B cannot save Staff A's visit or capture on it; Staff cannot review; Admin cannot save", async () => {
  const foreignVisit = (await visitsOf(redaction.cohortId)).map(doc => ({ id: doc.id, ...doc.data() })).find(v => v.visitNumber === 2);
  const tree = foreignVisit.sampleAssessments[0].sampleId;
  const bSave = await saveVisit(foreignVisit.id, { expectedVersion: foreignVisit.version, submit: false,
    assessments: [{ sampleId: tree, condition: "Healthy", heightCentimeters: 41, stemDiameterMillimeters: 6, remarks: "Not mine" }] }, "staffB");
  assert.ok([403, 404, 409].includes(bSave.status), JSON.stringify(bSave.body)); assert.notEqual(bSave.status, 200);
  const bCapture = await api("/evidence-capture-sessions", "staffB", "POST", { workflow: "sample-monitoring", cohortId: redaction.cohortId, siteId,
    visitId: foreignVisit.id, sampleId: tree, samplingPlanVersion: foreignVisit.samplingPlanVersion, baselineVersion: foreignVisit.baselineVersion,
    visitVersion: foreignVisit.version, assessmentRevision: 0 });
  assert.equal(bCapture.status, 403, JSON.stringify(bCapture.body));
  const after = (await db.collection("sampleMonitoringVisits").doc(foreignVisit.id).get()).data();
  assert.equal(after.version, foreignVisit.version); assert.equal(after.sampleAssessments[0].condition, null);
  // Staff cannot review (route is Admin-only), on either a draft or the approved main visits.
  for (const role of ["staffA", "staffB"]) {
    const review = await reviewVisit(main.v2, { expectedVersion: 0, approve: true, reasons: "" }, role);
    assert.equal(review.status, 403, JSON.stringify(review.body));
  }
  const adminSave = await saveVisit(foreignVisit.id, { expectedVersion: foreignVisit.version, submit: false, assessments: [] }, "admin");
  assert.equal(adminSave.status, 403);
  const adminCreate = await createVisit(main.cohortId, V3_DUE, "admin"); assert.equal(adminCreate.status, 403);
  assert.equal((await api("/verified-sample-monitoring/readiness", null)).status, 401);
});
