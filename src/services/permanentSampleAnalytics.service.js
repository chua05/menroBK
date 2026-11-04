const CONDITIONS = ["Healthy", "Damaged", "Dead", "Needs Rechecking"];
const error = (status, message) => Object.assign(new Error(message), { status });
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);

// A cohort/sample pair is the permanent identity. Counts use one latest
// approved visit per cohort and never extrapolate to whole-site survival.
function summarize(cohorts, visits) {
  const output = [];
  const reasons = {};
  const exclude = reason => { reasons[reason] = (reasons[reason] || 0) + 1; };
  for (const cohort of cohorts) {
    const baseline = cohort.baseline;
    const plan = cohort.samplingPlan;
    if (baseline?.approvalStatus !== "APPROVED" || plan?.status !== "APPROVED") { exclude("unapprovedBaselineOrPlan"); continue; }
    const ids = (baseline.sampleUnits || []).map(unit => unit.permanentId);
    if (!ids.length || ids.some(id => !safeId(id)) || new Set(ids).size !== ids.length) { exclude("invalidPermanentIds"); continue; }
    const eligible = visits.filter(visit => visit.status === "APPROVED" && visit.cohortId === cohort.id
      && visit.siteId === cohort.source?.siteId && visit.baselineVersion === cohort.baselineVersion
      && visit.samplingPlanVersion === plan.version)
      .sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate)) || String(a.id).localeCompare(String(b.id)));
    if (!eligible.length) { exclude("noComparableApprovedVisit"); continue; }
    // Multiple approvals on the same date are ambiguous; do not silently choose
    // one as the authoritative latest observation.
    const dates = eligible.map(visit => visit.visitDate);
    if (new Set(dates).size !== dates.length) { exclude("ambiguousApprovedDates"); continue; }
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
    if (invalid) exclude("invalidAssessments");
    else output.push({ cohortId: cohort.id, siteId: cohort.source.siteId,
      baselineVersion: cohort.baselineVersion, samplingPlanVersion: plan.version, latest: history.at(-1), history });
  }
  return { cohorts: output, exclusions: { cohorts: Object.values(reasons).reduce((a, b) => a + b, 0), reasons }, limitations: [
    "Approved permanent samples only; these are not official whole-site survival estimates.",
    "Needs Rechecking and Not Located After Rechecking are unresolved, not confirmed deaths.",
    "Only the current approved baseline and plan are comparable. Invalid or ambiguous records are excluded.",
  ] };
}

function createService({ db, enabled }) {
  const authorize = (actorId, actorRole) => {
    if (!enabled()) throw error(409, "Permanent sample analytics are disabled.");
    if (!actorId) throw error(401, "Authentication required.");
    if (!["staff", "admin"].includes(actorRole)) throw error(403, "Access denied.");
  };
  const queryFor = (actorId, actorRole) => {
    let query = db.collection("sampleMonitoringVisits").where("status", "==", "APPROVED");
    if (actorRole === "staff") query = query.where("createdBy", "==", actorId);
    return query;
  };
  return {
    async filters({ actorId, actorRole, cursor = "", limit = 50 }) {
      authorize(actorId, actorRole);
      const size = Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > 50) throw error(400, "Filter limit must be 1–50.");
      let query = queryFor(actorId, actorRole).orderBy("__name__", "asc");
      if (cursor) {
        if (!safeId(cursor)) throw error(400, "Invalid filter cursor.");
        const doc = await db.collection("sampleMonitoringVisits").doc(cursor).get();
        if (!doc.exists || doc.data().status !== "APPROVED" || actorRole === "staff" && doc.data().createdBy !== actorId) throw error(400, "Invalid filter cursor.");
        query = query.startAfter(doc);
      }
      const snapshot = await query.select("cohortId", "siteId").limit(size + 1).get();
      const filters = new Map();
      for (const doc of snapshot.docs.slice(0, size)) {
        const row = doc.data();
        if (safeId(row.cohortId) && safeId(row.siteId)) filters.set(JSON.stringify([row.cohortId, row.siteId]), { cohortId: row.cohortId, siteId: row.siteId });
      }
      return { filters: [...filters.values()], nextCursor: snapshot.docs.length > size ? snapshot.docs[size - 1].id : null };
    },
    async get({ actorId, actorRole, cohortId, siteId }) {
    authorize(actorId, actorRole);
    for (const id of [cohortId, siteId]) if (id !== undefined && !safeId(id)) throw error(400, "Invalid analytics filter.");
    let query = queryFor(actorId, actorRole);
    if (cohortId) query = query.where("cohortId", "==", cohortId);
    if (siteId) query = query.where("siteId", "==", siteId);
    // Fail closed instead of silently presenting a truncated population.
    const snapshot = await query.limit(1001).get();
    if (snapshot.docs.length > 1000) throw error(400, "Narrow the site or cohort filter.");
    const visits = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    const cohorts = [];
    let missing = 0;
    for (const id of new Set(visits.map(visit => visit.cohortId))) {
      if (!safeId(id)) continue;
      const doc = await db.collection("verifiedPlantingCohorts").doc(id).get();
      if (doc.exists) cohorts.push({ ...doc.data(), id: doc.id });
      else missing++;
    }
    const result = summarize(cohorts, visits);
    if (missing) { result.exclusions.cohorts += missing; result.exclusions.reasons.missingCohort = missing; }
    return result;
  } };
}
module.exports = { createService, summarize };
