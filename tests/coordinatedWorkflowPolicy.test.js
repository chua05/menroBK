const test = require("node:test");
const assert = require("node:assert/strict");
const { queryMemory } = require("./helpers/queryMemory");
const memory = queryMemory();
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: memory.db, auth: {} } };
const { contract, classifyRequest, canonicalPurpose } = require("../src/utils/requestClassification.util");
const policy = require("../src/services/purposePolicy.service");
const admin = { uid: "admin-1", role: "admin" };
const input = () => ({ ...policy.initialPolicy(), expectedVersion: 0, reason: "MENRO approved test policy", effectiveDate: "2026-01-01" });
test.beforeEach(() => { for (const name of ["purposePolicies", "purposePolicyVersions"]) memory.records(name).clear(); });

test("only School / Student is split and all remaining sector order/values are preserved", () => {
  assert.deepEqual(contract.sectors, ["Resident / Individual", "Barangay Official", "Student (Individual)", "School Organization Representative", "Private Sector / Business", "Civic Organization / NGO", "Government Agency", "Other (please specify)"]);
  assert.equal(classifyRequest({ sector: "Student (Individual)" }), "individual");
  assert.equal(classifyRequest({ sector: "School Organization Representative" }), "organization");
  assert.equal(classifyRequest({ sector: "School / Student", purpose: "School Activity" }), null);
  assert.equal(classifyRequest({ sector: "School / Student", requestingAs: "group" }), "organization");
  assert.equal(classifyRequest({ sector: "Other (please specify)", requestingAs: "individual" }), "individual");
});
test("shared purpose mapping preserves original values and does not invent a corporate activity", () => {
  assert.equal(canonicalPurpose("Backyard / Home Planting"), "Household / Backyard");
  assert.equal(canonicalPurpose("School Activity"), "School / Community / Roadside Greening");
  assert.equal(canonicalPurpose("Environmental Conservation"), "Other");
  assert.ok(!contract.purposes.some(value => /Corporate/.test(value)));
});
test("initial policy keeps unapproved thresholds, minimum and procedures explicitly pending", () => {
  const value = policy.initialPolicy();
  assert.equal(value.sampling.percentage, 10); assert.equal(value.sampling.minimum, null); assert.equal(value.sampling.intervalMonths, 12);
  assert.equal(value.sampling.firstVisitDelayWeeks, null); assert.equal(value.purposes[1].quantityThreshold, null);
  assert.equal(value.purposes[0].reporting, "NOT_REQUIRED"); assert.equal(value.purposes[5].monitoring, "NONE");
});
test("only authenticated Admin can read and publish policy settings", async () => {
  for (const user of [null, { uid: "staff", role: "staff" }, { uid: "participant", role: "participant" }]) {
    await assert.rejects(policy.readSettings(user), error => error.status === (user ? 403 : 401));
    await assert.rejects(policy.saveSettings(user, input()), error => error.status === (user ? 403 : 401));
  }
});
test("versioned Admin saves are atomic, audited and stale writes cannot overwrite them", async () => {
  const saved = await policy.saveSettings(admin, input());
  assert.equal(saved.version, 1); assert.equal(saved.updatedBy, admin.uid); assert.ok(saved.updatedAt);
  assert.equal(memory.records("purposePolicyVersions").size, 1);
  await assert.rejects(policy.saveSettings(admin, input()), error => error.status === 409);
  assert.equal((await policy.readSettings(admin)).version, 1);
});
test("invalid settings and missing override reasons fail closed without a policy write", async () => {
  for (const mutate of [value => { value.effectiveDate = "2026-02-31"; }, value => { value.sampling.percentage = 0; }, value => { value.sampling.minimum = -1; }, value => { value.purposes[0].quantityThreshold = "10"; }, value => { value.purposes[0].reporting = "EXEMPT"; }, value => { value.purposes.pop(); }, value => { value.reason = ""; }]) {
    const value = input(); mutate(value); await assert.rejects(policy.saveSettings(admin, value), error => error.status === 400);
  }
  assert.equal(memory.records("purposePolicies").size, 0);
  assert.throws(() => policy.validateDecision({ reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE", reason: " " }), error => error.status === 400);
});
test("future versions do not become effective before their effective date", async () => {
  const first = await policy.saveSettings(admin, input());
  const next = { ...input(), expectedVersion: first.version, effectiveDate: "2099-01-01" }; next.purposes[0].reporting = "REQUIRED";
  await policy.saveSettings(admin, next);
  assert.equal((await policy.currentPolicy()).version, 1);
});
async function snapshot(request, decision) {
  return memory.db.runTransaction(transaction => policy.approvalSnapshot(transaction, { ...request, purposePolicyManaged: true }, admin.uid, decision));
}
test("unresolved Other/organization policies no longer block approval: recorded as PENDING_MENRO_POLICY, never a Staff proposal", async () => {
  const other = { purpose: "Other", workflow: { sector: "Resident / Individual", purpose: "Other" }, staffPolicyProposal: { reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE", reason: "Staff recommendation" } };
  const pending = await snapshot(other);
  assert.equal(pending.policyStatus, "PENDING_MENRO_POLICY"); assert.deepEqual(pending.pendingReasons, ["OTHER_PURPOSE", "CONDITIONAL_THRESHOLD_PENDING"]);
  assert.equal(pending.definition.reporting, "PENDING_MENRO_POLICY"); assert.equal(pending.definition.monitoring, "PENDING_MENRO_POLICY");
  assert.equal(pending.override, null); assert.equal(pending.staffProposal.reason, "Staff recommendation", "the Staff proposal is kept for reference only");
  assert.equal(pending.source, "ADMIN_APPROVED_REQUEST_POLICY_PENDING"); assert.equal(pending.approvedBy, admin.uid);
  const approved = await snapshot(other, { reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE", reason: "Admin confirms documented purpose", expectedPolicyVersion: 0 });
  assert.equal(approved.approvedBy, admin.uid); assert.equal(approved.staffProposal.reason, "Staff recommendation");
  assert.equal(approved.policyStatus, "RESOLVED"); assert.equal(approved.definition.reporting, "REQUIRED"); assert.equal(approved.definition.monitoring, "PERMANENT_SAMPLE");
  for (const sector of ["Government Agency", "Barangay Official"]) {
    const organization = await snapshot({ purpose: "Reforestation / Mangrove / Riverbank / Slope", workflow: { sector } });
    assert.equal(organization.requesterType, "organization"); assert.equal(organization.policyStatus, "PENDING_MENRO_POLICY");
    assert.deepEqual(organization.pendingReasons, ["ORGANIZATION_POLICY_PENDING"]);
    assert.equal(organization.definition.reporting, "PENDING_MENRO_POLICY", "the individual REQUIRED/PERMANENT_SAMPLE template is not applied to an organization");
    assert.equal(organization.definition.monitoring, "PENDING_MENRO_POLICY");
  }
  const conditional = await snapshot({ purpose: "Agroforestry / Fruit Tree", workflow: { sector: "Resident / Individual" } });
  assert.deepEqual(conditional.pendingReasons, ["CONDITIONAL_THRESHOLD_PENDING"]);
});
test("explicit Admin decisions are still validated, and policy version conflicts still fail", async () => {
  const organization = { purpose: "Household / Backyard", workflow: { sector: "Government Agency" } };
  for (const invalid of [{}, { reporting: "REQUIRED", monitoring: "STAFF_SPOT_CHECK" }, { reporting: "CONDITIONAL", monitoring: "NONE", reason: "x" },
    { reporting: "PENDING_MENRO_POLICY", monitoring: "NONE", reason: "x" }, { reporting: "REQUIRED", monitoring: "PENDING_MENRO_POLICY", reason: "x" }, { reporting: "REQUIRED", monitoring: "NONE", reason: " " }])
    await assert.rejects(snapshot(organization, invalid), error => error.status === 400 && Boolean(error.fieldErrors?.policyReason));
  await assert.rejects(snapshot(organization, { reporting: "REQUIRED", monitoring: "NONE", reason: "Admin decision", expectedPolicyVersion: 7 }), error => error.status === 409);
  const decided = await snapshot(organization, { reporting: "OPTIONAL", monitoring: "STAFF_SPOT_CHECK", reason: "Admin decision", expectedPolicyVersion: 0 });
  assert.equal(decided.policyStatus, "RESOLVED"); assert.deepEqual([decided.definition.reporting, decided.definition.monitoring, decided.override.reason], ["OPTIONAL", "STAFF_SPOT_CHECK", "Admin decision"]);
  const individual = await snapshot({ purpose: "Household / Backyard", workflow: { sector: "Resident / Individual" } });
  assert.equal(individual.policyStatus, "RESOLVED"); assert.equal(individual.definition.reporting, "NOT_REQUIRED"); assert.equal(individual.pendingReasons, undefined);
});
test("a pending policy is never released as a reporting exemption, requirement or monitoring authorization", () => {
  const pending = { policyStatus: "PENDING_MENRO_POLICY", definition: { reporting: "PENDING_MENRO_POLICY", monitoring: "PENDING_MENRO_POLICY", quantityThreshold: null } };
  const released = policy.releasePolicy(pending, 40);
  assert.equal(released.reporting, "PENDING_POLICY"); assert.equal(released.reportingStatus, "Reporting Policy Pending");
  assert.equal(released.reportingOverdueApplicable, false); assert.equal(released.monitoring, "PENDING_MENRO_POLICY"); assert.equal(released.requesterMonitoringTasks, false);
});
test("approved snapshots remain unchanged after Admin changes the current configuration", async () => {
  const approved = await snapshot({ purpose: "Household / Backyard", workflow: { sector: "Resident / Individual" } });
  const before = JSON.stringify(approved); const update = input(); update.purposes[0].reporting = "REQUIRED";
  await policy.saveSettings(admin, update);
  assert.equal(JSON.stringify(approved), before); assert.equal(policy.releasePolicy(approved, 20).reporting, "NOT_REQUIRED");
  assert.equal(policy.releasePolicy(approved, 20).reportingOverdueApplicable, false);
});
test("conditional reporting is resolved from actual released quantities, strictly above the approved threshold", () => {
  const snapshot = { definition: { reporting: "CONDITIONAL", monitoring: "NONE", quantityThreshold: 50 } };
  assert.equal(policy.releasePolicy(snapshot, 50).reporting, "OPTIONAL"); assert.equal(policy.releasePolicy(snapshot, 51).reporting, "REQUIRED");
  assert.equal(policy.releasePolicy({ definition: { ...snapshot.definition, quantityThreshold: null } }, 51).reporting, "PENDING_POLICY");
});
test("sample formula caps, rounds once, handles zero and leaves unapproved minimum unresolved", () => {
  const sampling = { ...policy.initialPolicy().sampling, minimum: 1 };
  for (const [planted, target] of [[100, 10], [85, 9], [22, 3], [0, 0], [1, 1]]) assert.equal(policy.samplingReadiness(planted, sampling).target, target);
  assert.equal(policy.samplingReadiness(2, { ...sampling, minimum: 10 }).target, 2);
  assert.equal(policy.samplingReadiness(80, policy.initialPolicy().sampling).target, null);
  assert.equal(policy.samplingReadiness(80, policy.initialPolicy().sampling).baseTarget, 8);
});
test("first visit readiness uses approved dates and procedures and never creates an automatic visit", () => {
  const sampling = { percentage: 10, minimum: 1, intervalMonths: 12, firstVisitDelayWeeks: 2, speciesAllocationProcedure: "MENRO documented species allocation", physicalSelectionProcedure: "MENRO approved field random-selection procedure" };
  const result = policy.samplingReadiness(80, sampling, "2026-10-01", new Date("2026-11-01"));
  assert.equal(result.firstVisitDueDate, "2026-10-15"); assert.equal(result.status, "Pending First Visit"); assert.equal(result.automaticCreationEnabled, false);
});

test("an approved organization condition resolves its own precedence without inventing an agroforestry threshold", async () => {
  const value = input(); value.purposes[1].organizationCondition = { reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE", reason: "Explicit MENRO organization policy" };
  await policy.saveSettings(admin, value);
  const approved = await snapshot({ purpose: "Agroforestry / Fruit Tree", workflow: { sector: "School Organization Representative" } });
  assert.equal(approved.definition.reporting, "REQUIRED"); assert.equal(approved.definition.quantityThreshold, null); assert.equal(approved.override, null);
});
