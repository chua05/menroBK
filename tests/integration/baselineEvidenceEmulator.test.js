// UUID-scoped Phase 2.1 acceptance. It can run only with the explicit demo-only gate.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sharp = require("sharp");

Object.assign(process.env, {
  NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", MENRO_BASELINE_EVIDENCE_ACCEPTANCE: "true",
  GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8181", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app",
  EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true", EVIDENCE_CLOUD_READ_ENABLED: "true",
  VERIFIED_PLANTING_COHORT_ENABLED: "true", MENRO_UPLOAD_ROOT: require("node:path").join(require("node:os").tmpdir(), `menro-baseline-e2e-${process.pid}`),
});
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) delete process.env[key];

const { auth, db, getStorageBucket } = require("../../src/config/firebase");
const app = require("../../src/app");
const prefix = `baseline-e2e-${crypto.randomUUID()}`;
const password = "Baseline-E2E-2026!";
const ids = Object.fromEntries(["staff", "admin", "participant", "other"].map(role => [role, `${prefix}-${role}`]));
const siteId = `${prefix}-site`, cohortId = `${prefix}-cohort`, sampleId = "TREE-001";
let server, baseUrl, tokens = {}, image, imageHash;

async function signIn(email) {
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.idToken;
}
async function call(role, method, route, body, multipart = false) {
  const headers = role ? { authorization: `Bearer ${tokens[role]}` } : {};
  if (multipart && body?.key) headers["Idempotency-Key"] = body.key;
  if (body !== undefined && !multipart) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${route}`, { method, headers, body: body === undefined ? undefined : multipart ? (body.data || body) : JSON.stringify(body) });
}
async function response(role, method, route, body, multipart, expected) {
  const result = await call(role, method, route, body, multipart);
  const json = await result.json().catch(() => ({}));
  assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(json)}`);
  return json.data;
}
function form(session, verification, buffer = image, permanentId = sampleId, key = crypto.randomUUID(), expectedVersion = 0) {
  const data = new FormData();
  data.set("expectedVersion", String(expectedVersion));
  data.set("sampleUnits", JSON.stringify([{ permanentId, unitType: "tree", latitude: 12.662301, longitude: 123.932983,
    condition: "Healthy", heightMeters: 0.8, diameterCentimeters: 1.2, captureDate: "2026-11-01" }]));
  data.set("evidenceManifest", JSON.stringify([{ source: "browser-camera", sampleId: permanentId,
    captureSessionId: session.captureSessionId, nonce: session.nonce, verificationId: verification.verificationId }]));
  data.set("photos", new Blob([buffer], { type: "image/jpeg" }), "baseline.jpg");
  return { data, key };
}
async function capture(role = "staff", overrides = {}) {
  const session = await response(role, "POST", "/evidence-capture-sessions", { workflow: "cohort-baseline", cohortId, siteId,
    sampleId: overrides.sampleId || sampleId, samplingPlanVersion: 1 }, false, role === "staff" ? 201 : 403);
  if (role !== "staff") return { session };
  const photo = new FormData(); photo.set("photo", new Blob([overrides.bytes || image], { type: overrides.type || "image/jpeg" }), "baseline.jpg");
  photo.set("nonce", session.nonce); photo.set("capturedAt", new Date().toISOString()); photo.set("latitude", String(overrides.latitude ?? 12.662301));
  photo.set("longitude", String(overrides.longitude ?? 123.932983)); photo.set("accuracy", String(overrides.accuracy ?? 5));
  photo.set("clientImageSha256", crypto.createHash("sha256").update(overrides.bytes || image).digest("hex"));
  const verified = await response("staff", "POST", `/evidence-capture-sessions/${session.captureSessionId}/verify`, photo, true, overrides.expected || 200);
  return { session, verified };
}

