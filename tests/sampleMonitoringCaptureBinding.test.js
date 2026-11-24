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

// ---- B3: a capture session can be opened for a first-visit draft (first visit registers the baseline) ----
test("B3 capture sessions bind to a first-visit draft only through the shared cohort binding", async () => {
  const { db } = require.cache[firebasePath].exports;
  const originalCollection = db.collection;
  const { createCaptureSession } = require("../src/services/evidenceCaptureSession.service");
  const prior = process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED, priorCohort = process.env.VERIFIED_PLANTING_COHORT_ENABLED;
  process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true";
  let store;
  const reset = () => {
    store = new Map([
      ["sites/site", { latitude: 13, longitude: 124, status: "active" }],
      ["verifiedPlantingCohorts/cohort", { source: { siteId: "site" }, baselineVersion: 0, baseline: null,
        samplingPlan: { status: "DRAFT", version: 1, origin: "FIRST_VISIT", selectedSamples: [{ permanentId: "TREE-001" }] } }],
      ["sampleMonitoringVisits/visit", { cohortId: "cohort", siteId: "site", createdBy: "staff", status: "DRAFT", version: 0,
        registersBaseline: true, samplingPlanVersion: 1, baselineVersion: 1, sampleAssessments: [{ sampleId: "TREE-001" }] }],
    ]);
  };
  db.collection = name => ({ doc: id => ({
    get: async () => ({ exists: store.has(`${name}/${id}`), data: () => store.get(`${name}/${id}`) }),
    create: async value => { store.set(`${name}/${id}`, value); },
  }) });
  const input = { actorId: "staff", actorRole: "staff", workflow: "sample-monitoring", cohortId: "cohort", siteId: "site", visitId: "visit",
    sampleId: "TREE-001", samplingPlanVersion: 1, baselineVersion: 1, visitVersion: 0, assessmentRevision: 0 };
  try {
    process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED = "true";
    reset();
    const session = await createCaptureSession(input);
    assert.ok(session.captureSessionId);
    for (const [flag, mutate] of [
      [undefined, () => {}],
      ["true", () => { store.get("verifiedPlantingCohorts/cohort").samplingPlan.status = "APPROVED"; }],
      ["true", () => { store.get("verifiedPlantingCohorts/cohort").baselineVersion = 1; }],
      ["true", () => { store.get("verifiedPlantingCohorts/cohort").source.siteId = "other"; }],
      ["true", () => { store.get("sampleMonitoringVisits/visit").registersBaseline = false; }],
      ["true", () => { store.get("verifiedPlantingCohorts/cohort").samplingPlan.selectedSamples = [{ permanentId: "TREE-002" }]; }],
    ]) {
      if (flag === undefined) delete process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED;
      else process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED = flag;
      reset(); mutate();
      await assert.rejects(createCaptureSession(input), error => error.status === 403 && error.code === "CAPTURE_SESSION_FORBIDDEN");
    }
  } finally {
    db.collection = originalCollection;
    if (priorCohort === undefined) delete process.env.VERIFIED_PLANTING_COHORT_ENABLED;
    else process.env.VERIFIED_PLANTING_COHORT_ENABLED = priorCohort;
    if (prior === undefined) delete process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED;
    else process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED = prior;
  }
});
