const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryFirestore } = require("./helpers/evidenceQuotaMemory");
const validation = require("../src/services/sampleMonitoringValidation");
function setup(status = "DRAFT") {
  const f = memoryFirestore();
  const visit = { createdBy: "owner", cohortId: "cohort", siteId: "site", baselineVersion: 1, samplingPlanVersion: 1,
    version: 0, status, visitDate: "2099-02-01", sampleAssessments: [{ sampleId: "TREE-001", condition: "Healthy", evidenceHistory: [{ revision: 0 }] }], history: [] };
  const cohort = { source: { siteId: "site" }, baselineVersion: 1, samplingPlan: { version: 1, status: "APPROVED" },
    baseline: { approvalStatus: "APPROVED", sampleUnits: [{ permanentId: "TREE-001" }] } };
  f.records("sampleMonitoringVisits").set("visit", visit);
  f.records("verifiedPlantingCohorts").set("cohort", cohort);
  require.cache[require.resolve("../src/config/firebase")] = { exports: { db: f.db } };
  require.cache[require.resolve("../src/config/verifiedPlantingCohort")] = { exports: { resolveVerifiedPlantingCohortConfig: () => ({ enabled: true }) } };
  delete require.cache[require.resolve("../src/services/sampleMonitoringVisit.service")];
  return { ...f, visit, cohort, service: require("../src/services/sampleMonitoringVisit.service"),
    save: { visitId: "visit", actorId: "owner", expectedVersion: 0, assessments: [{ sampleId: "TREE-001", condition: "Healthy" }] } };
}
test("measurement parsing preserves empty/null and finite values without inventing biological bounds", () => {
  for (const value of [undefined, null, "", "  "]) assert.equal(validation.measurement(value), null);
  for (const value of [0, 12.5, -2, "120", " 1.5 ", "1e2"]) assert.equal(validation.measurement(value), Number(value));
  for (const value of [NaN, Infinity, -Infinity, "NaN", "Infinity", "2cm", true, [], {}, "0x10"]) assert.throws(() => validation.measurement(value), { status: 400 });
});
test("save rejects coerced versions and nonboolean submit without writes", async () => {
  for (const changed of [{ expectedVersion: null }, { expectedVersion: "0" }, { expectedVersion: -1 }, { expectedVersion: 0.5 }, { submit: "false" }]) {
    const f = setup(); await assert.rejects(f.service.save({ ...f.save, ...changed }), { status: 400 });
    assert.equal(f.records("sampleMonitoringVisits").get("visit").version, 0);
  }
});
test("review rejects truthy strings, missing decisions, blank reasons and coerced versions", async () => {
  for (const changed of [{ approve: "false" }, { approve: undefined }, { approve: false, reasons: " " }, { expectedVersion: "0" }, { expectedVersion: null }]) {
    const f = setup("PENDING_ADMIN_APPROVAL");
    await assert.rejects(f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: true, ...changed }), { status: 400 });
    assert.equal(f.records("sampleMonitoringVisits").get("visit").status, "PENDING_ADMIN_APPROVAL");
  }
  const f = setup("PENDING_ADMIN_APPROVAL");
  assert.equal((await f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: false, reasons: "Correct assessment." })).status, "RETURNED");
});
test("save and review reject transactional site, plan and baseline changes", async () => {
  for (const mutate of [c => c.source.siteId = "other", c => c.baselineVersion++, c => c.samplingPlan.version++, c => c.baseline.approvalStatus = "RETURNED"]) {
    const f = setup(); mutate(f.cohort);
    await assert.rejects(f.service.save(f.save), { status: 409 });
    f.visit.status = "PENDING_ADMIN_APPROVAL";
    await assert.rejects(f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: true }), { status: 409 });
  }
});
test("forged references and invalid numbers cannot replace authoritative evidence", async () => {
  for (const changed of [{ baselineReference: { sampleId: "OTHER" } }, { previousAssessmentReference: { visitId: "forged" } }, { heightCentimeters: "NaN" }]) {
    const f = setup(); await assert.rejects(f.service.save({ ...f.save, assessments: [{ ...f.save.assessments[0], ...changed }] }));
    assert.equal(f.records("sampleMonitoringVisits").get("visit").sampleAssessments[0].evidenceHistory.length, 1);
  }
  const f = setup(); const saved = await f.service.save(f.save);
  assert.deepEqual(saved.sampleAssessments[0].baselineReference, { sampleId: "TREE-001" });
  assert.equal(saved.sampleAssessments[0].previousAssessmentReference, null);
  assert.equal(saved.sampleAssessments[0].heightCentimeters, null);
});
test("historical references derive from a matching approved prior visit", async () => {
  const f = setup(); f.visit.priorVisitId = "prior";
  f.records("sampleMonitoringVisits").set("prior", { ...f.visit, visitDate: "2099-01-01", status: "APPROVED", sampleAssessments: [{ sampleId: "TREE-001", condition: "Needs Rechecking", remarks: "Search again" }] });
  const saved = await f.service.save(f.save);
  assert.deepEqual(saved.sampleAssessments[0].previousAssessmentReference, { visitId: "prior", sampleId: "TREE-001", condition: "Needs Rechecking", remarks: "Search again", investigationOutcome: null });
});
test("invalid legacy pending measurements require correction, not approval", async () => {
  const f = setup("PENDING_ADMIN_APPROVAL"); f.visit.sampleAssessments[0].heightCentimeters = Infinity;
  await assert.rejects(f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: true }), { status: 400 });
  assert.equal((await f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: false, reasons: "Correct the measurement." })).status, "RETURNED");
});
test("approval rejects forged persisted references without rewriting legacy history", async () => {
  const f = setup("PENDING_ADMIN_APPROVAL");
  f.visit.sampleAssessments[0].baselineReference = { sampleId: "OTHER" };
  await assert.rejects(f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: true }), { status: 409 });
  assert.equal(f.records("sampleMonitoringVisits").get("visit").status, "PENDING_ADMIN_APPROVAL");
  assert.equal(f.records("sampleMonitoringVisits").get("visit").sampleAssessments[0].evidenceHistory.length, 1);
});
