const { test } = require("node:test");
const assert = require("node:assert/strict");
const calls = [];
function mock(name, exports) { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; }
mock("../src/config/verifiedPlantingCohort", { resolveVerifiedPlantingCohortConfig: () => ({ enabled: true }) });
mock("../src/services/evidenceCaptureSession.service", {
  createCaptureSession: async input => { calls.push(input); return {}; },
  verifyCaptureSession: async input => { calls.push(input); return {}; },
});
mock("../src/services/verifiedPlantingCohort.service", Object.fromEntries([
  "listVerifiedPlantingCohorts", "getVerifiedPlantingCohort", "saveSamplingPlan", "approveSamplingPlan", "registerBaselineWithEvidence", "approveBaseline",
].map(name => [name, async input => { calls.push(input); return {}; }])));
const capture = require("../src/controller/evidenceCaptureSession.controller");
const cohort = require("../src/controller/verifiedPlantingCohort.controller");
const response = () => ({ status() { return this; }, json(value) { assert.equal(value.success, true); return this; } });
test("capture controller always uses authenticated actor and route session, never body identity", async () => {
  const file = { fixture: true };
  const request = { user: { uid: "trusted", role: "staff" }, params: { sessionId: "route-session" }, file,
    body: { actorId: "forged", actorRole: "participant", sessionId: "forged-session", file: "forged" } };
  await capture.create(request, response());
  assert.equal(calls.at(-1).actorId, "trusted"); assert.equal(calls.at(-1).actorRole, "staff");
  await capture.verify(request, response());
  assert.equal(calls.at(-1).sessionId, "route-session"); assert.equal(calls.at(-1).file, file);
});
test("cohort mutations whitelist public fields and cannot override trusted actor, cohort or internal workflow", async () => {
  const request = { user: { uid: "trusted", role: "staff" }, params: { id: "route-cohort" }, files: [], get: () => "trusted-key",
    body: { actorId: "forged", cohortId: "forged-cohort", expectedVersion: 1, workflowOperation: "forged", uploadedReferences: "forged", captureEvidence: "forged", idempotencyKey: "forged" } };
  for (const handler of [cohort.saveSamplingPlan, cohort.approveSamplingPlan, cohort.saveBaseline, cohort.approveBaseline]) {
    await handler(request, response()); const input = calls.at(-1);
    assert.equal(input.actorId, "trusted"); assert.equal(input.cohortId, "route-cohort");
    for (const field of ["workflowOperation", "uploadedReferences", "captureEvidence"]) assert.equal(input[field], undefined);
  }
});
test("invalid release configuration rejects before Firebase SDK initialization or credential loading", () => {
  let initialized = 0;
  mock("firebase-admin/app", { initializeApp() { initialized++; throw Error("Must not initialize"); }, cert() { throw Error("Must not load credentials"); } });
  const id = require.resolve("../src/config/firebase"); delete require.cache[id];
  process.env.PERMANENT_SAMPLE_PILOT_ENABLED = "true";
  try { assert.throws(() => require(id), { code: "PERMANENT_SAMPLE_RELEASE_CONFIGURATION_INVALID" }); }
  finally { delete process.env.PERMANENT_SAMPLE_PILOT_ENABLED; delete require.cache[id]; }
  assert.equal(initialized, 0);
});
