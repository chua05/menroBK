const { test } = require("node:test");
const assert = require("node:assert/strict");
const { summarize, createService } = require("../src/services/permanentSampleAnalytics.service");
const cohort = { id: "cohort", source: { siteId: "site" }, baselineVersion: 1,
  baseline: { approvalStatus: "APPROVED", sampleUnits: ["TREE-001", "TREE-002", "TREE-003"].map(permanentId => ({ permanentId })) },
  samplingPlan: { status: "APPROVED", version: 1 } };
const visit = (id, date, rows, extra = {}) => ({ id, visitDate: date, status: "APPROVED", cohortId: "cohort", siteId: "site", baselineVersion: 1,
  samplingPlanVersion: 1, sampleAssessments: rows.map(([sampleId, condition]) => ({ sampleId, condition })), ...extra });
test("latest approved permanent identities counted once; partial and unresolved remain distinct", () => {
  const rows = [visit("v1", "2099-01-01", [["TREE-001", "Healthy"], ["TREE-002", "Dead"]]),
    visit("v2", "2099-02-01", [["TREE-001", "Damaged"], ["TREE-002", "Needs Rechecking"]]),
    visit("draft", "2099-03-01", [["TREE-001", "Dead"]], { status: "DRAFT" })];
  const result = summarize([cohort], rows).cohorts[0];
  assert.equal(result.latest.total, 3); assert.equal(result.latest.assessed, 2);
  assert.equal(result.latest.unassessed, 1); assert.equal(result.latest.unresolved, 1);
  assert.equal(result.latest.counts.Dead, 0); assert.equal(result.latest.coverage, 2 / 3);
  assert.equal(result.history.length, 2); assert.equal(result.latest.samples[0].changedFrom, "Healthy");
  assert.equal(JSON.stringify(result).includes("privateEvidence"), false);
});
test("duplicate IDs and ambiguous approvals fail closed", () => {
  const duplicate = visit("v1", "2099-01-01", [["TREE-001", "Healthy"], ["TREE-001", "Dead"]]);
  assert.equal(summarize([cohort], [duplicate]).cohorts.length, 0);
  assert.equal(summarize([cohort], [visit("a", "2099-01-01", []), visit("b", "2099-01-01", [])]).cohorts.length, 0);
});
test("wrong site/baseline, pending and returned records excluded", () => {
  for (const extra of [{ siteId: "other" }, { baselineVersion: 2 }, { status: "RETURNED" }, { status: "PENDING_ADMIN_APPROVAL" }]) {
    assert.equal(summarize([cohort], [visit("v1", "2099-01-01", [], extra)]).cohorts.length, 0);
  }
});
test("analytics role and gate reject before database access", async () => {
  const db = { collection() { throw Error("Database must not be reached"); } };
  const service = createService({ db, enabled: () => true });
  await assert.rejects(service.get({ actorId: "p", actorRole: "participant" }), { status: 403 });
  await assert.rejects(service.get({ actorRole: "staff" }), { status: 401 });
  await assert.rejects(createService({ db, enabled: () => false }).get({ actorId: "s", actorRole: "staff" }), { status: 409 });
});
test("Staff queries require owner plus approved status; Admin follows existing global MENRO scope", async () => {
  const calls = [];
  const query = { where(...args) { calls.push(args); return this; }, limit(n) { assert.equal(n, 1001); return this; }, async get() { return { docs: [] }; } };
  const service = createService({ db: { collection(name) { assert.equal(name, "sampleMonitoringVisits"); return query; } }, enabled: () => true });
  await service.get({ actorId: "staff", actorRole: "staff", siteId: "site", cohortId: "cohort" });
  assert.deepEqual(calls, [["status", "==", "APPROVED"], ["createdBy", "==", "staff"], ["cohortId", "==", "cohort"], ["siteId", "==", "site"]]);
  calls.length = 0;
  await service.get({ actorId: "admin", actorRole: "admin" });
  assert.deepEqual(calls, [["status", "==", "APPROVED"]]);
});
test("unknown conditions are unassessed and not-located is unresolved, never death", () => {
  const row = visit("v", "2099-01-01", [["TREE-001", "Needs Rechecking"], ["TREE-002", "Not Located After Rechecking"]]);
  row.sampleAssessments[0].investigationOutcome = "Not Located After Rechecking";
  row.sampleAssessments[0].evidenceHistory = [{ revision: 0, privateEvidence: { objectName: "must-not-leak" } }, { revision: 1 }];
  const result = summarize([cohort], [row]).cohorts[0].latest;
  assert.equal(result.counts.Dead, 0); assert.equal(result.unresolved, 1); assert.equal(result.unassessed, 2);
  assert.deepEqual(result.samples[0].evidenceRevisions, [0, 1]);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});
test("approved history distinguishes newly assessed trees from unchanged conditions", () => {
  const rows = [visit("first", "2099-01-01", []), visit("second", "2099-02-01", [["TREE-001", "Healthy"]])];
  const latest = summarize([cohort], rows).cohorts[0].latest;
  assert.equal(latest.samples[0].changedFrom, "Unassessed");
  assert.equal(latest.samples[1].changedFrom, null);
});
