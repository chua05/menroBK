const test = require("node:test");
const assert = require("node:assert/strict");
const { approvedEstimate } = require("../src/utils/permanentSampleEstimate.util");
const fixture = () => ({ cohort: { verifiedPlantedQuantity: 100, samplingPolicySnapshot: { minimum: 1, policyVersion: 1 }, samplingReadiness: { pending: [] }, baseline: { sampleUnits: Array.from({ length: 10 }, () => ({ unitType: "tree" })) } },
  plan: { samplingPolicyVersion: 1, estimationEligibilityApproved: true, provisionalTarget: 10 }, latest: { total: 10, assessed: 10, unresolved: 0, coverage: 1, counts: { Healthy: 7, Damaged: 1, Dead: 2, "Needs Rechecking": 0 } } });
test("approved complete permanent samples yield labeled survival estimates without changing official KPIs", () => {
  const { cohort, plan, latest } = fixture(); const result = approvedEstimate(cohort, plan, latest);
  assert.equal(result.sampleSurvivalRate, 80); assert.equal(result.estimatedSurvivors, 80); assert.match(result.label, /not a physical/);
});
test("incomplete and unresolved samples cannot publish full-site estimates", () => {
  for (const override of [{ assessed: 9 }, { unresolved: 1 }]) {
    const { cohort, plan, latest } = fixture(); const value = approvedEstimate(cohort, plan, { ...latest, ...override });
    assert.equal(value.estimatedSurvivors, null); assert.equal(value.sampleSurvivalRate, null);
  }
});
test("legacy, plot-based, mismatched targets and unapproved sampling validity remain estimate-ineligible", () => {
  const { cohort, plan, latest } = fixture();
  for (const [source, sampling] of [[{ ...cohort, samplingPolicySnapshot: null }, plan], [cohort, { ...plan, estimationEligibilityApproved: false }], [cohort, { ...plan, provisionalTarget: 9 }], [cohort, { ...plan, samplingPolicyVersion: 2 }], [{ ...cohort, baseline: { sampleUnits: [{ unitType: "plot" }] } }, plan], [{ ...cohort, samplingReadiness: undefined }, plan]]) assert.equal(approvedEstimate(source, sampling, latest).estimatedSurvivors, null);
});
