// Simplified first visit: Staff select an existing Admin-verified Planting Report and start Visit 1. The one monitoring
// cohort for that report is created here, idempotently, only after every gate and eligibility check; the visit itself is
// created by the existing sampleMonitoringVisit.create(). The planting report and its stored policy are never written.
const release = require("../config/permanentSampleRelease");
const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("../config/firebase");
const { resolveVerifiedPlantingCohortConfig } = require("../config/verifiedPlantingCohort");
const firstVisitConfig = require("../config/firstVisitBaseline");
const schedulePolicy = require("../config/permanentSampleSchedule");
const { verifiedReportFirstVisitEnabled } = require("../config/verifiedReportFirstVisit");
const { cohortIdFor, authoritativeQuantity, documentReference } = require("./verifiedPlantingCohortEligibility");
const cohortService = require("./verifiedPlantingCohort.service");
const visits = require("./sampleMonitoringVisit.service");

const SCAN_LIMIT = 50; // reports read per listing page
const coded = (status, code, message) => Object.assign(new Error(message), { status, code });
const plainReader = { get: target => target.get() };
const cohortsFor = reportId => db.collection("verifiedPlantingCohorts").where("source.plantingReportId", "==", reportId);

// The checks visit creation applies to an existing cohort, for a cohort that does not exist yet.
async function prepare(reader, { reportId, report, now, actorId }) {
  const prepared = await cohortService.prepareCohort(reader, { reportId, report, now, authorization: { trigger: "FIRST_VISIT_START", authorizedBy: actorId } });
  const others = (await reader.get(cohortsFor(reportId))).docs.filter(doc => doc.id !== prepared.ref.id);
  if (others.length) throw coded(409, "COHORT_IDENTITY_CONFLICT", "Another monitoring setup already exists for this planting report. MENRO must review it.");
  if (prepared.existing) return prepared;
  const source = prepared.data.source, siteId = documentReference(source.siteId);
  const site = siteId ? await reader.get(db.collection("sites").doc(siteId)) : null;
  const problems = visits.reportEligibilityProblems(prepared.data, { exists: true, data: () => report }, site);
  if (cohortService.siteMismatch(report, prepared.event) && !problems.includes("SITE_MISMATCH")) problems.push("SITE_MISMATCH");
  let plan = null, planProblem = null;
  try {
    plan = cohortService.prepareFirstVisitPlan({ cohort: { id: prepared.ref.id, ...prepared.data }, cohortId: prepared.ref.id, actorId, now, reportNumber: report.reportNumber });
  } catch (error) { planProblem = error; }
  return { ...prepared, site, problems, plan, planProblem };
}

const plantedAfter = (source, date) => schedulePolicy.validDateOnly(source.plantingDate) && date < source.plantingDate;

async function startFirstVisit({ reportId, actorId, actorRole, visitDate }) {
  if (actorRole !== "staff") throw coded(403, "MONITORING_ACTION_FORBIDDEN", "Only MENRO Staff can start monitoring visits.");
  if (typeof reportId !== "string" || !documentReference(reportId)) throw coded(400, "INVALID_PLANTING_REPORT", "Select a valid planting report.");
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw coded(409, "COHORT_WORKFLOW_DISABLED", "Monitoring is not available.");
  if (!verifiedReportFirstVisitEnabled()) throw coded(409, "VERIFIED_REPORT_FIRST_VISIT_DISABLED", "Monitoring cannot be started from this planting report yet.");
  if (!firstVisitConfig.firstVisitBaselineEnabled()) throw coded(409, "FIRST_VISIT_POLICY_DISABLED", "The first monitoring visit is not open yet.");
  if (!schedulePolicy.resolvePermanentSampleSchedule().enabled) throw coded(409, "VISIT_SCHEDULING_POLICY_PENDING", "New monitoring visits are not open yet.");
  const cohortId = cohortIdFor(reportId);
  release.writeScope(actorId, cohortId);
  // Refused before anything is written; create() repeats the same date rules.
  if (!schedulePolicy.validDateOnly(visitDate)) throw coded(400, "INVALID_VISIT_DATE", "Enter a valid visit date.");
  if (visitDate > schedulePolicy.dateOnlyInManila()) throw coded(409, "VISIT_NOT_OPEN", "The first visit date cannot be in the future.");
  await db.runTransaction(async tx => {
    const reportSnap = await tx.get(db.collection("plantingReports").doc(reportId));
    if (!reportSnap.exists) throw coded(404, "REPORT_NOT_FOUND", "Planting report not found.");
    const prepared = await prepare(tx, { reportId, report: reportSnap.data(), now: Timestamp.now(), actorId });
    release.writeScope(actorId, cohortId);
    if (prepared.existing) {
      const { samplingPlan, baseline } = prepared.existing;
      if (baseline?.approvalStatus === "APPROVED" || (samplingPlan && samplingPlan.origin !== "FIRST_VISIT")) {
        throw coded(409, "FIRST_VISIT_ALREADY_REGISTERED", "The first monitoring visit for this planting report is already registered.");
      }
      return;
    }
    if (prepared.problems.length) throw visits.reportNotEligible(prepared.problems);
    if (prepared.planProblem) throw prepared.planProblem.code ? prepared.planProblem : coded(409, "FIRST_VISIT_PLAN_UNAVAILABLE", "The sample trees cannot be prepared from this planting report's data.");
    if (plantedAfter(prepared.data.source, visitDate)) throw coded(409, "VISIT_BEFORE_ELIGIBILITY", `Monitoring cannot start before the planting date, ${prepared.data.source.plantingDate}.`);
    tx.create(prepared.ref, prepared.data);
  });
  return visits.create({ cohortId, actorId, actorRole, visitDate });
}

