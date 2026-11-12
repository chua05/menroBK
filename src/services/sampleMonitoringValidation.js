const { isDeepStrictEqual } = require("node:util");
const invalid = message => Object.assign(new Error(message), { status: 400 });
const conflict = message => Object.assign(new Error(message), { status: 409 });
function version(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid("expectedVersion must be a nonnegative integer.");
}
function boolean(value, name) {
  if (typeof value !== "boolean") throw invalid(`${name} must be a Boolean.`);
}
function measurement(value) {
  if (value === null || value === undefined || typeof value === "string" && !value.trim()) return null;
  if (typeof value !== "number" && !(typeof value === "string" && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim()))) {
    throw invalid("Measurements must be nonnegative finite numbers or empty.");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw invalid("Measurements must be nonnegative finite numbers or empty.");
  return number;
}
function cohortBinding(cohort, visit) {
  if (cohort?.samplingPlan?.status !== "APPROVED" || cohort?.baseline?.approvalStatus !== "APPROVED" ||
      cohort.source?.siteId !== visit.siteId || Number(cohort.samplingPlan.version) !== visit.samplingPlanVersion ||
      Number(cohort.baselineVersion || 0) !== visit.baselineVersion) {
    throw conflict("Approved site, plan and baseline versions must still match this visit.");
  }
}
function references(input, sampleId, priorVisit, priorVisitId) {
  const prior = priorVisit?.sampleAssessments?.find(row => row.sampleId === sampleId);
  const expected = {
    baselineReference: { sampleId },
    previousAssessmentReference: prior && (prior.recheckQueued || prior.condition === "Needs Rechecking") ? {
      visitId: priorVisitId, sampleId, condition: prior.condition, remarks: prior.remarks || "",
      investigationOutcome: prior.investigationOutcome || null,
    } : null,
  };
  for (const name of Object.keys(expected)) {
    // Omitted/null references carry no client assertion. All stored references
    // are derived here; nonempty stale or forged assertions are rejected.
    if (input?.[name] != null && !isDeepStrictEqual(input[name], expected[name])) {
      throw conflict("Assessment references changed. Refresh the authoritative visit.");
    }
  }
  return expected;
}
async function historicalVisit(read, visit) {
  if (!visit.priorVisitId) return null;
  const snapshot = await read(visit.priorVisitId);
  const prior = snapshot.data();
  if (!snapshot.exists || prior.status !== "APPROVED" || prior.cohortId !== visit.cohortId || prior.siteId !== visit.siteId ||
      prior.baselineVersion !== visit.baselineVersion || prior.samplingPlanVersion !== visit.samplingPlanVersion || prior.visitDate >= visit.visitDate) {
    throw conflict("Approved historical assessment no longer matches this visit.");
  }
  return prior;
}
module.exports = { version, boolean, measurement, cohortBinding, references, historicalVisit, invalid, conflict };
