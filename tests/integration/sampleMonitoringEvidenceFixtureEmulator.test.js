const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const sharp = require("sharp");
const topology = require("../helpers/emulatorTestTopology");

Object.assign(process.env, {
  NODE_ENV: "test",
  MENRO_INTEGRATION_TEST: "true",
  MENRO_BASELINE_EVIDENCE_ACCEPTANCE: "true",
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
  MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-sample-fixture-${process.pid}`),
});
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) delete process.env[key];

const { auth, db, getStorageBucket } = require("../../src/config/firebase");
const app = require("../../src/app");
const visitService = require("../../src/services/sampleMonitoringVisit.service");
const prefix = `sample-monitoring-fixture-${randomUUID()}`;
const ids = Object.fromEntries(["admin", "staff", "otherStaff", "participant"].map(role => [role, `${prefix}-${role}`]));
const cleanupCreated = require("../helpers/emulatorCreatedResources").trackEmulatorCreatedResources({
  db, auth, getBucket: getStorageBucket, prefix, users: ids,
});
const password = "Fixture-Only-2026!";
const siteId = `${prefix}-site`;
const cohortId = `${prefix}-cohort`;
const sampleId = "TREE-001";
let baseUrl, server;
const tokens = {};
let firstCapture, firstBytes, firstUploadKey;

async function signIn(email) {
  const response = await fetch(`http://${topology.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.idToken;
}

test.before(async () => {
  assert.equal(process.env.GCLOUD_PROJECT, topology.project);
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, topology.firestore);
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, topology.auth);
  assert.equal(process.env.FIREBASE_STORAGE_EMULATOR_HOST, topology.storage);
  for (const [role, uid] of Object.entries(ids)) {
    const email = `${uid}@example.test`;
    await auth.createUser({ uid, email, password, emailVerified: true });
    await db.collection("users").doc(uid).set({ role: role === "otherStaff" ? "staff" : role, status: "active", testFixture: true });
    tokens[role] = await signIn(email);
  }
  await db.collection("sites").doc(siteId).set({ siteName: "Fixture site", latitude: 12.662301, longitude: 123.932983, coverageRadiusMeters: 50, status: "Active", testFixture: true });
  await db.collection("verifiedPlantingCohorts").doc(cohortId).set({ source: { siteId, plantingReportId: `${prefix}-report` }, baselineVersion: 1,
    samplingPlan: { status: "APPROVED", version: 1, selectedSamples: [{ permanentId: sampleId }] },
    baseline: { approvalStatus: "APPROVED", sampleUnits: [{ permanentId: sampleId, condition: "Healthy" }] }, testFixture: true });
  const visit = await visitService.create({ cohortId, actorId: ids.staff, visitDate: "2099-01-01", testOnly: true });
  assert.equal(visit.status, "DRAFT");
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await cleanupCreated();
});

test("seeds a consistent Staff-owned visit recognized by capture-session preconditions", async () => {
  const visit = await visitService.get(visitService._test.id(cohortId, "2099-01-01"));
  assert.equal(visit.createdBy, ids.staff); assert.equal(visit.sampleAssessments[0].sampleId, sampleId);
  const response = await fetch(`${baseUrl}/api/evidence-capture-sessions`, { method: "POST", headers: { authorization: `Bearer ${tokens.staff}`, "content-type": "application/json" },
    body: JSON.stringify({ workflow: "sample-monitoring", cohortId, siteId, visitId: visit.id, sampleId, samplingPlanVersion: 1, baselineVersion: 1, visitVersion: 0, assessmentRevision: 0 }) });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.ok(body.data.captureSessionId);
});

