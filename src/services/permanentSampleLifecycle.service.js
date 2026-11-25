// Read-only: the permanent-sample state of each existing monitoring lifecycle (MON record), linked by its verified planting
// report. Nothing is written to the lifecycle, its history or its aggregate statistics, and no lifecycle is ever created.
const release = require("../config/permanentSampleRelease");
const schedulePolicy = require("../config/permanentSampleSchedule");
const { resolveVerifiedPlantingCohortConfig } = require("../config/verifiedPlantingCohort");
const { cohortIdFor, documentReference } = require("./verifiedPlantingCohortEligibility");

const OPEN = new Set(["DRAFT", "RETURNED", "PENDING_ADMIN_APPROVAL"]);
const byNumber = (a, b) => Number(a.visitNumber || 0) - Number(b.visitNumber || 0);

function summarizeLifecycle({ cohortId, cohort, visits, actorId, today = schedulePolicy.dateOnlyInManila() }) {
  const bound = visits.filter(visit => visit.cohortId === cohortId && visit.siteId === cohort?.source?.siteId).sort(byNumber);
  const approved = bound.filter(visit => visit.status === "APPROVED"), open = bound.find(visit => OPEN.has(visit.status)) || null;
  const first = bound.find(visit => Number(visit.visitNumber) === 1) || null, last = approved.at(-1) || null;
  // A start date exists once Visit 1 is submitted: provisional until Admin approves it. Drafts and returned visits have none.
  const started = first && ["APPROVED", "PENDING_ADMIN_APPROVAL"].includes(first.status) && schedulePolicy.validDateOnly(first.dateMonitored);
  const schedule = cohort?.permanentSampleSchedule || {};
  const next = last && schedulePolicy.validDateOnly(schedule.nextScheduledDueDate) ? schedule.nextScheduledDueDate : null;
  const counts = last ? require("./sampleMonitoringVisit.service").summary((last.sampleAssessments || []).filter(Boolean)) : null;
  return {
    cohortId, approvedVisits: approved.length,
    startMonitoringDate: started ? first.dateMonitored : null,
    startProvisional: Boolean(started) && first.status !== "APPROVED",
    nextVisitNumber: open ? Number(open.visitNumber) : approved.length + 1,
    nextMonitoringDate: next, nextStatus: next ? schedulePolicy.scheduleStatus(next, today) : null,
    openVisit: open ? { visitNumber: Number(open.visitNumber) || null, status: open.status, ownedByYou: open.createdBy === actorId } : null,
    latest: counts ? { visitNumber: Number(last.visitNumber) || null, dateMonitored: last.dateMonitored || null, healthy: counts.healthy, damaged: counts.damaged,
      confirmedDead: counts.confirmedDead, needsRechecking: counts.needsRechecking, total: counts.total, survivalRate: counts.survivalRate } : null,
  };
}

async function attachPermanentSample(records, { actorId, db = require("../config/firebase").db } = {}) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) return records;
  const policy = release.resolve();
  if (policy.pilot && !policy.users.includes(actorId)) return records;
  return Promise.all(records.map(async record => {
    const reportId = record?.plantingReportId;
    if (typeof reportId !== "string" || !documentReference(reportId)) return record;
    const cohortId = cohortIdFor(reportId);
    if (!release.allowsCohort(cohortId, policy)) return record;
    try {
      const cohort = await db.collection("verifiedPlantingCohorts").doc(cohortId).get();
      const visits = cohort.exists ? (await db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortId).get()).docs.map(doc => ({ id: doc.id, ...doc.data() })) : [];
      return { ...record, permanentSample: summarizeLifecycle({ cohortId, cohort: cohort.exists ? cohort.data() : null, visits, actorId }) };
    } catch (error) {
      console.warn(`[permanent-sample-lifecycle] ${error.code || error.message}`);
      return { ...record, permanentSample: null };
    }
  }));
}

module.exports = { attachPermanentSample, summarizeLifecycle };
