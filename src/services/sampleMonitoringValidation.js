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
// API boundary units: stem diameter is exchanged in millimetres and stored in the existing centimetre field
// (mm = cm x 10). Fixed-decimal rounding removes binary float noise (e.g. 12.3 / 10 -> 1.23, not 1.2300000000000002).
const mmToCm = mm => mm === null || mm === undefined || !Number.isFinite(mm) ? null : Number((mm / 10).toFixed(6));
const cmToMm = cm => cm === null || cm === undefined || !Number.isFinite(cm) ? null : Number((cm * 10).toFixed(5));
// First monitoring visit = baseline registration: the visit registers the baseline and the cohort's
// baseline is not yet approved, so the visit binds to the unapproved first-visit plan instead.
const FIRST_VISIT_PLAN_OPEN_STATUSES = new Set(["DRAFT", "PENDING_ADMIN_APPROVAL", "RETURNED"]);
function registersFirstVisitBaseline(cohort, visit) {
  return visit?.registersBaseline === true && cohort?.baseline?.approvalStatus !== "APPROVED";
}
// Single source of truth for whether a visit still matches its cohort (site, plan, baseline).
function cohortBinding(cohort, visit) {
  if (registersFirstVisitBaseline(cohort, visit)) {
    const plan = cohort?.samplingPlan;
    // Evaluated only for first-visit visits, so legacy paths never read the flag (or hit its 503 when invalid).
    if (!require("../config/firstVisitBaseline").firstVisitBaselineEnabled()) {
      throw Object.assign(conflict("The first-visit baseline workflow is disabled."), { code: "FIRST_VISIT_BASELINE_DISABLED" });
    }
    if (plan?.origin !== "FIRST_VISIT" || !FIRST_VISIT_PLAN_OPEN_STATUSES.has(plan?.status) ||
        cohort.source?.siteId !== visit.siteId || Number(plan.version) !== visit.samplingPlanVersion ||
        Number(cohort.baselineVersion || 0) + 1 !== visit.baselineVersion) {
      throw conflict("The first-visit site, sampling plan and baseline versions must still match this visit.");
    }
    return;
  }
  if (cohort?.samplingPlan?.status !== "APPROVED" || cohort?.baseline?.approvalStatus !== "APPROVED" ||
      cohort.source?.siteId !== visit.siteId || Number(cohort.samplingPlan.version) !== visit.samplingPlanVersion ||
      Number(cohort.baselineVersion || 0) !== visit.baselineVersion) {
    throw conflict("Approved site, plan and baseline versions must still match this visit.");
  }
}
// The permanent samples a visit assesses: the first-visit plan's Tree IDs until visit 1 is approved,
// then the approved baseline's registered units (the same Tree IDs).
function samplesFor(cohort, visit) {
  const rows = registersFirstVisitBaseline(cohort, visit) ? cohort?.samplingPlan?.selectedSamples : cohort?.baseline?.sampleUnits;
  return Array.isArray(rows) ? rows : [];
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
module.exports = { version, boolean, measurement, mmToCm, cmToMm, cohortBinding, samplesFor, registersFirstVisitBaseline, references, historicalVisit, invalid, conflict };
