function approvedEstimate(cohort, plan, latest) {
  const confirmed = Number(cohort.verifiedPlantedQuantity);
  const validQuantity = Number.isSafeInteger(confirmed) && confirmed > 0;
  const complete = latest.total > 0 && latest.assessed === latest.total && latest.unresolved === 0;
  const validityApproved = Boolean(cohort.samplingPolicySnapshot && Array.isArray(cohort.samplingReadiness?.pending) && cohort.samplingReadiness.pending.length === 0 &&
    plan.estimationEligibilityApproved === true && Number.isSafeInteger(cohort.samplingPolicySnapshot.policyVersion) && plan.samplingPolicyVersion === cohort.samplingPolicySnapshot.policyVersion && Number(plan.provisionalTarget) === latest.total &&
    latest.total <= confirmed && cohort.baseline?.sampleUnits?.every(unit => unit.unitType === "tree"));
  const living = latest.counts.Healthy + latest.counts.Damaged;
  return { confirmedPlanted: validQuantity ? confirmed : null, permanentSampleSize: latest.total,
    assessed: latest.assessed, unresolved: latest.unresolved, monitoringCoverage: latest.coverage,
    sampleSurvivalRate: complete ? living / latest.total * 100 : null,
    estimatedSurvivors: complete && validityApproved && validQuantity ? living / latest.total * confirmed : null,
    estimateStatus: !complete ? "INCOMPLETE_OR_UNRESOLVED_ASSESSMENTS" : !validityApproved ? "SAMPLING_VALIDITY_PENDING" : "APPROVED_SAMPLE_ESTIMATE",
    label: "Estimated survivors from approved permanent samples; not a physical whole-site count or official aggregate KPI" };
}
module.exports = { approvedEstimate };