test("Staff camera capture uploads and links one private TREE-001 evidence photo", async () => {
  const visit = await visitService.get(visitService._test.id(cohortId, "2099-01-01"));
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: `#${crypto.randomBytes(3).toString("hex")}` } }).jpeg().toBuffer();
  firstBytes = bytes; firstUploadKey = "sample_upload_key_123";
  const capture = await fetch(`${baseUrl}/api/evidence-capture-sessions`, { method: "POST", headers: { authorization: `Bearer ${tokens.staff}`, "content-type": "application/json" }, body: JSON.stringify({ workflow: "sample-monitoring", cohortId, siteId, visitId: visit.id, sampleId, samplingPlanVersion: 1, baselineVersion: 1, visitVersion: visit.version, assessmentRevision: 0 }) });
  const session = (await capture.json()).data;
  assert.equal(capture.status, 201);
  const verify = new FormData();
  verify.set("photo", new Blob([bytes], { type: "image/jpeg" }), "capture.jpg");
  verify.set("nonce", session.nonce); verify.set("capturedAt", new Date().toISOString());
  verify.set("latitude", "12.662301"); verify.set("longitude", "123.932983"); verify.set("accuracy", "5");
  verify.set("clientImageSha256", crypto.createHash("sha256").update(bytes).digest("hex"));
  const verifiedResponse = await fetch(`${baseUrl}/api/evidence-capture-sessions/${session.captureSessionId}/verify`, { method: "POST", headers: { authorization: `Bearer ${tokens.staff}` }, body: verify });
  const verified = (await verifiedResponse.json()).data;
  assert.equal(verifiedResponse.status, 200);
  const form = new FormData();
  form.set("expectedVisitVersion", String(visit.version)); form.set("assessmentRevision", "0");
  form.set("evidenceManifest", JSON.stringify([{ source: "browser-camera", captureSessionId: session.captureSessionId, nonce: session.nonce, verificationId: verified.verificationId, imageSha256: verified.imageSha256 }]));
  form.set("photos", new Blob([bytes], { type: "image/jpeg" }), "tree.jpg");
  const uploaded = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visit.id}/samples/${sampleId}/evidence`, { method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "Idempotency-Key": firstUploadKey }, body: form });
  const body = await uploaded.json(); assert.equal(uploaded.status, 200, JSON.stringify(body)); assert.equal(JSON.stringify(body).includes("privateEvidence"), false);
  const saved = (await db.collection("sampleMonitoringVisits").doc(visit.id).get()).data();
  const history = saved.sampleAssessments.find(item => item.sampleId === sampleId).evidenceHistory;
  assert.equal(history.length, 1); const reference = history[0].privateEvidence;
  assert.equal(history[0].revision, 0); assert.equal(reference.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  const bucket = await getStorageBucket(); const [exists] = await bucket.file(reference.objectName).exists(); assert.equal(exists, true);
  const intent = await db.collection("evidenceUploadIntents").doc(reference.uploadIntentId).get(); assert.equal(intent.data().status, "LINKED");
  const consumed = await db.collection("evidenceCaptureSessions").doc(session.captureSessionId).get(); assert.equal(consumed.data().state, "CONSUMED");
  firstCapture = { session, verified, visitVersion: visit.version };
});

test("Staff submits the uploaded complete visit for Admin review without losing evidence", async () => {
  const visit = await visitService.get(visitService._test.id(cohortId, "2099-01-01"));
  const response = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visit.id}`, { method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: visit.version, submit: true, assessments: [{ sampleId, condition: "Healthy", remarks: "Healthy sample observed", heightCentimeters: 80, diameterCentimeters: 12 }] }) });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.status, "PENDING_ADMIN_APPROVAL");
  const saved = (await db.collection("sampleMonitoringVisits").doc(visit.id).get()).data();
  const assessment = saved.sampleAssessments.find(item => item.sampleId === sampleId);
  assert.equal(assessment.evidenceHistory.length, 1); assert.equal(assessment.evidenceHistory[0].revision, 0);
});

