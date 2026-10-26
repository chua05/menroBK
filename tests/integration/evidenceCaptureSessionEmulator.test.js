const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { Timestamp } = require("firebase-admin/firestore");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

// emulators:exec injects demo SDK discovery metadata. Validate its exact
// synthetic shape before removing it so application credential guards remain
// unchanged and no real Firebase configuration can enter this process.
if (process.env.FIREBASE_CONFIG) {
  const config = JSON.parse(process.env.FIREBASE_CONFIG);
  assert.equal(config.projectId, "demo-menro-phase2");
  assert.ok(Object.keys(config).every(key => ["projectId", "databaseURL", "storageBucket"].includes(key)));
  if (config.storageBucket) {
    assert.ok(["demo-menro-phase2.appspot.com", "demo-menro-phase2.firebasestorage.app"].includes(config.storageBucket));
  }
  if (config.databaseURL) assert.equal(config.databaseURL, "https://demo-menro-phase2.firebaseio.com");
  delete process.env.FIREBASE_CONFIG;
}

const environment = validateIntegrationEnvironment();
assert.equal(environment.projectId, "demo-menro-phase2");
const approvedFirestorePort = process.env.MENRO_MPDO_BOUNDARY_ACCEPTANCE === "true" ? "8180" : "8080";
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${approvedFirestorePort}`);
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9099");
assert.equal(process.env.FIREBASE_STORAGE_EMULATOR_HOST, "127.0.0.1:9199");

const { db, auth } = require("../../src/config/firebase");
const capture = require("../../src/services/evidenceCaptureSession.service");
const actorId = "camera-acceptance-participant";
const otherActorId = "camera-acceptance-other";
const siteId = "camera-acceptance-site";
const eventId = "camera-acceptance-event";
const distributionId = "camera-acceptance-distribution";
const binding = { workflow: "planting-report", siteId, eventId, distributionId };
let image;
let changedImage;

async function seed() {
  image = await sharp({ create: { width: 24, height: 24, channels: 3, background: "green" } }).jpeg().toBuffer();
  changedImage = await sharp({ create: { width: 24, height: 24, channels: 3, background: "blue" } }).jpeg().toBuffer();
  await Promise.all([
    db.collection("sites").doc(siteId).set({ status: "Active", latitude: 12.671,
      longitude: 123.875, coverageRadiusMeters: 50, testFixture: true }),
    db.collection("events").doc(eventId).set({ plantingSiteId: siteId, testFixture: true }),
    db.collection("distributions").doc(distributionId).set({ status: "Released", eventId,
      plantingSiteId: siteId, participantId: actorId, testFixture: true }),
  ]);
}

async function clearCollection(name) {
  const snapshot = await db.collection(name).get();
  const batch = db.batch();
  snapshot.docs.filter(doc => doc.id.startsWith("camera-acceptance") || doc.data()?.testFixture)
    .forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

test.before(async () => {
  await Promise.all(["evidenceCaptureSessions", "plantingEvidenceHashes", "monitoringEvidenceHashes",
    "sites", "events", "distributions"].map(clearCollection));
  await seed();
  await auth.createUser({ uid: actorId, email: "camera.acceptance@example.test",
    password: "Camera-Acceptance-2026!", emailVerified: true });
  await db.collection("users").doc(actorId).set({ role: "participant", status: "active",
    email: "camera.acceptance@example.test", fullName: "Camera Acceptance", testFixture: true });
});

test.after(async () => {
  await Promise.all(["evidenceCaptureSessions", "plantingEvidenceHashes", "monitoringEvidenceHashes",
    "sites", "events", "distributions", "users"].map(clearCollection));
  await auth.deleteUser(actorId).catch(() => {});
});

const file = bytes => ({ buffer: bytes, mimetype: "image/jpeg", size: bytes.length,
  originalname: "synthetic-camera.jpg" });
const verifyInput = (session, bytes = image) => ({ actorId, sessionId: session.captureSessionId,
  nonce: session.nonce, file: file(bytes), capturedAt: new Date().toISOString(),
  latitude: 12.671, longitude: 123.875, accuracy: 50 });
const descriptor = (session, verified) => ({ source: "browser-camera",
  captureSessionId: session.captureSessionId, nonce: session.nonce,
  verificationId: verified.verificationId, imageSha256: verified.imageSha256 });

test("session stores hashes, rejects bad nonce and cross-user verification, then verifies once", async () => {
  const session = await capture.createCaptureSession({ actorId, ...binding });
  const saved = (await db.collection(capture.COLLECTION).doc(session.captureSessionId).get()).data();
  assert.equal(saved.state, "OPEN");
  assert.equal(saved.nonce, undefined);
  assert.notEqual(saved.nonceHash, session.nonce);
  await assert.rejects(capture.verifyCaptureSession({ ...verifyInput(session), nonce: "invalid" }),
    error => error.code === "CAPTURE_SESSION_INVALID");
  await assert.rejects(capture.verifyCaptureSession({ ...verifyInput(session), actorId: otherActorId }),
    error => error.code === "CAPTURE_SESSION_FORBIDDEN");
  const verified = await capture.verifyCaptureSession(verifyInput(session));
  assert.equal(verified.evidenceSource, "browser-camera");
  assert.deepEqual({ latitude: verified.location.latitude, longitude: verified.location.longitude,
    accuracy: verified.location.accuracy }, { latitude: 12.671, longitude: 123.875, accuracy: 50 });
  assert.equal(Number.isFinite(verified.location.distanceMeters), true);
  assert.equal(verified.location.boundaryRule, "configured-radius");
  assert.equal(verified.location.boundaryLimitMeters, 50);
  await assert.rejects(capture.verifyCaptureSession(verifyInput(session)),
    error => error.code === "CAPTURE_SESSION_REPLAYED");
});

test("expiration and concurrent verification fail closed", async () => {
  const expired = await capture.createCaptureSession({ actorId, ...binding });
  await db.collection(capture.COLLECTION).doc(expired.captureSessionId)
    .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
  await assert.rejects(capture.verifyCaptureSession(verifyInput(expired)),
    error => error.code === "CAPTURE_SESSION_EXPIRED");
  const concurrent = await capture.createCaptureSession({ actorId, ...binding });
  const results = await Promise.allSettled([
    capture.verifyCaptureSession(verifyInput(concurrent)),
    capture.verifyCaptureSession(verifyInput(concurrent)),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
});

test("altered bytes, duplicate hashes and cross-target descriptors are rejected", async () => {
  const session = await capture.createCaptureSession({ actorId, ...binding });
  const verified = await capture.verifyCaptureSession(verifyInput(session));
  await assert.rejects(capture.resolveSubmissionEvidence({ actorId, workflow: binding.workflow,
    binding, files: [file(changedImage)], manifest: JSON.stringify([descriptor(session, verified)]) }),
  error => error.code === "CAPTURE_IMAGE_MISMATCH");
  await assert.rejects(capture.resolveSubmissionEvidence({ actorId, workflow: binding.workflow,
    binding: { ...binding, siteId: "camera-acceptance-other-site" }, files: [file(image)],
    manifest: JSON.stringify([descriptor(session, verified)]) }), error => error.code === "CAPTURE_IMAGE_MISMATCH");
  await db.collection("plantingEvidenceHashes").doc(verified.imageSha256).set({ testFixture: true });
  const duplicate = await capture.createCaptureSession({ actorId, ...binding });
  await assert.rejects(capture.verifyCaptureSession(verifyInput(duplicate)),
    error => error.code === "DUPLICATE_EVIDENCE");
  await db.collection("plantingEvidenceHashes").doc(verified.imageSha256).delete();
});

test("verified session is atomically consumed once and remains resolvable for lost-response retry", async () => {
  const session = await capture.createCaptureSession({ actorId, ...binding });
  const verified = await capture.verifyCaptureSession(verifyInput(session, changedImage));
  const manifest = JSON.stringify([descriptor(session, verified)]);
  const [resolved] = await capture.resolveSubmissionEvidence({ actorId, workflow: binding.workflow,
    binding, files: [file(changedImage)], manifest });
  await db.runTransaction(async transaction => {
    const consume = await capture.prepareConsumption(transaction, [resolved]);
    consume("camera-acceptance-record");
  });
  const consumed = (await db.collection(capture.COLLECTION).doc(session.captureSessionId).get()).data();
  assert.equal(consumed.state, "CONSUMED");
  const retry = await capture.resolveSubmissionEvidence({ actorId, workflow: binding.workflow,
    binding, files: [file(changedImage)], manifest });
  assert.equal(retry[0].state, "CONSUMED");
  await assert.rejects(db.runTransaction(async transaction => {
    await capture.prepareConsumption(transaction, retry);
  }), error => error.code === "CAPTURE_SESSION_REPLAYED");
});

test("real Auth token protects HTTP creation and maintenance mode blocks the write", async () => {
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "camera.acceptance@example.test", password: "Camera-Acceptance-2026!", returnSecureToken: true }),
  });
  assert.equal(response.ok, true);
  const { idToken } = await response.json();
  const app = require("../../src/app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/evidence-capture-sessions`;
  try {
    const unauthenticated = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(binding) });
    assert.equal(unauthenticated.status, 401);
    const authorized = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${idToken}` }, body: JSON.stringify(binding) });
    assert.equal(authorized.status, 201);
    process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED = "true";
    const blocked = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${idToken}` }, body: JSON.stringify(binding) });
    assert.equal(blocked.status, 503);
  } finally {
    delete process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED;
    await new Promise(resolve => server.close(resolve));
  }
});
