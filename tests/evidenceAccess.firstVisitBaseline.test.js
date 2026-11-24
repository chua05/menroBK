// B5 carried fix: first-visit baseline photos resolve through the source visit's evidence history,
// with the existing baseline route's authorization unchanged. Legacy baseline photos are unchanged.
const test = require("node:test");
const assert = require("node:assert/strict");

const tables = { verifiedPlantingCohorts: new Map(), sampleMonitoringVisits: new Map() };
const resolvedInputs = [];
const db = { collection: name => ({ doc: id => ({ async get() {
  const value = tables[name]?.get(id);
  return { exists: value !== undefined, data: () => value };
} }) }) };
function mock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
mock("../src/config/firebase", { db });
mock("../src/config/evidenceStorage", { resolveEvidenceStorageConfig: () => ({ cloudRead: true }) });
mock("../src/config/verifiedPlantingCohort", { resolveVerifiedPlantingCohortConfig: () => ({ enabled: true }) });
mock("../src/services/firebaseEvidenceRetrieval.service", {
  createFirebaseEvidenceRetrieval: () => ({ serverResolvedEvidence: input => { resolvedInputs.push(input); return { provider: "firebase" }; } }),
});
const { cohortBaselineEvidenceForUser } = require("../src/services/evidenceAccess.service");

const object = name => ({ provider: "firebase", storageVersion: 1, bucket: "demo", objectName: name, generation: "1",
  contentType: "image/jpeg", format: "jpeg", sizeBytes: 3, sha256: "a".repeat(64), uploadIntentId: "00000000-0000-4000-8000-000000000001" });
const TREE = "RPT-2026-020-T001";
function seed() {
  resolvedInputs.length = 0;
  tables.verifiedPlantingCohorts.clear(); tables.sampleMonitoringVisits.clear();
  tables.sampleMonitoringVisits.set("VPMV-1", { cohortId: "fv", createdBy: "staff-1", status: "APPROVED", sampleAssessments: [
    { sampleId: TREE, assessmentRevision: 1, evidenceHistory: [
      { revision: 0, privateEvidence: object("stale"), captureSessionId: "cap-old" },
      { revision: 1, privateEvidence: object("current"), captureSessionId: "cap-new", location: { latitude: 13, longitude: 124 } },
    ] },
    { sampleId: "OTHER-TREE", assessmentRevision: 0, evidenceHistory: [{ revision: 0, privateEvidence: object("other"), captureSessionId: "cap-other" }] },
  ] });
  tables.verifiedPlantingCohorts.set("fv", { baseline: { approvalStatus: "APPROVED", source: { type: "FIRST_VISIT", visitId: "VPMV-1" }, sampleUnits: [
    { permanentId: TREE, photoReferences: [{ evidenceId: "cap-new", capturedAt: null, sourceVisitId: "VPMV-1", sourceAssessmentRevision: 1 }] },
  ] } });
  tables.verifiedPlantingCohorts.set("legacy", { baseline: { approvalStatus: "APPROVED", sampleUnits: [
    { permanentId: "TREE-001", photoReferences: [{ evidenceId: "cap-legacy", privateEvidence: object("legacy") }] },
  ] } });
}
const unit = cohortId => tables.verifiedPlantingCohorts.get(cohortId).baseline.sampleUnits[0];

test("a first-visit baseline photo resolves from its source visit's evidence for Admin and any Staff (baseline route rule)", async () => {
  seed();
  // staff-2 did not create the visit: the baseline route admits any Staff, and that rule is kept as is.
  for (const user of [{ uid: "admin-1", role: "admin" }, { uid: "staff-1", role: "staff" }, { uid: "staff-2", role: "staff" }]) {
    const result = await cohortBaselineEvidenceForUser("fv", TREE, "0", user);
    assert.equal(result.provider, "firebase");
    const resolved = resolvedInputs.at(-1);
    assert.equal(resolved.reference.objectName, "current");
    assert.equal(resolved.evidenceType, "sample-monitoring");
    assert.equal(resolved.recordId.startsWith("VPME-"), true);
  }
});

test("a first-visit baseline photo is denied to unauthorized users and to any mismatched provenance", async () => {
  seed();
  for (const user of [undefined, { uid: "p-1", role: "participant" }, { uid: "x", role: "guest" }]) {
    await assert.rejects(() => cohortBaselineEvidenceForUser("fv", TREE, "0", user), error => error.code === "EVIDENCE_FORBIDDEN");
  }
  assert.equal(resolvedInputs.length, 0);
  const admin = { uid: "admin-1", role: "admin" };
  const notFound = async (mutate, label) => {
    seed(); mutate();
    await assert.rejects(() => cohortBaselineEvidenceForUser("fv", TREE, "0", admin), error => error.code === "EVIDENCE_NOT_FOUND", label);
    assert.equal(resolvedInputs.length, 0, label);
  };
  await notFound(() => tables.sampleMonitoringVisits.delete("VPMV-1"), "source visit missing");
  await notFound(() => { tables.sampleMonitoringVisits.get("VPMV-1").cohortId = "other"; }, "visit of another cohort");
  await notFound(() => { tables.verifiedPlantingCohorts.get("fv").baseline.source.visitId = "VPMV-2"; }, "reference not from the baseline source visit");
  await notFound(() => { unit("fv").photoReferences[0].sourceAssessmentRevision = 0; }, "revision mismatch");
  await notFound(() => { unit("fv").photoReferences[0].evidenceId = "cap-other"; }, "evidence id of another tree");
  await notFound(() => { delete tables.sampleMonitoringVisits.get("VPMV-1").sampleAssessments[0].evidenceHistory[1].privateEvidence; }, "no stored object");
  seed();
  await assert.rejects(() => cohortBaselineEvidenceForUser("fv", TREE, "1", admin), error => error.code === "EVIDENCE_NOT_FOUND");
});

test("a legacy baseline photo is unchanged: it resolves its own stored privateEvidence as cohort-baseline", async () => {
  seed();
  const result = await cohortBaselineEvidenceForUser("legacy", "TREE-001", "0", { uid: "staff-9", role: "staff" });
  assert.equal(result.provider, "firebase");
  const resolved = resolvedInputs.at(-1);
  assert.equal(resolved.reference.objectName, "legacy");
  assert.equal(resolved.evidenceType, "cohort-baseline");
  assert.equal(resolved.recordId.startsWith("VPCB-"), true);
  await assert.rejects(() => cohortBaselineEvidenceForUser("legacy", "TREE-001", "0", { uid: "p", role: "participant" }), error => error.code === "EVIDENCE_FORBIDDEN");
  // A legacy reference without privateEvidence (and without first-visit provenance) still has no photo.
  delete unit("legacy").photoReferences[0].privateEvidence;
  await assert.rejects(() => cohortBaselineEvidenceForUser("legacy", "TREE-001", "0", { uid: "a", role: "admin" }), error => error.code === "EVIDENCE_NOT_FOUND");
});