test("Admin return, Staff correction, second photo, resubmission, and approval preserve immutable history", async () => {
  const visitId = visitService._test.id(cohortId, "2099-01-01");
  let visit = await visitService.get(visitId);
  let response = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}/review`, { method: "POST", headers: { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: visit.version, approve: false, reasons: "Please clarify condition." }) });
  let body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.data.status, "RETURNED");
  assert.equal(body.data.sampleAssessments[0].evidenceHistory.length, 1);
  visit = body.data;
  const correction = { expectedVersion: visit.version, assessments: [{ sampleId, condition: "Damaged", remarks: "Minor damage observed", heightCentimeters: 80, diameterCentimeters: 12 }] };
  response = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}`, { method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "content-type": "application/json" }, body: JSON.stringify(correction) });
  body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.data.sampleAssessments[0].assessmentRevision, 1); assert.equal(body.data.sampleAssessments[0].evidenceHistory.length, 1);
  visit = body.data;
  response = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}`, { method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "content-type": "application/json" }, body: JSON.stringify({ ...correction, expectedVersion: visit.version }) });
  body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.data.sampleAssessments[0].assessmentRevision, 1);
  visit = body.data;
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: `#${crypto.randomBytes(3).toString("hex")}` } }).jpeg().toBuffer();
  response = await fetch(`${baseUrl}/api/evidence-capture-sessions`, { method: "POST", headers: { authorization: `Bearer ${tokens.staff}`, "content-type": "application/json" }, body: JSON.stringify({ workflow: "sample-monitoring", cohortId, siteId, visitId, sampleId, samplingPlanVersion: 1, baselineVersion: 1, visitVersion: visit.version, assessmentRevision: 1 }) });
  const session = (await response.json()).data; assert.equal(response.status, 201);
  const verify = new FormData(); verify.set("photo", new Blob([bytes], { type: "image/jpeg" }), "corrected.jpg"); verify.set("nonce", session.nonce); verify.set("capturedAt", new Date().toISOString()); verify.set("latitude", "12.662301"); verify.set("longitude", "123.932983"); verify.set("accuracy", "5"); verify.set("clientImageSha256", crypto.createHash("sha256").update(bytes).digest("hex"));
  response = await fetch(`${baseUrl}/api/evidence-capture-sessions/${session.captureSessionId}/verify`, { method: "POST", headers: { authorization: `Bearer ${tokens.staff}` }, body: verify }); const verified = (await response.json()).data; assert.equal(response.status, 200);
  const form = new FormData(); form.set("expectedVisitVersion", String(visit.version)); form.set("assessmentRevision", "1"); form.set("evidenceManifest", JSON.stringify([{ source: "browser-camera", captureSessionId: session.captureSessionId, nonce: session.nonce, verificationId: verified.verificationId, imageSha256: verified.imageSha256 }])); form.set("photos", new Blob([bytes], { type: "image/jpeg" }), "corrected-tree.jpg");
  response = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence`, { method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "Idempotency-Key": "sample_correction_key_456" }, body: form }); body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  visit = await visitService.get(visitId); assert.equal(visit.sampleAssessments[0].evidenceHistory.length, 2); assert.deepEqual(visit.sampleAssessments[0].evidenceHistory.map(entry => entry.revision), [0, 1]);
  response = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}`, { method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: visit.version, submit: true, assessments: [{ sampleId, condition: "Damaged", remarks: "Minor damage observed", heightCentimeters: 80, diameterCentimeters: 12 }] }) }); body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  response = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}/review`, { method: "POST", headers: { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: body.data.version, approve: true, reasons: "Approved" }) }); body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.data.status, "APPROVED"); assert.equal(body.data.sampleAssessments[0].evidenceHistory.length, 2);
});

test("approved original and corrected evidence are privately retrievable only by Admin and owner Staff", async () => {
  const visitId = visitService._test.id(cohortId, "2099-01-01");
  const visit = await visitService.get(visitId); const history = visit.sampleAssessments[0].evidenceHistory;
  const bucket = await getStorageBucket();
  for (const index of [0, 1]) {
    const expected = Buffer.from(await bucket.file(history[index].privateEvidence.objectName).download().then(result => result[0]));
    for (const role of ["admin", "staff"]) {
      const response = await fetch(`${baseUrl}/api/evidence/sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence/${index}`, { headers: { authorization: `Bearer ${tokens[role]}` } });
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    }
  }
  for (const role of ["participant", "otherStaff"]) { const response = await fetch(`${baseUrl}/api/evidence/sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence/0`, { headers: { authorization: `Bearer ${tokens[role]}` } }); assert.equal(response.status, 403); }
  assert.equal((await fetch(`${baseUrl}/api/evidence/sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence/0`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/evidence/sample-monitoring/visits/${visitId}/samples/TREE-999/evidence/0`, { headers: { authorization: `Bearer ${tokens.admin}` } })).status, 404);
});