// One bounded page of verified reports that have no cohort yet, in the shape readiness uses for its rows.
async function listVerifiedReports({ actorId, actorRole, cursor }) {
  if (!["staff", "admin"].includes(actorRole)) throw coded(403, "MONITORING_ACTION_FORBIDDEN", "Monitoring visits are restricted to MENRO Staff and Admin.");
  const policy = release.assertUser(actorId);
  if (cursor !== undefined && (typeof cursor !== "string" || !documentReference(cursor))) throw coded(400, "INVALID_READINESS_QUERY", "The readiness page request is invalid.");
  const schedule = schedulePolicy.resolvePermanentSampleSchedule();
  const gates = { writesPaused: policy.paused, firstVisitBaselineEnabled: firstVisitConfig.firstVisitBaselineEnabled(),
    scheduleEnabled: schedule.enabled, pilotRestricted: policy.pilot, verifiedReportRuleEnabled: verifiedReportFirstVisitEnabled() };
  const empty = { cohorts: [], eligible: [], notEligible: [], truncated: false, nextCursor: null, gates };
  if (!gates.verifiedReportRuleEnabled) return empty;
  const ordered = db.collection("plantingReports").orderBy("__name__");
  const scanned = (await (cursor === undefined ? ordered : ordered.startAfter(cursor)).limit(SCAN_LIMIT + 1).get()).docs;
  const page = scanned.slice(0, SCAN_LIMIT);
  const nextCursor = scanned.length > SCAN_LIMIT ? page.at(-1).id : null;
  const today = schedulePolicy.dateOnlyInManila();
  const rows = (await Promise.all(page.map(async doc => {
    const report = doc.data();
    if (report.archived === true || !authoritativeQuantity(report) || !release.allowsCohort(cohortIdFor(doc.id), policy)) return null;
    let prepared;
    try { prepared = await prepare(plainReader, { reportId: doc.id, report, now: Timestamp.now(), actorId }); }
    catch (error) {
      // An existing cohort is listed, with its own reasons, by readiness; a report whose stored values cannot be used
      // (400) is not offered. Neither hides the other reports. Anything else is a real failure.
      if (error.code !== "COHORT_IDENTITY_CONFLICT" && error.status !== 400) throw error;
      return null;
    }
    if (prepared.existing) return null;
    const sampleTarget = firstVisitConfig.calculateSampleTarget(prepared.data.verifiedPlantedQuantity);
    const reasons = [{ code: "FIRST_VISIT_REGISTERS_BASELINE", informational: true, sampleTarget }];
    if (gates.writesPaused) reasons.push({ code: "WRITES_PAUSED" });
    if (!gates.firstVisitBaselineEnabled) reasons.push({ code: "FIRST_VISIT_POLICY_DISABLED" });
    if (!gates.scheduleEnabled) reasons.push({ code: "VISIT_SCHEDULING_POLICY_PENDING" });
    if (prepared.problems.length) reasons.push({ code: "REPORT_NOT_ELIGIBLE", problems: prepared.problems });
    else if (prepared.planProblem) reasons.push({ code: prepared.planProblem.code || "FIRST_VISIT_PLAN_UNAVAILABLE" });
    if (plantedAfter(prepared.data.source, today)) reasons.push({ code: "VISIT_NOT_OPEN", openingDate: prepared.data.source.plantingDate });
    const canCreateVisit = reasons.every(reason => reason.informational === true);
    const context = require("./sampleMonitoringViewContext").readinessContext({ cohort: prepared.data, siteId: prepared.data.source.siteId || null,
      site: prepared.site?.exists ? prepared.site.data() : null, report, sampleTarget, nextVisitNumber: 1, monitoringStatus: canCreateVisit ? "FIRST_VISIT_AVAILABLE" : "NOT_STARTED" });
    return { plantingReportId: doc.id, cohortId: prepared.ref.id, reportNumber: report.reportNumber || null, siteName: prepared.site?.exists ? prepared.site.data().siteName || null : null,
      nextVisitNumber: 1, nextScheduledDueDate: today, openingDate: today, scheduleStatus: schedule.enabled ? schedulePolicy.scheduleStatus(today, today) : "POLICY_PENDING",
      registersBaseline: true, sampleTarget, startsFromReport: true, canCreateVisit, reasons, context };
  }))).filter(Boolean);
  return { ...empty, cohorts: rows, eligible: rows.filter(row => row.canCreateVisit), notEligible: rows.filter(row => !row.canCreateVisit), truncated: nextCursor !== null, nextCursor };
}

module.exports = { startFirstVisit, listVerifiedReports };
