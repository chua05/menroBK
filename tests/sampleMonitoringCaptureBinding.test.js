const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest("hex");
const bytes = Buffer.from("resolver-unit-test-only; not runtime evidence");
let session;
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true,
  exports: { db: { collection: name => { assert.equal(name, "evidenceCaptureSessions"); return {
    doc: id => { assert.equal(id, "unit-session"); return { get: async () => ({ exists: true, data: () => session }) }; },
  }; } } } };
const { resolveSubmissionEvidence } = require("../src/services/evidenceCaptureSession.service");
function fixture() {
  session = { actorId: "unit-staff", workflow: "sample-monitoring", state: "VERIFIED",
    nonceHash: hash("unit-nonce"), verificationIdHash: hash("unit-verification"), imageSha256: hash(bytes),
    expiresAt: { toMillis: () => Date.now() + 60000 }, visitVersion: 0, assessmentRevision: 0 };
  return { actorId: "unit-staff", workflow: "sample-monitoring", binding: { visitVersion: 0, assessmentRevision: 0 },
    files: [{ buffer: bytes }], manifest: [{ source: "browser-camera", captureSessionId: "unit-session", nonce: "unit-nonce", verificationId: "unit-verification" }] };
}
test("matching zero visit and assessment versions remain valid", async () => {
  assert.equal((await resolveSubmissionEvidence(fixture()))[0].assessmentRevision, 0);
});
for (const field of ["visitVersion", "assessmentRevision"]) test(`zero ${field} cannot match a different capture-session binding`, async () => {
  const input = fixture(); session[field] = 1;
  await assert.rejects(resolveSubmissionEvidence(input), error => error.status === 409 && error.code === "CAPTURE_IMAGE_MISMATCH");
});
test("a missing session revision cannot match required revision zero", async () => {
  const input = fixture(); delete session.assessmentRevision;
  await assert.rejects(resolveSubmissionEvidence(input), error => error.status === 409 && error.code === "CAPTURE_IMAGE_MISMATCH");
});


test("original, unregistered and omitted sources cannot resolve into camera evidence", async () => {
  for (const manifest of [[{ source: "uploaded-original" }], [{ source: "unregistered-source" }], undefined]) {
    const input = fixture(); input.manifest = manifest;
    assert.deepEqual(await resolveSubmissionEvidence(input), [null]);
    assert.equal(session.state, "VERIFIED");
  }
});
