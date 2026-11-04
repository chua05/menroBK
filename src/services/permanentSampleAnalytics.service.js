const CONDITIONS = ["Healthy", "Damaged", "Dead", "Needs Rechecking"];
const error = (status, message) => Object.assign(new Error(message), { status });
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);

// A cohort/sample pair is the permanent identity. Counts use one latest
// approved visit per cohort and never extrapolate to whole-site survival.
function summarize(cohorts, visits) {
  const output = [];
  for (const cohort of cohorts) {
    const baseline = cohort.baseline;
    const plan = cohort.samplingPlan;
    if (baseline?.approvalStatus !== "APPROVED" || plan?.status !== "APPROVED") continue;
    const ids = (baseline.sampleUnits || []).map(unit => unit.permanentId);
    if (!ids.length || ids.some(id => !safeId(id)) || new Set(ids).size !== ids.length) continue;
    const eligible = visits.filter(visit => visit.status === "APPROVED" && visit.cohortId === cohort.id
      && visit.siteId === cohort.source?.siteId && visit.baselineVersion === cohort.baselineVersion
      && visit.samplingPlanVersion === plan.version)
      .sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate)) || String(a.id).localeCompare(String(b.id)));
    if (!eligible.length) continue;
    // Multiple approvals on the same date are ambiguous; do not silently choose
    // one as the authoritative latest observation.
    const dates = eligible.map(visit => visit.visitDate);
    if (new Set(dates).size !== dates.length) continue;
    const history = [];
    let previous = new Map();
    let invalid = false;
    for (const visit of eligible) {
      const observations = new Map();
      for (const row of visit.sampleAssessments || []) {
        if (!ids.includes(row.sampleId) || observations.has(row.sampleId)) { invalid = true; break; }
        observations.set(row.sampleId, row);
      }
      if (invalid) break;
      const counts = Object.fromEntries(CONDITIONS.map(condition => [condition, 0]));
      const samples = ids.map(sampleId => {
        const row = observations.get(sampleId);
        const condition = CONDITIONS.includes(row?.condition) ? row.condition : null;
        if (condition) counts[condition]++;
        return { sampleId, condition, assessmentRevision: row?.assessmentRevision ?? 0,
          investigationOutcome: condition === "Needs Rechecking" && row?.investigationOutcome === "Not Located After Rechecking"
            ? row.investigationOutcome : null,
          evidenceRevisions: (row?.evidenceHistory || []).map(item => item.revision).filter(Number.isInteger),
          changedFrom: previous.has(sampleId) && previous.get(sampleId) !== condition ? previous.get(sampleId) || "Unassessed" : null };
      });
      const assessed = Object.values(counts).reduce((sum, count) => sum + count, 0);
      history.push({ visitId: visit.id, visitDate: visit.visitDate, counts, total: ids.length, assessed,
        unassessed: ids.length - assessed, unresolved: counts["Needs Rechecking"],
        coverage: assessed / ids.length, samples });
      previous = new Map(samples.map(row => [row.sampleId, row.condition]));
    }
    if (!invalid) output.push({ cohortId: cohort.id, siteId: cohort.source.siteId,
      baselineVersion: cohort.baselineVersion, samplingPlanVersion: plan.version, latest: history.at(-1), history });
  }
  return { cohorts: output, limitations: [
    "Approved permanent samples only; these are not official whole-site survival estimates.",
    "Needs Rechecking and Not Located After Rechecking are unresolved, not confirmed deaths.",
    "Only the current approved baseline and plan are comparable. Invalid or ambiguous records are excluded.",
  ] };
}

function createService({ db, enabled }) {
  return { async get({ actorId, actorRole, cohortId, siteId }) {
    if (!enabled()) throw error(409, "Permanent sample analytics are disabled.");
    if (!actorId) throw error(401, "Authentication required.");
    if (!["staff", "admin"].includes(actorRole)) throw error(403, "Access denied.");
    for (const id of [cohortId, siteId]) if (id !== undefined && !safeId(id)) throw error(400, "Invalid analytics filter.");
    let query = db.collection("sampleMonitoringVisits").where("status", "==", "APPROVED");
    if (actorRole === "staff") query = query.where("createdBy", "==", actorId);
    if (cohortId) query = query.where("cohortId", "==", cohortId);
    if (siteId) query = query.where("siteId", "==", siteId);
    // Fail closed instead of silently presenting a truncated population.
    const snapshot = await query.limit(1001).get();
    if (snapshot.docs.length > 1000) throw error(400, "Narrow the site or cohort filter.");
    const visits = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    const cohorts = [];
    for (const id of new Set(visits.map(visit => visit.cohortId))) {
      if (!safeId(id)) continue;
      const doc = await db.collection("verifiedPlantingCohorts").doc(id).get();
      if (doc.exists) cohorts.push({ ...doc.data(), id: doc.id });
    }
    return summarize(cohorts, visits);
  } };
}
module.exports = { createService, summarize };