test.before(async () => {
  const color = `#${crypto.randomBytes(3).toString("hex")}`;
  image = await sharp({ create: { width: 3, height: 3, channels: 3, background: color } }).jpeg().toBuffer();
  imageHash = crypto.createHash("sha256").update(image).digest("hex");
  for (const role of Object.keys(ids)) {
    const email = `${ids[role]}@example.test`; await auth.createUser({ uid: ids[role], email, password, emailVerified: true });
    await db.collection("users").doc(ids[role]).set({ role: role === "other" ? "participant" : role, fullName: role, status: "active", profileComplete: true, testFixture: true });
    tokens[role] = await signIn(email);
  }
  await db.collection("sites").doc(siteId).set({ siteName: "Baseline acceptance site", latitude: 12.662301, longitude: 123.932983,
    coverageRadiusMeters: 50, status: "Active", testFixture: true });
  await db.collection("verifiedPlantingCohorts").doc(cohortId).set({ source: { siteId, plantingReportId: `${prefix}-report` }, verifiedPlantedQuantity: 10,
    baselineVersion: 0, baselineStatus: "NOT_STARTED", samplingPlan: { version: 1, status: "APPROVED", selectedSamples: [{ permanentId: sampleId }] }, testFixture: true });
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

test("Staff camera evidence is private, links once, and is retrievable only by Staff or Admin", async () => {
  const { session, verified } = await capture();
  const first = form(session, verified); const created = await response("staff", "PUT", `/verified-planting-cohorts/${cohortId}/baseline`, first, true, 200);
  assert.equal(created.baseline.sampleUnits[0].photoReferences[0].privateEvidence, undefined);
  const stored = (await db.collection("verifiedPlantingCohorts").doc(cohortId).get()).data();
  const reference = stored.baseline.sampleUnits[0].photoReferences[0].privateEvidence;
  assert.equal(reference.sha256, imageHash); assert.ok(reference.objectName);
  const [metadata] = await (await getStorageBucket()).file(reference.objectName).getMetadata(); assert.equal(String(metadata.size), String(image.length));
  const route = `/evidence/verified-planting-cohorts/${cohortId}/baseline/${sampleId}/photos/0`;
  for (const role of ["staff", "admin"]) { const r = await call(role, "GET", route); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), image); }
  assert.equal((await call("participant", "GET", route)).status, 403); assert.equal((await call(null, "GET", route)).status, 401);
  const retry = form(session, verified, image, sampleId, first.key); const repeated = await response("staff", "PUT", `/verified-planting-cohorts/${cohortId}/baseline`, retry, true, 200);
  assert.equal(repeated.baselineVersion, 1);
});

test("capture and baseline submission reject invalid GPS, outside site, malformed evidence, replay, and unauthorized replacement", async () => {
  await capture("participant");
  await capture("staff", { accuracy: 51, expected: 422 });
  await capture("staff", { latitude: 12.6635, longitude: 123.932983, expected: 422 });
  const bad = await capture("staff", { bytes: Buffer.from("not-an-image"), expected: 400 }); assert.ok(bad.session.captureSessionId);
  const secondImage = await sharp({ create: { width: 3, height: 3, channels: 3, background: `#${crypto.randomBytes(3).toString("hex")}` } }).jpeg().toBuffer();
  const next = await capture("staff", { bytes: secondImage });
  const malformed = form(next.session, next.verified, secondImage, "TREE-002", crypto.randomUUID(), 1);
  const r = await call("staff", "PUT", `/verified-planting-cohorts/${cohortId}/baseline`, malformed, true); assert.equal(r.status, 400);
  const correction = form(next.session, next.verified, secondImage, sampleId, crypto.randomUUID(), 1);
  const revised = await response("staff", "PUT", `/verified-planting-cohorts/${cohortId}/baseline`, correction, true, 200); assert.equal(revised.baselineVersion, 2);
  const stale = form(next.session, next.verified, secondImage, sampleId, crypto.randomUUID(), 1); const replay = await call("staff", "PUT", `/verified-planting-cohorts/${cohortId}/baseline`, stale, true); assert.equal(replay.status, 409);
});

test("review history is retained and expired capture sessions fail without linking orphaned metadata", async () => {
  const current = (await db.collection("verifiedPlantingCohorts").doc(cohortId).get()).data();
  await response("admin", "POST", `/verified-planting-cohorts/${cohortId}/baseline/approve`, { expectedVersion: current.baselineVersion, approve: false, remarks: "Retake with clearer photo" }, false, 200);
  const thirdImage = await sharp({ create: { width: 3, height: 3, channels: 3, background: `#${crypto.randomBytes(3).toString("hex")}` } }).jpeg().toBuffer();
  const expired = await capture("staff", { bytes: thirdImage });
  await db.collection("evidenceCaptureSessions").doc(expired.session.captureSessionId).update({ expiresAt: new Date(Date.now() - 1000) });
  const blocked = form(expired.session, expired.verified, thirdImage, sampleId, crypto.randomUUID(), 2); const failure = await call("staff", "PUT", `/verified-planting-cohorts/${cohortId}/baseline`, blocked, true); assert.equal(failure.status, 410);
  const after = (await db.collection("verifiedPlantingCohorts").doc(cohortId).get()).data();
  assert.equal(after.baselineVersion, 2); assert.ok(after.baselineHistory.some(entry => entry.status === "RETURNED"));
  const links = await db.collection("baselineEvidenceHashes").where("cohortId", "==", cohortId).get(); assert.equal(links.size, 2);
});