test("approved completed uploads resolve read-only while replay, stale, altered, and new operations are rejected", async () => {
  const visitId = visitService._test.id(cohortId, "2099-01-01");
  const before = await visitService.get(visitId);
  const originalHistory = before.sampleAssessments[0].evidenceHistory.length;
  const originalObjects = originalHistory;
  const formFor = ({ expectedVisitVersion = firstCapture.visitVersion, assessmentRevision = 0 } = {}) => {
    const form = new FormData();
    form.set("expectedVisitVersion", String(expectedVisitVersion));
    form.set("assessmentRevision", String(assessmentRevision));
    form.set("evidenceManifest", JSON.stringify([{
      source: "browser-camera", captureSessionId: firstCapture.session.captureSessionId,
      nonce: firstCapture.session.nonce, verificationId: firstCapture.verified.verificationId,
      imageSha256: firstCapture.verified.imageSha256,
    }]));
    form.set("photos", new Blob([firstBytes], { type: "image/jpeg" }), "original-tree.jpg");
    return form;
  };
  const retry = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence`, {
    method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "Idempotency-Key": firstUploadKey }, body: formFor(),
  });
  const retryBody = await retry.json();
  assert.equal(retry.status, 200, JSON.stringify(retryBody));
  assert.deepEqual(retryBody.data, { visitId, sampleId });
  const afterRetry = await visitService.get(visitId);
  assert.equal(afterRetry.sampleAssessments[0].evidenceHistory.length, originalHistory);
  const capture = await db.collection("evidenceCaptureSessions").doc(firstCapture.session.captureSessionId).get();
  assert.equal(capture.data().state, "CONSUMED");
  const operations = await db.collection("evidenceWorkflowOperations").where("workflow", "==", "sample-monitoring").get();
  const completed = operations.docs.find(doc => doc.data().resultLink?.visitId === visitId && doc.data().resultLink?.assessmentRevision === 0);
  assert.ok(completed); assert.equal(completed.data().status, "COMPLETED");
  const intentId = afterRetry.sampleAssessments[0].evidenceHistory[0].privateEvidence.uploadIntentId;
  assert.equal((await db.collection("evidenceUploadIntents").doc(intentId).get()).data().status, "LINKED");

  const altered = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence`, {
    method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "Idempotency-Key": firstUploadKey }, body: formFor({ expectedVisitVersion: 999 }),
  });
  assert.equal(altered.status, 409); assert.equal(JSON.stringify(await altered.json()).includes("privateEvidence"), false);
  const newAfterApproval = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence`, {
    method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "Idempotency-Key": "new_upload_after_approval_123" }, body: formFor(),
  });
  assert.equal(newAfterApproval.status, 409);
  const stale = await fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence`, {
    method: "PUT", headers: { authorization: `Bearer ${tokens.staff}`, "Idempotency-Key": "stale_revision_upload_key_123" }, body: formFor({ assessmentRevision: 9 }),
  });
  assert.equal(stale.status, 409);
  const replay = new FormData(); replay.set("photo", new Blob([firstBytes], { type: "image/jpeg" }), "replay.jpg"); replay.set("nonce", firstCapture.session.nonce); replay.set("capturedAt", new Date().toISOString()); replay.set("latitude", "12.662301"); replay.set("longitude", "123.932983"); replay.set("accuracy", "5");
  const replayedCapture = await fetch(`${baseUrl}/api/evidence-capture-sessions/${firstCapture.session.captureSessionId}/verify`, { method: "POST", headers: { authorization: `Bearer ${tokens.staff}` }, body: replay });
  assert.equal(replayedCapture.status, 409);
  const finalVisit = await visitService.get(visitId);
  assert.equal(finalVisit.sampleAssessments[0].evidenceHistory.length, originalHistory);
  assert.equal(finalVisit.sampleAssessments[0].evidenceHistory.length, originalObjects);
});

test("UUID-scoped fixture cleanup removes only fixture-bound emulator resources", async () => {
  const visitId = visitService._test.id(cohortId, "2099-01-01");
  const visit = await visitService.get(visitId);
  const bucket = await getStorageBucket();
  const objectNames = visit.sampleAssessments.flatMap(assessment => (assessment.evidenceHistory || []).map(entry => entry.privateEvidence.objectName));
  const captureDocs = await db.collection("evidenceCaptureSessions").where("visitId", "==", visitId).get();
  const hashDocs = await db.collection("sampleMonitoringEvidenceHashes").where("visitId", "==", visitId).get();
  const operationDocs = await db.collection("evidenceWorkflowOperations").where("workflow", "==", "sample-monitoring").get();
  const fixtureOperations = operationDocs.docs.filter(doc => doc.data().resultLink?.visitId === visitId || doc.data().binding?.visitId === visitId);
  const intentIds = visit.sampleAssessments.flatMap(assessment => (assessment.evidenceHistory || []).map(entry => entry.privateEvidence.uploadIntentId));
  await Promise.all(objectNames.map(name => bucket.file(name).delete()));
  await Promise.all(intentIds.map(id => db.collection("evidenceUploadIntents").doc(id).delete()));
  await Promise.all([...captureDocs.docs, ...hashDocs.docs, ...fixtureOperations].map(doc => doc.ref.delete()));
  await db.collection("sampleMonitoringVisits").doc(visitId).delete();
  await db.collection("verifiedPlantingCohorts").doc(cohortId).delete();
  await db.collection("sites").doc(siteId).delete();
  await Promise.all(Object.values(ids).map(async uid => { await db.collection("users").doc(uid).delete(); await auth.deleteUser(uid); }));
  for (const name of objectNames) assert.equal((await bucket.file(name).exists())[0], false);
  assert.equal((await db.collection("sampleMonitoringVisits").doc(visitId).get()).exists, false);
  assert.equal((await db.collection("verifiedPlantingCohorts").doc(cohortId).get()).exists, false);
  assert.equal((await db.collection("sites").doc(siteId).get()).exists, false);
  assert.equal((await db.collection("evidenceCaptureSessions").where("visitId", "==", visitId).get()).empty, true);
  assert.equal((await db.collection("sampleMonitoringEvidenceHashes").where("visitId", "==", visitId).get()).empty, true);
});
