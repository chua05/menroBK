const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const validation = require("./sampleMonitoringValidation");
const release = require("../config/permanentSampleRelease");
const {
  Timestamp
} = require("firebase-admin/firestore");
const {
  db
} = require("../config/firebase");
const {
  resolveVerifiedPlantingCohortConfig
} = require("../config/verifiedPlantingCohort");
const schedulePolicy = require("../config/permanentSampleSchedule");
const firstVisitConfig = require("../config/firstVisitBaseline");
// Pure first-visit helpers (B2). Loaded lazily so test doubles of ../config/firebase apply first.
const cohortHelpers = () => require("./verifiedPlantingCohort.service");
// Existing notification infrastructure, loaded lazily for the same reason.
const notificationService = () => require("./notification.service");
const growthCriteria = require("../config/permanentSampleGrowthCriteria");
const { MORTALITY_CAUSES } = require("../config/permanentSampleMonitoringVocabulary");
const { authoritativeQuantity, firstVisitPolicy } = require("./verifiedPlantingCohortEligibility");
const { VERIFIED_REPORT_POLICY_ID, verifiedReportFirstVisitEnabled } = require("../config/verifiedReportFirstVisit");
const CONDITIONS = new Set(["Healthy", "Damaged", "Dead", "Needs Rechecking"]);
// A visit stays "open" until Admin approves it; returned visits are still open for Staff correction.
const OPEN_VISIT_STATUSES = new Set(["DRAFT", "RETURNED", "PENDING_ADMIN_APPROVAL"]);
const usesRejectedProvisionalPolicy = cohort => {
  // A first-visit plan carries its own 10% policy, which applies only while its flag is on.
  if (cohort?.samplingPlan?.provisionalPolicy === firstVisitConfig.FIRST_VISIT_BASELINE_POLICY_ID && firstVisitConfig.firstVisitBaselineEnabled()) return false;
  const config = resolveVerifiedPlantingCohortConfig();
  return !config.provisionalSamplingAllowed && (!cohort?.samplingPolicySnapshot || cohort?.samplingPlan?.provisionalPolicy === config.provisionalSamplingPolicy);
};
const INVESTIGATION_OUTCOMES = new Set(["Not Located After Rechecking"]);
// Defense in depth behind the Staff-only routes: every caller must state the actor's
// role, and any role other than Staff (including Admin, or a missing role) can never
// create, edit or submit a monitoring visit.
const assertStaffWriter = actorRole => {
  if (actorRole !== "staff") throw Object.assign(new Error("Only MENRO Staff can create, edit or submit monitoring visits."), { status: 403, code: "MONITORING_ACTION_FORBIDDEN" });
};
const disabled = () => Object.assign(new Error("Verified planting cohort workflow is disabled."), {
  status: 409,
  code: "COHORT_WORKFLOW_DISABLED"
});
const conflict = m => Object.assign(new Error(m), {
  status: 409
});
const id = (cohortId, date) => `VPMV-${crypto.createHash("sha256").update(`${cohortId}\0${date}`).digest("hex").slice(0, 28)}`;
const visitRef = visitId => db.collection("sampleMonitoringVisits").doc(visitId);
async function priorApprovedVisit(cohortId, siteId, planVersion, baselineVersion, visitDate) {
  const snapshot = await db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortId).where("status", "==", "APPROVED").get();
  const candidates = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  })).filter(visit => visit.siteId === siteId && Number(visit.samplingPlanVersion) === Number(planVersion) && Number(visit.baselineVersion) === Number(baselineVersion) && String(visit.visitDate) < String(visitDate));
  candidates.sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate)) || String(a.id).localeCompare(String(b.id)));
  if (candidates.length > 1 && candidates.at(-1).visitDate === candidates.at(-2).visitDate) throw conflict("Ambiguous prior approved monitoring visits require MENRO review.");
  return candidates.at(-1) || null;
}
// Spec section 21: always derived from the stored per-tree assessments (client totals are never read).
// Survival = Living / Total permanent sample x 100, published only when no tree is unassessed or unresolved.
function summary(assessments) {
  const result = assessments.reduce((r, a) => {
    if (a.condition === "Healthy") r.healthy++;else if (a.condition === "Damaged") r.damaged++;else if (a.condition === "Dead") r.dead++;else if (a.condition === "Needs Rechecking") r.needsRechecking++;
    else r.unassessed++;
    return r;
  }, {
    healthy: 0,
    damaged: 0,
    dead: 0,
    needsRechecking: 0,
    unassessed: 0
  });
  result.total = assessments.length;
  result.assessed = result.total - result.unassessed;
  result.resolved = result.healthy + result.damaged + result.dead;
  result.incomplete = result.unassessed + result.needsRechecking;
  result.living = result.healthy + result.damaged;
  result.complete = result.incomplete === 0;
  // Spec names; the earlier keys above stay as compatibility aliases for existing clients.
  result.confirmedDead = result.dead;
  result.notAssessed = result.unassessed;
  result.completed = result.assessed;
  const final = result.total > 0 && result.notAssessed === 0 && result.needsRechecking === 0;
  result.survivalRate = final ? Number(((result.living / result.total) * 100).toFixed(2)) : null;
  result.survivalStatus = final ? "COMPLETE" : "PENDING_INCOMPLETE";
  const count = key => assessments.reduce((map, row) => (row[key] ? { ...map, [row[key]]: (map[row[key]] || 0) + 1 } : map), {});
  result.growth = {
    baselineOnly: assessments.length > 0 && assessments.every(a => a.baselineOnly === true),
    heightDifferences: assessments.filter(a => Number.isFinite(a.heightDifferenceCm)).length,
    stemDiameterDifferences: assessments.filter(a => Number.isFinite(a.stemDiameterDifferenceMm)).length,
    measurementDecreased: assessments.filter(a => a.measurementDecreased === true).length,
    growthPerformance: count("growthPerformance"),
    growthStage: count("growthStage"),
    // Stage advancement needs approved stage criteria (interim limitation L4).
    stageAdvancements: null,
    criteriaVersion: growthCriteria.GROWTH_CRITERIA_VERSION,
  };
  return result;
}

function currentEvidence(row = {}, { requireLocation = false } = {}) {
  const current = (row.evidenceHistory || []).filter(evidence =>
    Number(evidence?.revision) === Number(row.assessmentRevision || 0) && Boolean(evidence?.privateEvidence));
  if (!requireLocation) return current.length > 0;
  // First visit (baseline registration): the latest current evidence must carry an evidence reference and GPS,
  // matching what the baseline is built from on approval.
  const latest = current.at(-1), location = latest?.location || {};
  const coordinate = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  return Boolean(latest && (latest.evidenceId || latest.captureSessionId) && coordinate(location.latitude) && coordinate(location.longitude));
}

function inheritedDeadIsValid(row, priorVisit) {
  const source = row?.inheritedConfirmedDead;
  if (!source || row.condition !== "Dead" || priorVisit?.status !== "APPROVED") return false;
  const prior = (priorVisit.sampleAssessments || []).find(entry => entry.sampleId === row.sampleId);
  if (!prior || prior.condition !== "Dead") return false;
  // The approved prior visit itself carried this death forward from the same original source (already validated there).
  if (prior.inheritedConfirmedDead) return isDeepStrictEqual(prior.inheritedConfirmedDead, source);
  return source.visitId === priorVisit.id && Number(source.assessmentRevision) === Number(prior.assessmentRevision || 0) && currentEvidence(prior);
}

// Save Tree Assessment (spec section 17): the one saved tree is checked like a submission, including its evidence.
// While a visit is returned, the photo reviewed with that submission still belongs to the tree until its assessment changes.
function assertTreeAssessment(sampleId, { input, row, samples, locked, requireLocation, returned, priorRow }) {
  const code = (status, name, message) => Object.assign(new Error(message), { status, code: name, sampleId });
  if (!samples.some(sample => sample.permanentId === sampleId)) throw code(400, "INVALID_TREE_ASSESSMENT", "Select a Tree ID of this monitoring visit.");
  if (locked) throw code(409, "CONFIRMED_DEAD_LOCKED", `Tree ${sampleId} is a confirmed death carried forward and cannot be edited.`);
  if (!row?.condition) throw code(400, "TREE_CONDITION_REQUIRED", `Select the condition of ${sampleId}.`);
  try { normalize([input], [{ permanentId: sampleId }], { strict: true }); }
  catch (error) { throw Object.assign(error, { status: error.status || 400, sampleId }); }
  const hasEvidence = currentEvidence(row, { requireLocation }) || returned && currentEvidence(priorRow, { requireLocation });
  if (!hasEvidence) throw Object.assign(code(409, "CURRENT_SAMPLE_EVIDENCE_REQUIRED", `Take and verify the photo of ${sampleId} before saving its assessment. Use Save Draft to keep incomplete entries.`), { missingSampleIds: [sampleId] });
}

function assertCurrentEvidence(rows, priorVisit, { requireLocation = false } = {}) {
  const missing = rows.filter(row => !currentEvidence(row, { requireLocation }) && (requireLocation || !inheritedDeadIsValid(row, priorVisit))).map(row => row.sampleId);
  if (missing.length) throw Object.assign(conflict(requireLocation
    ? "Current verified evidence with GPS is required for every permanent sample in the first monitoring visit."
    : "Current verified evidence is required for every permanent sample before submission."), {
    code: "CURRENT_SAMPLE_EVIDENCE_REQUIRED", missingSampleIds: missing,
  });
}

const LIVING = new Set(["Healthy", "Damaged"]);
const dayNumber = date => schedulePolicy.validDateOnly(date) ? Date.parse(`${date}T00:00:00Z`) / 86400000 : null;
// Spec section 16 (policy-versioned and first visits only). Read-only, never changes the Staff condition.
// Visit 1 is the baseline. Later visits compare with the latest eligible approved measurement of the same
// Tree ID (priorMeasurements), in cm for height and mm for stem diameter. Labels come from the B1 criteria layer.
function withGrowth(row, priorVisit, { strict = false, baselineOnly = false, priorMeasurements = null, currentDate = null } = {}) {
  const prior = (priorVisit?.sampleAssessments || []).find(entry => entry.sampleId === row.sampleId);
  const delta = (current, previous) => Number.isFinite(current) && Number.isFinite(previous)
    ? Number((current - previous).toFixed(3)) : null;
  const legacy = { ...row, growthDelta: {
    heightCentimeters: delta(row.heightCentimeters, prior?.heightCentimeters),
    diameterCentimeters: delta(row.diameterCentimeters, prior?.diameterCentimeters),
  } };
  if (!strict) return legacy;
  const { NOT_APPLICABLE } = growthCriteria.GROWTH_LABELS;
  const living = LIVING.has(row.condition);
  const growthStage = living ? growthCriteria.getGrowthStage() : NOT_APPLICABLE;
  if (baselineOnly) {
    return { ...legacy, baselineOnly: true, heightDifferenceCm: null, stemDiameterDifferenceMm: null, measurementDecreased: false,
      previousMeasurement: null, growthPerformance: NOT_APPLICABLE, growthStage };
  }
  const previous = living ? priorMeasurements?.get(row.sampleId) || null : null;
  const difference = (current, before) => Number.isFinite(current) && Number.isFinite(before) ? Number((current - before).toFixed(4)) : null;
  const heightDifferenceCm = difference(row.heightCentimeters, previous?.heightCentimeters);
  const stemDiameterDifferenceMm = difference(validation.cmToMm(row.diameterCentimeters), validation.cmToMm(previous?.diameterCentimeters));
  const from = dayNumber(previous?.date), to = dayNumber(row.assessedOn || currentDate);
  const elapsedDays = from !== null && to !== null ? to - from : null;
  return { ...legacy, baselineOnly: false, heightDifferenceCm, stemDiameterDifferenceMm,
    // Non-blocking: Staff are asked to re-measure or explain; the condition is never changed.
    measurementDecreased: heightDifferenceCm < 0 || stemDiameterDifferenceMm < 0,
    previousMeasurement: previous ? { visitId: previous.visitId, assessedOn: previous.date, heightCentimeters: previous.heightCentimeters,
      stemDiameterMillimeters: validation.cmToMm(previous.diameterCentimeters) } : null,
    growthPerformance: living ? growthCriteria.evaluateGrowthPerformance({ heightDifferenceCm, stemDiameterDifferenceMm, elapsedDays }) : NOT_APPLICABLE,
    growthStage };
}
// The latest eligible approved measurement per Tree ID: walks the approved prior-visit chain of the same cohort and
// site (newest first) and keeps, per tree, the first Healthy/Damaged assessment that has a measurement.
async function priorMeasurements(read, cur, priorVisit) {
  const result = new Map(), seen = new Set();
  let visit = priorVisit, visitId = cur.priorVisitId;
  while (visit && visitId && !seen.has(visitId) && seen.size < 200) {
    seen.add(visitId);
    for (const row of visit.sampleAssessments || []) {
      if (result.has(row.sampleId) || !LIVING.has(row.condition)) continue;
      if (!Number.isFinite(row.heightCentimeters) && !Number.isFinite(row.diameterCentimeters)) continue;
      result.set(row.sampleId, { visitId, date: row.assessedOn || visit.dateMonitored || null,
        heightCentimeters: row.heightCentimeters ?? null, diameterCentimeters: row.diameterCentimeters ?? null });
    }
    const nextId = visit.priorVisitId;
    if (!nextId) break;
    const snapshot = await read(nextId), next = snapshot.exists ? snapshot.data() : null;
    visit = next?.status === "APPROVED" && next.cohortId === cur.cohortId && next.siteId === cur.siteId ? next : null;
    visitId = nextId;
  }
  return result;
}
const invalidCode = (message, code) => Object.assign(validation.invalid(message), { code });
// Diameter at the API boundary: stemDiameterMillimeters (spec unit) or diameterCentimeters (existing clients).
function diameterInput(a) {
  const centimeters = validation.measurement(a?.diameterCentimeters);
  const millimeters = validation.measurement(a?.stemDiameterMillimeters);
  if (millimeters === null) return centimeters;
  const converted = validation.mmToCm(millimeters);
  if (centimeters !== null && Number(centimeters.toFixed(6)) !== converted) {
    throw invalidCode("stemDiameterMillimeters and diameterCentimeters disagree.", "DIAMETER_UNIT_CONFLICT");
  }
  return converted;
}
// Condition-dependent rules for policy-versioned and first visits (spec sections 13-15). Values that are present
// must always be valid; required fields are enforced on submission so drafts can stay incomplete.
// Dead and Needs Rechecking need no measurements; any supplied are ignored (stored as null).
function strictFields(a, base, { draft }) {
  const condition = base.condition;
  let { heightCentimeters, diameterCentimeters } = base;
  if (condition === "Dead" || condition === "Needs Rechecking") heightCentimeters = diameterCentimeters = null;
  for (const value of [heightCentimeters, diameterCentimeters]) {
    if (value !== null && !(value > 0)) throw invalidCode("Height and stem diameter must be greater than zero.", "INVALID_MEASUREMENT");
  }
  if (!draft && LIVING.has(condition) && (heightCentimeters === null || diameterCentimeters === null)) {
    throw invalidCode("Healthy and Damaged trees require height (cm) and stem diameter (mm).", "MEASUREMENTS_REQUIRED");
  }
  const cause = typeof a?.mortalityCause === "string" ? a.mortalityCause.trim() : "";
  if (a?.mortalityCause != null && typeof a.mortalityCause !== "string" || cause && !MORTALITY_CAUSES.includes(cause)) {
    throw invalidCode("Cause of Mortality must be one of the configured causes.", "INVALID_MORTALITY_CAUSE");
  }
  if (!draft && condition === "Dead" && (!cause || !base.remarks)) {
    throw invalidCode("Dead requires a Cause of Mortality and remarks.", "MORTALITY_DETAILS_REQUIRED");
  }
  return { ...base, heightCentimeters, diameterCentimeters,
    mortalityCause: condition === "Dead" && cause ? cause : null,
    recheckReason: recheckReasonFor(a, condition, { draft }) };
}
// Spec section 15: the Reason for Rechecking applies to every permanent-sample visit (strict and legacy).
// It is bounded text, kept only on Needs Rechecking rows, optional on a draft save and required at submission.
function recheckReasonFor(a, condition, { draft }) {
  if (a?.recheckReason != null && typeof a.recheckReason !== "string") throw validation.invalid("Reason for Rechecking must be text.");
  const recheckReason = String(a?.recheckReason || "").trim().slice(0, 1000);
  if (!draft && condition === "Needs Rechecking" && !recheckReason) {
    throw invalidCode("Needs Rechecking requires a Reason for Rechecking.", "RECHECK_REASON_REQUIRED");
  }
  return condition === "Needs Rechecking" && recheckReason ? recheckReason : null;
}
function normalize(items, samples, { draft = false, strict = false, lockedIds = new Set() } = {}) {
  if (!Array.isArray(items) || items.length !== samples.length) throw new Error("Every approved sample requires an assessment.");
  const allowed = new Set(samples.map(s => s.permanentId));
  const seen = new Set();
  return items.map(a => {
    const sampleId = String(a?.sampleId || "");
    if (!allowed.has(sampleId) || seen.has(sampleId) || !(CONDITIONS.has(a?.condition) || draft && (a?.condition == null || a.condition === ""))) throw new Error("Assessment does not match an approved sample.");
    seen.add(sampleId);
    const remarks = String(a?.remarks || "").trim().slice(0, 1000),
      outcome = String(a?.investigationOutcome || "").trim();
    if (!draft && a.condition === "Needs Rechecking" && !remarks) throw validation.invalid("Needs Rechecking requires remarks.");
    if (outcome && !INVESTIGATION_OUTCOMES.has(outcome)) throw new Error("Invalid investigation outcome.");
    if (outcome && a.condition !== "Needs Rechecking") throw new Error("An investigation outcome requires Needs Rechecking.");
    if (a?.searchFindings != null && typeof a.searchFindings !== "string") throw validation.invalid("Search findings must be text.");
    const searchFindings = String(a?.searchFindings || "").trim().slice(0, 1000);
    if (!draft && outcome && !searchFindings) throw new Error("Not Located After Rechecking requires documented search findings.");
    const base = {
      sampleId,
      condition: a.condition || null,
      remarks,
      heightCentimeters: validation.measurement(a.heightCentimeters),
      diameterCentimeters: diameterInput(a),
      investigationOutcome: outcome || null,
      // Search and field findings belong to the unresolved tree, with or without a recorded outcome.
      searchFindings: a.condition === "Needs Rechecking" && searchFindings ? searchFindings : null,
      recheckQueued: a.condition === "Needs Rechecking" && !outcome
    };
    // Legacy visits keep their measurement rules but store the spec section 15 Reason for Rechecking.
    if (!strict) return { ...base, recheckReason: recheckReasonFor(a, base.condition, { draft }) };
    // Carried-forward confirmed deaths are locked rows, checked and kept by save().
    return lockedIds.has(sampleId) ? base : strictFields(a, base, { draft });
  });
}
// Spec section 14: a carried-forward confirmed death cannot be edited by Staff. The client may echo it back
// (condition Dead, same cause/remarks) but cannot change its condition, cause, remarks or measurements.
function assertInheritedDeadUnchanged(input, stored) {
  const supplied = value => value !== undefined && value !== null && !(typeof value === "string" && !value.trim());
  const changed = input?.condition !== "Dead" ||
    supplied(input.mortalityCause) && String(input.mortalityCause).trim() !== String(stored.mortalityCause || "") ||
    input.remarks !== undefined && input.remarks !== null && String(input.remarks).trim() !== String(stored.remarks || "") ||
    ["heightCentimeters", "diameterCentimeters", "stemDiameterMillimeters", "recheckReason", "investigationOutcome", "assessedOn"].some(key => supplied(input[key]));
  if (changed) {
    throw Object.assign(conflict(`Tree ${stored.sampleId} is a confirmed death carried forward and cannot be edited.`), {
      code: "CONFIRMED_DEAD_LOCKED", sampleId: stored.sampleId });
  }
}
// Manila calendar date of the evidence capture: the original photo's capture time, else the link time of the
// verified capture session (sessions are linked immediately after capture).
function evidenceDate(entry) {
  for (const value of [entry?.capturedAt, entry?.linkedAt]) {
    if (!value) continue;
    const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
    if (!Number.isNaN(date.getTime())) return schedulePolicy.dateOnlyInManila(date);
  }
  return null;
}
function latestCurrentEvidence(row) {
  return (row.evidenceHistory || []).filter(evidence =>
    Number(evidence?.revision) === Number(row.assessmentRevision || 0) && Boolean(evidence?.privateEvidence)).at(-1) || null;
}
// Spec section 18: per-tree assessment date (YYYY-MM-DD, Asia/Manila). Evidence wins; otherwise the client value;
// otherwise the stored value. It is never copied from the visit-level Date Monitored.
function assessedOnFor(row, input, stored, { openingDate, today }) {
  const fromEvidence = evidenceDate(latestCurrentEvidence(row));
  let value = fromEvidence;
  if (!value && input?.assessedOn !== undefined && input.assessedOn !== null && input.assessedOn !== "") value = input.assessedOn;
  if (!value) value = stored?.assessedOn || null;
  if (value === null) return null;
  if (!schedulePolicy.validDateOnly(value) || value > today || (openingDate && value < openingDate)) {
    throw Object.assign(invalidCode(`The assessment date for ${row.sampleId} must be a valid date from ${openingDate || "the opening date"} to today.`,
      "INVALID_ASSESSED_ON"), { sampleId: row.sampleId });
  }
  return value;
}
// --- First monitoring visit = baseline registration (PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED) ---
// A cohort is in first-visit mode when it has neither a sampling plan nor a baseline, or when its
// first-visit plan exists but visit 1 (the baseline) is not yet approved.
const firstVisitPending = cohort => Boolean(cohort) && ((!cohort.samplingPlan && !cohort.baseline) ||
  (cohort.samplingPlan?.origin === "FIRST_VISIT" && cohort.baseline?.approvalStatus !== "APPROVED"));
// Once Admin approves a first-visit baseline, later visits must keep using that same
// feature-gated policy lineage. The legacy purpose-policy snapshot remains pending by
// design and must not make readiness disagree with create(), which already accepts the
// approved FIRST_VISIT plan through usesRejectedProvisionalPolicy().
const usesAuthorizedFirstVisitPolicy = cohort => Boolean(cohort) &&
  firstVisitConfig.firstVisitBaselineEnabled() &&
  cohort.samplingPlan?.origin === "FIRST_VISIT" &&
  cohort.samplingPlan?.provisionalPolicy === firstVisitConfig.FIRST_VISIT_BASELINE_POLICY_ID;
// Report eligibility (spec section 3), re-derived from the authoritative report and site documents with the
// same quantity rule used when the cohort was created. Returns the failed checks (empty when eligible).
function reportEligibilityProblems(cohort, reportSnap, siteSnap) {
  const source = cohort?.source || {}, problems = [];
  const report = reportSnap?.exists ? reportSnap.data() || {} : null;
  if (!report) return ["REPORT_NOT_FOUND"];
  const quantity = authoritativeQuantity(report);
  if (!quantity) problems.push("REPORT_NOT_VERIFIED");
  else if (quantity !== Number(cohort?.verifiedPlantedQuantity)) problems.push("VERIFIED_QUANTITY_CHANGED");
  // The rule flag is read only for cohorts that recorded it, so every later step follows the same decision as the start.
  const policy = firstVisitPolicy(report, { verifiedReportRule: cohort?.eligibilityAuthorization?.policyId === VERIFIED_REPORT_POLICY_ID && verifiedReportFirstVisitEnabled() });
  if (!policy.allowed) problems.push(policy.code);
  if (cohort?.eligibilityAuthorization && report.archived === true) problems.push("REPORT_ARCHIVED");
  if (!source.siteId || !siteSnap?.exists || String(siteSnap.data()?.status || "").toLowerCase() === "inactive") problems.push("SITE_UNAVAILABLE");
  else if (report.siteId && String(report.siteId) !== source.siteId) problems.push("SITE_MISMATCH");
  return problems;
}
// Transaction read of the cohort's planting report and site, then the same eligibility rule as create.
async function firstVisitEligibilityInTransaction(tx, cohort) {
  const source = cohort?.source || {};
  const reportSnap = source.plantingReportId ? await tx.get(db.collection("plantingReports").doc(source.plantingReportId)) : null;
  const siteSnap = source.siteId ? await tx.get(db.collection("sites").doc(source.siteId)) : null;
  return reportEligibilityProblems(cohort, reportSnap, siteSnap);
}
const reportNotEligible = problems => Object.assign(conflict("This planting report is not eligible for permanent-sample monitoring."), {
  code: "REPORT_NOT_ELIGIBLE", problems });
const firstVisitAssessments = samples => samples.map(sample => ({
  sampleId: sample.permanentId, condition: null, remarks: "", assessmentRevision: 0, evidenceHistory: [],
  baselineReference: { sampleId: sample.permanentId }, recheckRequired: false, previousAssessmentReference: null,
}));
async function createFirstVisit({ cohortId, actorId, visitDate, scheduledMode, activeSchedule }) {
  const today = schedulePolicy.dateOnlyInManila();
  if (!schedulePolicy.validDateOnly(visitDate)) throw validation.invalid("visitDate must be a valid calendar date.");
  // Visit 1 has no fixed due date: any eligible, non-future date.
  if (visitDate > today) throw Object.assign(conflict("The first visit date cannot be in the future."), { code: "VISIT_NOT_OPEN" });
  const visitId = id(cohortId, visitDate),
    ref = visitRef(visitId),
    cohortRef = db.collection("verifiedPlantingCohorts").doc(cohortId);
  await db.runTransaction(async tx => {
    // All reads first. The cohort, report and site are re-read here; the pre-transaction read only chose the mode.
    const old = await tx.get(ref);
    const cohortSnap = await tx.get(cohortRef);
    const cohortVisits = await tx.get(db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortId));
    const c = cohortSnap.exists ? cohortSnap.data() : null, source = c?.source || {};
    const reportSnap = source.plantingReportId ? await tx.get(db.collection("plantingReports").doc(source.plantingReportId)) : null;
    const siteSnap = source.siteId ? await tx.get(db.collection("sites").doc(source.siteId)) : null;
    release.writeScope(actorId, cohortId);
    if (old.exists) {
      if (old.data().createdBy !== actorId) throw Object.assign(conflict(
        "This cohort already has an open monitoring visit. Finish and have it reviewed before another visit is started."
      ), { code: "OPEN_VISIT_EXISTS" });
      return;
    }
    if (cohortVisits.docs.some(doc => doc.id !== visitId && OPEN_VISIT_STATUSES.has(doc.data().status))) {
      throw Object.assign(conflict("This cohort already has an open monitoring visit. Finish and have it reviewed before another visit is started."), { code: "OPEN_VISIT_EXISTS" });
    }
    if (!c) throw Object.assign(new Error("Verified planting cohort not found."), { status: 404 });
    const problems = reportEligibilityProblems(c, reportSnap, siteSnap);
    if (problems.length) throw reportNotEligible(problems);
    if (schedulePolicy.validDateOnly(source.plantingDate) && visitDate < source.plantingDate) {
      throw Object.assign(conflict(`Permanent-sample monitoring is not eligible before ${source.plantingDate}.`), { code: "VISIT_BEFORE_ELIGIBILITY" });
    }
    const now = Timestamp.now();
    // Throws FIRST_VISIT_BASELINE_NOT_APPLICABLE when a plan or baseline appeared since the mode was chosen,
    // and SPECIES_ALLOCATION_PENDING / VERIFIED_QUANTITY_UNAVAILABLE for the interim limits.
    const { samplingPlan, historyEntry } = cohortHelpers().prepareFirstVisitPlan({ cohort: { id: cohortId, ...c },
      reportNumber: reportSnap.data().reportNumber, cohortId, actorId, now });
    tx.update(cohortRef, {
      samplingPlan,
      samplingPlanHistory: [...(Array.isArray(c.samplingPlanHistory) ? c.samplingPlanHistory : []), historyEntry],
      monitoringVisitCreation: { lastVisitId: visitId, lastCreatedAt: now },
      updatedAt: now,
    });
    tx.create(ref, {
      schemaVersion: 1,
      cohortId,
      siteId: source.siteId,
      registersBaseline: true,
      samplingPlanVersion: samplingPlan.version,
      baselineVersion: Number(c.baselineVersion || 0) + 1,
      visitDate,
      visitNumber: 1,
      scheduledDueDate: visitDate,
      // Visit 1 has no fixed date: the field assessment may be any day from planting to today.
      openingDate: schedulePolicy.validDateOnly(source.plantingDate) ? source.plantingDate : visitDate,
      scheduleStatus: schedulePolicy.scheduleStatus(visitDate, today),
      ...(scheduledMode ? { schedulePolicyVersion: activeSchedule.policyVersion, schedulePolicySnapshot: activeSchedule } : {}),
      status: "DRAFT",
      version: 0,
      createdBy: actorId,
      priorVisitId: null,
      sampleAssessments: firstVisitAssessments(samplingPlan.selectedSamples),
      history: [],
      createdAt: now,
    });
  });
  // Only reached from create() after assertStaffWriter: the authenticated Staff actor views the response.
  return get(visitId, { actorId, actorRole: "staff" });
}
async function create({
  cohortId,
  actorId,
  visitDate,
  actorRole,
  testOnly = false
}) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabled();
  assertStaffWriter(actorRole);
  release.writeScope(actorId, cohortId);
  const activeSchedule = schedulePolicy.resolvePermanentSampleSchedule();
  if (!testOnly && !activeSchedule.enabled) throw conflict("Future visit scheduling requires MENRO policy approval.");
  const snap = await db.collection("verifiedPlantingCohorts").doc(cohortId).get(),
    c = snap.data(),
    plan = c?.samplingPlan,
    units = c?.baseline?.sampleUnits;
  // The flag is read only for cohorts that could use the first-visit baseline; legacy cohorts never read it.
  if (snap.exists && firstVisitPending(c) && firstVisitConfig.firstVisitBaselineEnabled()) {
    return createFirstVisit({ cohortId, actorId, visitDate, scheduledMode: !testOnly && activeSchedule.enabled, activeSchedule });
  }
  if (!snap.exists || plan?.status !== "APPROVED" || c?.baseline?.approvalStatus !== "APPROVED" || !Array.isArray(units) || !units.length) throw conflict("Approved cohort, plan, and baseline are required.");
  if (usesRejectedProvisionalPolicy(c)) throw Object.assign(conflict("This cohort's sampling plan uses the test-only provisional rule. A MENRO-approved sampling policy is required."), { code: "TEST_ONLY_SAMPLING_POLICY_REJECTED" });
  const today = schedulePolicy.dateOnlyInManila();
  if (!schedulePolicy.validDateOnly(visitDate)) throw validation.invalid("visitDate must be a valid calendar date.");
  const baselineVersion = Number(c.baselineVersion || 0);
  const approvedSnapshot = await db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortId).where("status", "==", "APPROVED").get();
  const approved = approvedSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(row => row.siteId === c.source.siteId && Number(row.samplingPlanVersion) === Number(plan.version) && Number(row.baselineVersion) === baselineVersion)
    .sort((a, b) => Number(a.visitNumber || 0) - Number(b.visitNumber || 0) || String(a.scheduledDueDate || a.visitDate).localeCompare(String(b.scheduledDueDate || b.visitDate)));
  const scheduledMode = !testOnly && activeSchedule.enabled;
  const prior = scheduledMode ? approved.at(-1) || null : await priorApprovedVisit(cohortId, c.source.siteId, plan.version, baselineVersion, visitDate);
  const visitNumber = scheduledMode ? approved.length + 1 : Number(prior?.visitNumber || approved.length) + 1;
  const scheduledDueDate = scheduledMode && prior ? schedulePolicy.scheduleAfterApproval(prior) : visitDate;
  const eligibleFrom = schedulePolicy.validDateOnly(c.source?.plantingDate) ? c.source.plantingDate : null;
  if (scheduledMode && eligibleFrom && scheduledDueDate < eligibleFrom) {
    throw Object.assign(conflict(`Permanent-sample monitoring is not eligible before ${eligibleFrom}.`), { code: "VISIT_BEFORE_ELIGIBILITY" });
  }
  if (scheduledMode && visitDate !== scheduledDueDate) throw Object.assign(conflict(`Visit ${visitNumber} is scheduled for ${scheduledDueDate}.`), { code: "VISIT_SCHEDULE_MISMATCH" });
  if (scheduledMode && scheduledDueDate > today) throw Object.assign(conflict(`Visit ${visitNumber} opens on ${scheduledDueDate}.`), { code: "VISIT_NOT_OPEN" });
  if (scheduledMode && !prior && visitDate > today) throw Object.assign(conflict("The first visit date cannot be in the future."), { code: "VISIT_NOT_OPEN" });
  const unresolved = new Map((prior?.sampleAssessments || []).filter(a => a.recheckQueued || a.condition === "Needs Rechecking").map(a => [a.sampleId, a]));
  // A death recorded with current evidence, or one the approved prior visit already carried forward, keeps being carried.
  const confirmedDead = new Map((prior?.sampleAssessments || []).filter(a => a.condition === "Dead" && (currentEvidence(a) || a.inheritedConfirmedDead)).map(a => [a.sampleId, a]));
  // Visit IDs come from the cohort and date. Visit 1 keeps the ID of the day it was started, which can equal a later due date.
  const dateId = id(cohortId, scheduledDueDate),
    visitId = approved.some(visit => visit.id === dateId) ? id(cohortId, `${scheduledDueDate}#${visitNumber}`) : dateId,
    ref = visitRef(visitId),
    cohortRef = db.collection("verifiedPlantingCohorts").doc(cohortId);
  await db.runTransaction(async tx => {
    // T4: the cohort document is read and written in the same transaction, so concurrent creations for
    // one cohort serialize; the retried transaction then sees the other visit and is refused.
    const old = await tx.get(ref);
    await tx.get(cohortRef);
    const cohortVisits = await tx.get(db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortId));
    release.writeScope(actorId, cohortId);
    if (old.exists) {
      if (old.data().createdBy !== actorId) throw Object.assign(conflict(
        "This cohort already has an open monitoring visit. Finish and have it reviewed before another visit is started."
      ), { code: "OPEN_VISIT_EXISTS" });
      return;
    }
    if (cohortVisits.docs.some(doc => doc.id !== visitId && OPEN_VISIT_STATUSES.has(doc.data().status))) {
      throw Object.assign(conflict("This cohort already has an open monitoring visit. Finish and have it reviewed before another visit is started."), { code: "OPEN_VISIT_EXISTS" });
    }
    tx.update(cohortRef, { monitoringVisitCreation: { lastVisitId: visitId, lastCreatedAt: Timestamp.now() } });
    tx.create(ref, {
      schemaVersion: 1,
      cohortId,
      siteId: c.source.siteId,
      samplingPlanVersion: plan.version,
      baselineVersion,
      visitDate: scheduledDueDate,
      visitNumber,
      scheduledDueDate,
      openingDate: scheduledDueDate,
      scheduleStatus: schedulePolicy.scheduleStatus(scheduledDueDate, today),
      ...(scheduledMode ? { schedulePolicyVersion: activeSchedule.policyVersion,
        schedulePolicySnapshot: activeSchedule } : {}),
      status: "DRAFT",
      version: 0,
      createdBy: actorId,
      priorVisitId: prior?.id || null,
      sampleAssessments: units.map(u => {
        const previous = unresolved.get(u.permanentId);
        const dead = confirmedDead.get(u.permanentId);
        return {
          sampleId: u.permanentId,
          condition: dead ? "Dead" : null,
          remarks: dead ? String(dead.remarks || "") : "",
          assessmentRevision: 0,
          evidenceHistory: [],
          // Always the ORIGINAL death record (visit and revision), however many visits it has been carried through.
          ...(dead ? { inheritedConfirmedDead: dead.inheritedConfirmedDead ? { ...dead.inheritedConfirmedDead } : { visitId: prior.id,
            assessmentRevision: Number(dead.assessmentRevision || 0) } } : {}),
          // The recorded Cause of Mortality travels with the carried-forward death (set only when it was recorded).
          ...(dead?.mortalityCause ? { mortalityCause: dead.mortalityCause } : {}),
          baselineReference: {
            sampleId: u.permanentId
          },
          recheckRequired: Boolean(previous),
          previousAssessmentReference: previous ? {
            visitId: prior.id,
            sampleId: previous.sampleId,
            condition: previous.condition,
            remarks: previous.remarks || "",
            investigationOutcome: previous.investigationOutcome || null
          } : null
        };
      }),
      history: [],
      createdAt: Timestamp.now()
    });
  });
  return get(visitId, { actorId, actorRole });
}
async function get(visitId, { actorId, actorRole } = {}) {
  const s = await visitRef(visitId).get();
  if (!s.exists) throw Object.assign(new Error("Monitoring visit not found."), {
    status: 404
  });
  const value = s.data();
  if (actorRole && !['staff', 'admin'].includes(actorRole)) throw Object.assign(new Error('Monitoring visit not found.'), { status: 404 });
  if (actorRole === 'staff' && value.createdBy !== actorId) throw Object.assign(new Error('Monitoring visit not found.'), { status: 404 });
  if (actorRole) release.assertScope(actorId, value.cohortId);
  return {
    id: s.id,
    ...value,
    // Read-time API unit: stem diameter in mm derived from the stored cm value (history is never rewritten).
    ...(Array.isArray(value.sampleAssessments) ? { sampleAssessments: value.sampleAssessments.map(row => row && typeof row === "object"
      ? { ...row, stemDiameterMillimeters: validation.cmToMm(row.diameterCentimeters) } : row) } : {}),
    writesPaused: release.resolve().paused,
    visitContext: await require("./sampleMonitoringViewContext").monitoringContext(db, value, { actorId, actorRole }),
  };
}
async function list({ actorId, actorRole, status, limit = 25, cursor = "", labels = false }) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabled();
  if (!['staff', 'admin'].includes(actorRole)) throw Object.assign(new Error('Monitoring visits are restricted to MENRO Staff and Admin.'), { status: 403 });
  const policy = release.assertUser(actorId);
  const size = Math.max(1, Math.min(Number(limit) || 25, 50));
  let query = db.collection('sampleMonitoringVisits');
  if (actorRole === 'staff') query = query.where('createdBy', '==', actorId);
  query = release.scopeQuery(query, policy);
  if (status) query = query.where('status', '==', String(status));
  query = query.orderBy('visitDate', 'desc').orderBy('__name__').limit(size + 1);
  if (cursor) {
    const cursorDoc = await db.collection('sampleMonitoringVisits').doc(String(cursor)).get();
    if (!cursorDoc.exists || !release.allowsCohort(cursorDoc.data().cohortId, policy) || (actorRole === 'staff' && cursorDoc.data().createdBy !== actorId)) throw Object.assign(new Error('Invalid monitoring visit cursor.'), { status: 400 });
    query = query.startAfter(cursorDoc);
  }
  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, size);
  // Admin Monitoring Records rows only (requested with labels=1), and only for submitted (non-draft) visits:
  // resolve each distinct Staff submitter's display name and each distinct cohort/site pair's report number
  // and site once per page, with the same site rule as the visit form context. Only display names are
  // returned — never uids, emails or other profile fields. A failed lookup is logged and leaves that label
  // null (labelsIncomplete), never a guessed name or site.
  const viewContext = require('./sampleMonitoringViewContext');
  const submitterNames = new Map(), cohortLabels = new Map();
  let labelsIncomplete = false;
  const labelRows = actorRole === 'admin' && labels ? pageDocs.filter(doc => doc.data().status !== 'DRAFT') : [];
  const labelKey = value => `${value.cohortId}|${value.siteId}`;
  const readDoc = async (collection, id) => {
    if (typeof id !== 'string' || !id) return {};
    try { const snap = await db.collection(collection).doc(id).get(); return snap.exists ? snap.data() || {} : {}; }
    catch (error) {
      labelsIncomplete = true;
      console.warn(`[sample-monitoring] Admin list label lookup failed (${collection}): ${error.code || error.message}`);
      return null;
    }
  };
  const submitters = [...new Set(labelRows.map(doc => doc.data().createdBy).filter(id => typeof id === 'string' && id))];
  const pairs = [...new Map(labelRows.map(doc => doc.data()).filter(value => typeof value.cohortId === 'string' && value.cohortId && typeof value.siteId === 'string' && value.siteId)
    .map(value => [labelKey(value), value])).values()];
  await Promise.all([
    ...submitters.map(async id => {
      const user = await readDoc('users', id);
      submitterNames.set(id, user ? String(user.fullName || user.name || '').trim() || 'MENRO Staff' : null);
    }),
    ...pairs.map(async value => {
      const cohort = await readDoc('verifiedPlantingCohorts', value.cohortId);
      if (!cohort || !viewContext.cohortMatchesVisit(cohort, value)) return;
      const [site, report] = await Promise.all([readDoc('sites', value.siteId), readDoc('plantingReports', (cohort.source || {}).plantingReportId)]);
      if (!site || !report) return;
      cohortLabels.set(labelKey(value), viewContext.contextLabels(site, report));
    }),
  ]);
  const visits = pageDocs.map(doc => {
    const value = doc.data(); const assessments = value.sampleAssessments || [];
    const completed = assessments.filter(item => item.condition).length;
    const editable = !policy.paused && actorRole === 'staff' && value.createdBy === actorId && ['DRAFT', 'RETURNED'].includes(value.status);
    return { id: doc.id, cohortId: value.cohortId, siteId: value.siteId, visitDate: value.visitDate, status: value.status,
      visitNumber: value.visitNumber || null, scheduledDueDate: value.scheduledDueDate || value.visitDate || null,
      openingDate: value.openingDate || value.scheduledDueDate || value.visitDate || null,
      scheduleStatus: value.scheduleStatus || null, nextScheduledDueDate: value.nextScheduledDueDate || null,
      version: value.version, samplingPlanVersion: value.samplingPlanVersion, baselineVersion: value.baselineVersion,
      dateMonitored: typeof value.dateMonitored === 'string' ? value.dateMonitored : null,
      ...(labelRows.includes(doc) ? { submittedByName: submitterNames.has(value.createdBy) ? submitterNames.get(value.createdBy) : 'MENRO Staff',
        ...(cohortLabels.get(labelKey(value)) || { reportNumber: null, siteName: null, barangay: null }) } : {}),
      progress: { completed, total: assessments.length, rechecking: assessments.filter(item => item.recheckRequired || item.recheckQueued).length },
      actions: { view: true, saveDraft: editable, submit: editable, review: !policy.paused && actorRole === 'admin' && value.status === 'PENDING_ADMIN_APPROVAL' } };
  });
  return { visits, nextCursor: snapshot.docs.length > size ? snapshot.docs[size - 1].id : null, writesPaused: Boolean(policy.paused),
    ...(labelRows.length ? { labelsIncomplete } : {}) };
}
async function save({
  visitId,
  actorId,
  expectedVersion,
  assessments,
  submit = false,
  visitRemarks,
  overallRemarks,
  dateMonitored,
  assessedSampleId,
  actorRole
}) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabled();
  assertStaffWriter(actorRole);
  if (assessedSampleId !== undefined && (typeof assessedSampleId !== "string" || submit === true)) throw validation.invalid("assessedSampleId must name one Tree ID and is not used when submitting.");
  validation.version(expectedVersion);
  validation.boolean(submit, "submit");
  // Overall Visit Remarks (spec section 21): `overallRemarks`, with the existing `visitRemarks` as its alias.
  if (overallRemarks !== undefined) {
    if (typeof overallRemarks !== "string" || overallRemarks.trim().length > 1000) throw validation.invalid("Overall visit remarks must be at most 1000 characters.");
    if (visitRemarks !== undefined && (typeof visitRemarks !== "string" || visitRemarks.trim() !== overallRemarks.trim())) throw validation.invalid("overallRemarks and visitRemarks disagree.");
    visitRemarks = overallRemarks;
  }
  if (visitRemarks !== undefined && (typeof visitRemarks !== "string" || visitRemarks.trim().length > 1000)) throw validation.invalid("Visit remarks must be at most 1000 characters.");
  if (dateMonitored !== undefined) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (typeof dateMonitored !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateMonitored) || !Number.isFinite(Date.parse(dateMonitored)) || new Date(dateMonitored).toISOString().slice(0, 10) !== dateMonitored || dateMonitored > today) throw validation.invalid("Date Monitored must be a valid date and cannot be in the future.");
  }
  release.assertUser(actorId); release.assertWrite();
  const ref = visitRef(visitId);
  await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw Object.assign(new Error("Monitoring visit not found."), {
      status: 404
    });
    const cur = doc.data();
    release.assertScope(actorId, cur.cohortId);
    if (cur.createdBy !== actorId || !["DRAFT", "RETURNED"].includes(cur.status) || Number(cur.version) !== Number(expectedVersion)) throw conflict("This monitoring visit is no longer editable.");
    const cohortRef = db.collection("verifiedPlantingCohorts").doc(cur.cohortId);
    const cohort = (await tx.get(cohortRef)).data();
    validation.cohortBinding(cohort, cur);
    const samples = validation.samplesFor(cohort, cur);
    // Visit 1 registers the baseline: its plan moves with the visit, and evidence + GPS are always required.
    const firstVisit = validation.registersFirstVisitBaseline(cohort, cur);
    const priorVisit = await validation.historicalVisit(id => tx.get(visitRef(id)), cur);
    // Visit 1 submission re-checks report eligibility from the authoritative report and site (spec section 19).
    if (submit && firstVisit) {
      const problems = await firstVisitEligibilityInTransaction(tx, cohort);
      if (problems.length) throw reportNotEligible(problems);
    }
    const inputBySampleId = new Map((assessments || []).map(row => [row?.sampleId, row]));
    const priorBySampleId = new Map((cur.sampleAssessments || []).map(entry => [entry.sampleId, entry]));
    // B4 rules apply to policy-versioned and first visits; legacy test-only visits keep their behaviour.
    const strict = cur.schedulePolicyVersion === schedulePolicy.POLICY_VERSION || firstVisit || cur.registersBaseline === true;
    const lockedIds = new Set(strict ? (cur.sampleAssessments || []).filter(entry => entry.inheritedConfirmedDead).map(entry => entry.sampleId) : []);
    for (const sampleId of lockedIds) {
      if (inputBySampleId.has(sampleId)) assertInheritedDeadUnchanged(inputBySampleId.get(sampleId), priorBySampleId.get(sampleId));
    }
    const measured = strict && !firstVisit && cur.registersBaseline !== true
      ? await priorMeasurements(id => tx.get(visitRef(id)), cur, priorVisit) : null;
    const firstOpening = firstVisit && schedulePolicy.validDateOnly(cohort?.source?.plantingDate) ? cohort.source.plantingDate : null;
    const dateContext = { openingDate: firstOpening || cur.openingDate || cur.visitDate || null, today: schedulePolicy.dateOnlyInManila() };
    const growthOptions = { strict, baselineOnly: firstVisit || cur.registersBaseline === true, priorMeasurements: measured,
      currentDate: dateMonitored ?? cur.dateMonitored ?? null };
    const values = normalize(assessments, samples, { draft: !submit, strict, lockedIds }).map(entry => {
      const prior = priorBySampleId.get(entry.sampleId);
      const references = validation.references(inputBySampleId.get(entry.sampleId), entry.sampleId, priorVisit, cur.priorVisitId);
      // A locked carried-forward death keeps its stored row: original evidence reference, cause and remarks.
      if (lockedIds.has(entry.sampleId)) return withGrowth({ ...prior, ...references }, priorVisit, growthOptions);
      const comparable = value => value && ({ condition: value.condition, remarks: value.remarks || "", heightCentimeters: value.heightCentimeters ?? null, diameterCentimeters: value.diameterCentimeters ?? null, investigationOutcome: value.investigationOutcome || null, searchFindings: value.searchFindings || null, recheckQueued: Boolean(value.recheckQueued),
        ...(strict ? { mortalityCause: value.mortalityCause || null, recheckReason: value.recheckReason || null } : {}) });
      // A correction needs new evidence once per returned submission, however many times it is saved before resubmitting.
      const correctionRound = Number(cur.submissionRevision || 0);
      const correctedAfterReturn = cur.status === "RETURNED" && prior?.correctionRound !== correctionRound &&
        JSON.stringify(comparable(entry)) !== JSON.stringify(comparable(prior));
      const unchangedInheritedDead = JSON.stringify(comparable(entry)) === JSON.stringify(comparable(prior));
      const inheritedConfirmedDead = prior?.inheritedConfirmedDead && entry.condition === "Dead" && unchangedInheritedDead
        ? prior.inheritedConfirmedDead : null;
      const row = {
        ...entry,
        ...references,
        assessmentRevision: Number(prior?.assessmentRevision || 0) + (correctedAfterReturn ? 1 : 0),
        evidenceHistory: Array.isArray(prior?.evidenceHistory) ? prior.evidenceHistory : [],
        ...(correctedAfterReturn ? { correctionRound } : prior?.correctionRound !== undefined ? { correctionRound: prior.correctionRound } : {}),
        ...(inheritedConfirmedDead ? { inheritedConfirmedDead } : {})
      };
      if (strict) row.assessedOn = assessedOnFor(row, inputBySampleId.get(entry.sampleId), prior, dateContext);
      return withGrowth(row, priorVisit, growthOptions);
    });
    if (assessedSampleId !== undefined && strict) {
      assertTreeAssessment(assessedSampleId, { input: inputBySampleId.get(assessedSampleId), row: values.find(entry => entry.sampleId === assessedSampleId),
        samples, locked: lockedIds.has(assessedSampleId), requireLocation: firstVisit, returned: cur.status === "RETURNED", priorRow: priorBySampleId.get(assessedSampleId) });
    }
    if (submit && values.some(entry => !entry.condition)) throw conflict("Every approved sample requires an assessment before submission.");
    if (submit && (cur.schedulePolicyVersion === schedulePolicy.POLICY_VERSION || firstVisit)) {
      const actualDate = dateMonitored ?? cur.dateMonitored;
      if (!schedulePolicy.validDateOnly(actualDate)) throw validation.invalid("Date Monitored is required for submission.");
      if (!firstOpening && cur.schedulePolicyVersion === schedulePolicy.POLICY_VERSION && actualDate < cur.openingDate) throw Object.assign(conflict(`This visit cannot be submitted before ${cur.openingDate}.`), { code: "VISIT_NOT_OPEN" });
      if (firstVisit) {
        // Visit 1 is monitored on any day from the planting date to today (spec section 7), also in test mode.
        const plantingDate = cohort?.source?.plantingDate;
        if (schedulePolicy.validDateOnly(plantingDate) && actualDate < plantingDate) throw Object.assign(conflict(`Permanent-sample monitoring is not eligible before ${plantingDate}.`), { code: "VISIT_BEFORE_ELIGIBILITY" });
        if (!firstOpening && actualDate < cur.visitDate) throw Object.assign(conflict(`This visit cannot be submitted before ${cur.visitDate}.`), { code: "VISIT_NOT_OPEN" });
      }
      assertCurrentEvidence(values, priorVisit && { id: cur.priorVisitId, ...priorVisit }, { requireLocation: firstVisit });
    }
    if (submit) require("./sampleMonitoringOriginalEvidence").reviewRequirements({...cur, dateMonitored:dateMonitored ?? cur.dateMonitored, sampleAssessments:values});
    const version = Number(cur.version) + 1;
    // A returned visit stays Returned for Correction (with its reason) until it is resubmitted.
    const status = submit ? "PENDING_ADMIN_APPROVAL" : cur.status;
    const now = Timestamp.now();
    // Each submission gets the next revision so the client can reconcile an ambiguous submit outcome.
    const submissionRevision = submit ? Number(cur.submissionRevision || 0) + 1 : Number(cur.submissionRevision || 0);
    // Spec section 19: notify Admins through the existing notification infrastructure, one deterministic id per
    // visit, submission revision and Admin. Reads happen here, before any write; existing ids are never re-created.
    let adminNotifications = [];
    if (submit && strict) {
      const admins = await notificationService().getRoleRecipientsInTransaction(tx, ["admin"]);
      const planned = admins.map(admin => ({ recipientUserId: admin.id,
        notificationId: `sample_monitoring_visit_submitted_${visitId}_${submissionRevision}_${admin.id}` }));
      const existing = await Promise.all(planned.map(item => tx.get(db.collection("notifications").doc(item.notificationId))));
      adminNotifications = planned.filter((item, index) => !existing[index].exists);
    }
    // DRAFT or RETURNED -> PENDING_ADMIN_APPROVAL; the plan version and Tree IDs never change.
    const planSubmission = submit && firstVisit ? cohortHelpers().planReviewTransition({ samplingPlan: cohort.samplingPlan,
      samplingPlanHistory: cohort.samplingPlanHistory }, "PENDING_ADMIN_APPROVAL", actorId, now) : null;
    release.writeScope(actorId, cur.cohortId);
    if (planSubmission) tx.update(cohortRef, { ...planSubmission, updatedAt: now });
    tx.update(ref, {
      sampleAssessments: values,
      ...(visitRemarks !== undefined ? { visitRemarks: visitRemarks.trim(), ...(strict ? { overallRemarks: visitRemarks.trim() } : {}) } : {}),
      ...(dateMonitored !== undefined ? { dateMonitored } : {}),
      summary: summary(values),
      status,
      version,
      ...(submit ? { submissionRevision } : {}),
      recheckQueue: values.filter(entry => entry.recheckQueued).map(entry => entry.sampleId),
      officialKpiEligible: false,
      history: [...(cur.history || []), {
        version,
        status,
        visitNumber: cur.visitNumber || null,
        scheduledDueDate: cur.scheduledDueDate || cur.visitDate || null,
        openingDate: cur.openingDate || cur.scheduledDueDate || cur.visitDate || null,
        updatedBy: actorId,
        updatedAt: now,
        summary: summary(values),
        ...(dateMonitored !== undefined || cur.dateMonitored ? { dateMonitored: dateMonitored ?? cur.dateMonitored } : {}),
        visitRemarks: visitRemarks === undefined ? cur.visitRemarks || "" : visitRemarks.trim()
      }],
      updatedAt: now
    });
    const counts = summary(values);
    adminNotifications.forEach(item => notificationService().createNotificationInTransaction(tx, {
      ...item,
      type: "sample_monitoring_visit_submitted",
      title: "Monitoring Visit Submitted for Review",
      message: `Permanent-sample Monitoring Visit${cur.visitNumber ? ` #${cur.visitNumber}` : ""} was submitted by MENRO Staff and requires Admin review.`,
      relatedRecordType: "sampleMonitoringVisit",
      relatedRecordId: visitId,
      createdAt: now,
      details: { cohortId: cur.cohortId, visitNumber: cur.visitNumber || null, submissionRevision, version,
        summary: { total: counts.total, completed: counts.completed, needsRechecking: counts.needsRechecking, survivalStatus: counts.survivalStatus } },
    }));
  });
  return get(visitId, { actorId, actorRole });
}
async function review({
  visitId,
  actorId,
  expectedVersion,
  approve,
  reasons = "",
  originalEvidenceReviews
}) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabled();
  validation.version(expectedVersion);
  validation.boolean(approve, "approve");
  release.assertUser(actorId); release.assertWrite();
  if (typeof reasons !== "string" || reasons.trim().length > 1000 || !approve && !reasons.trim()) {
    throw validation.invalid("Return requires a nonblank reason (maximum 1000 characters).");
  }
  const ref = visitRef(visitId);
  await db.runTransaction(async tx => {
    const d = await tx.get(ref);
    if (!d.exists || d.data().status !== "PENDING_ADMIN_APPROVAL" || Number(d.data().version) !== Number(expectedVersion)) throw conflict("Monitoring visit is not ready for review.");
    const reviewCohortRef = db.collection("verifiedPlantingCohorts").doc(d.data().cohortId);
    const cohort = await tx.get(reviewCohortRef);
    release.assertScope(actorId, d.data().cohortId);
    validation.cohortBinding(cohort.data(), d.data());
    // Visit 1 registers the baseline: plan, baseline and visit are reviewed together in this transaction.
    const firstVisit = validation.registersFirstVisitBaseline(cohort.data(), d.data());
    let reviewedOriginals = [];
    if (approve) {
      reviewedOriginals = require("./sampleMonitoringOriginalEvidence").assertOriginalReview(d.data(), originalEvidenceReviews);
      normalize(d.data().sampleAssessments, validation.samplesFor(cohort.data(), d.data()));
      const prior = await validation.historicalVisit(id => tx.get(visitRef(id)), d.data());
      for (const row of d.data().sampleAssessments) validation.references(row, row.sampleId, prior, d.data().priorVisitId);
      if (d.data().schedulePolicyVersion === schedulePolicy.POLICY_VERSION || firstVisit) assertCurrentEvidence(d.data().sampleAssessments, prior && { id: d.data().priorVisitId, ...prior }, { requireLocation: firstVisit });
      // Visit 1 approval re-checks report eligibility before anything is written (spec section 19).
      if (firstVisit) {
        const problems = await firstVisitEligibilityInTransaction(tx, cohort.data());
        if (problems.length) throw reportNotEligible(problems);
      }
    }
    const now = Timestamp.now(),
      status = approve ? "APPROVED" : "RETURNED";
    let nextScheduledDueDate = null;
    if (approve && (d.data().schedulePolicyVersion === schedulePolicy.POLICY_VERSION || firstVisit)) {
      try { nextScheduledDueDate = schedulePolicy.scheduleAfterApproval(d.data()); }
      catch (error) {
        if (!firstVisit) throw error;
        throw Object.assign(conflict("The first visit needs a valid Date Monitored before approval."), { code: "VISIT_SCHEDULE_INCOMPLETE" });
      }
    }
    // All first-visit cohort changes are computed before any write: plan APPROVED/RETURNED and, on approval,
    // the baseline built from this visit (which locks the sample membership and Tree IDs).
    let firstVisitCohortUpdate = null;
    if (firstVisit) {
      const helpers = cohortHelpers(), current = cohort.data();
      const plan = helpers.planReviewTransition({ samplingPlan: current.samplingPlan, samplingPlanHistory: current.samplingPlanHistory },
        status, actorId, now, String(reasons).trim());
      firstVisitCohortUpdate = { ...plan, updatedAt: now };
      if (approve) {
        const built = helpers.buildBaselineFromVisit({ cohort: { ...current, samplingPlan: plan.samplingPlan }, visit: { id: d.id, ...d.data() }, actorId, now });
        Object.assign(firstVisitCohortUpdate, { baseline: built.baseline, baselineStatus: built.baselineStatus, baselineVersion: built.baselineVersion,
          baselineHistory: [...(Array.isArray(current.baselineHistory) ? current.baselineHistory : []), ...built.baselineHistoryAppend] });
      }
    }
    release.writeScope(actorId, d.data().cohortId);
    tx.update(ref, {
      status,
      reviewedBy: actorId,
      reviewReasons: String(reasons).trim().slice(0, 1000),
      reviewedAt: now,
      ...(approve ? { scheduleStatus: "COMPLETED", nextScheduledDueDate,
        // The approved actual monitoring date becomes the authoritative Visit 1 (baseline) date; the start day is kept.
        ...(firstVisit && d.data().dateMonitored ? { visitDate: d.data().dateMonitored, startedOn: d.data().startedOn || d.data().visitDate } : {}) } : { scheduleStatus: "RETURNED" }),
      history: [...(d.data().history || []), {
        version: d.data().version,
        status,
        visitNumber: d.data().visitNumber || null,
        scheduledDueDate: d.data().scheduledDueDate || d.data().visitDate || null,
        nextScheduledDueDate,
        reviewedBy: actorId,
        reviewedAt: now,
        ...(reviewedOriginals.length ? {originalEvidenceReviews:reviewedOriginals, accuracyAcknowledgment:"UNKNOWN", policyStatus:require("../config/sampleMonitoringOriginalProposal").requireOriginalProposal().policyStatus} : {})
      }]
    });
    const scheduleUpdate = approve && nextScheduledDueDate ? {
      permanentSampleSchedule: {
        policyVersion: schedulePolicy.POLICY_VERSION,
        lastApprovedVisitId: d.id,
        lastApprovedVisitNumber: d.data().visitNumber,
        lastActualVisitDate: d.data().dateMonitored,
        nextVisitNumber: Number(d.data().visitNumber) + 1,
        nextScheduledDueDate,
        updatedAt: now,
      },
      updatedAt: now,
    } : null;
    if (firstVisitCohortUpdate) tx.update(reviewCohortRef, { ...firstVisitCohortUpdate, ...(scheduleUpdate || {}) });
    else if (scheduleUpdate) tx.update(cohort.ref, scheduleUpdate);
  });
  return get(visitId);
}
// T6: authorized, read-only explanation of why a permanent-sample visit cannot be started yet.
// It never names other Staff members, exposes evidence, or changes any record.
const READINESS_LIMIT = 25;
const READINESS_CURSOR = /^(?!__.*__$)[A-Za-z0-9_-]{1,200}$/; // Firestore reserves __*__ document IDs
function readinessPage(limit, cursor) {
  const size = limit === undefined ? READINESS_LIMIT : typeof limit === "string" && /^\d{1,2}$/.test(limit) ? Number(limit) : limit;
  if (!Number.isSafeInteger(size) || size < 1 || size > READINESS_LIMIT || (cursor !== undefined && (typeof cursor !== "string" || !READINESS_CURSOR.test(cursor)))) {
    throw Object.assign(new Error("The readiness page request is invalid."), { status: 400, code: "INVALID_READINESS_QUERY" });
  }
  return size;
}
// One page of cohort documents in document ID order, plus one more when another page exists.
async function readinessCohortDocs(policy, size, cursor) {
  const cohorts = db.collection("verifiedPlantingCohorts");
  if (!policy.pilot) {
    const ordered = cohorts.orderBy("__name__");
    return (await (cursor === undefined ? ordered : ordered.startAfter(cursor)).limit(size + 1).get()).docs;
  }
  // The pilot list is already bounded (at most 10 IDs), so order and cursor apply within the allowed IDs.
  const allowed = policy.cohorts.filter(id => cursor === undefined || id > cursor);
  if (!allowed.length) return [];
  const snapshot = await release.scopeQuery(cohorts, { ...policy, cohorts: allowed }, "__name__").limit(READINESS_LIMIT + 1).get();
  return [...snapshot.docs].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, size + 1);
}
async function readiness({ actorId, actorRole, limit, cursor }) {
  if (!["staff", "admin"].includes(actorRole)) throw Object.assign(new Error("Monitoring visits are restricted to MENRO Staff and Admin."), { status: 403 });
  const policy = release.assertUser(actorId);
  const size = readinessPage(limit, cursor);
  const config = resolveVerifiedPlantingCohortConfig();
  const activeSchedule = schedulePolicy.resolvePermanentSampleSchedule();
  const gates = { writesPaused: policy.paused, firstVisitBaselineEnabled: firstVisitConfig.firstVisitBaselineEnabled(),
    scheduleEnabled: activeSchedule.enabled, pilotRestricted: policy.pilot };
  const found = await readinessCohortDocs(policy, size, cursor);
  const cohortDocs = found.slice(0, size);
  const nextCursor = found.length > size ? cohortDocs.at(-1).id : null;
  const today = schedulePolicy.dateOnlyInManila();
  const cohorts = await Promise.all(cohortDocs.map(async doc => {
    const c = doc.data(), source = c.source || {}, reasons = [];
    const [visits, siteDoc, reportDoc] = await Promise.all([
      db.collection("sampleMonitoringVisits").where("cohortId", "==", doc.id).get(),
      source.siteId ? db.collection("sites").doc(source.siteId).get() : null,
      source.plantingReportId ? db.collection("plantingReports").doc(source.plantingReportId).get() : null,
    ]);
    // First-visit mode (flag read only for cohorts that could use it): visit 1 registers the plan and baseline,
    // so the legacy plan/baseline/policy-snapshot blockers do not apply (interim limitation L7).
    const firstVisit = firstVisitPending(c) && firstVisitConfig.firstVisitBaselineEnabled();
    const firstVisitPolicy = usesAuthorizedFirstVisitPolicy(c);
    let sampleTarget = null;
    if (policy.paused) reasons.push({ code: "WRITES_PAUSED" });
    if (firstVisit) {
      sampleTarget = c.samplingPlan ? c.samplingPlan.provisionalTarget ?? null : firstVisitConfig.calculateSampleTarget(c.verifiedPlantedQuantity);
      reasons.push({ code: "FIRST_VISIT_REGISTERS_BASELINE", informational: true, sampleTarget });
      const problems = reportEligibilityProblems(c, reportDoc, siteDoc);
      if (problems.length) reasons.push({ code: "REPORT_NOT_ELIGIBLE", problems });
      if (!c.samplingPlan) {
        try {
          cohortHelpers().prepareFirstVisitPlan({ cohort: { id: doc.id, ...c }, cohortId: doc.id, actorId: "readiness", now: null,
            reportNumber: reportDoc?.exists ? reportDoc.data().reportNumber : "" });
        } catch (error) { reasons.push({ code: error.code || "FIRST_VISIT_PLAN_UNAVAILABLE" }); }
      }
    } else {
      if (!firstVisitPolicy && !c.samplingPolicySnapshot && !config.provisionalSamplingAllowed) reasons.push({ code: "SAMPLING_POLICY_SNAPSHOT_MISSING" });
      if (!firstVisitPolicy && c.samplingPolicySnapshot) {
        const pending = require("./purposePolicy.service").samplingReadiness(Number(c.verifiedPlantedQuantity || 0), c.samplingPolicySnapshot, source.plantingDate).pending;
        if (pending.length) reasons.push({ code: "SAMPLING_POLICY_PENDING", pending });
      }
      if (c.samplingPlan?.status !== "APPROVED") reasons.push({ code: "SAMPLING_PLAN_NOT_APPROVED", planStatus: c.samplingPlan?.status || "NOT_STARTED" });
      else if (usesRejectedProvisionalPolicy(c) && c.samplingPolicySnapshot) reasons.push({ code: "TEST_ONLY_SAMPLING_POLICY" });
      if (c.baseline?.approvalStatus !== "APPROVED") reasons.push({ code: "BASELINE_NOT_APPROVED", baselineStatus: c.baseline?.approvalStatus || c.baselineStatus || "NOT_STARTED" });
      // No plan and no baseline yet, and the first-visit workflow that would register both is off.
      if (!c.samplingPlan && !c.baseline) reasons.push({ code: "FIRST_VISIT_POLICY_DISABLED" });
    }
    const visitRows = visits.docs.map(visit => ({ id: visit.id, ...visit.data() }));
    const open = visitRows.filter(visit => OPEN_VISIT_STATUSES.has(visit.status));
    if (open.length) reasons.push({ code: "OPEN_VISIT_EXISTS", visitStatus: open[0].status, ownedByYou: open.some(visit => visit.createdBy === actorId) });
    const approved = visitRows.filter(visit => visit.status === "APPROVED")
      .sort((a, b) => Number(a.visitNumber || 0) - Number(b.visitNumber || 0) || String(a.scheduledDueDate || a.visitDate).localeCompare(String(b.scheduledDueDate || b.visitDate)));
    let nextVisitNumber = approved.length + 1, nextScheduledDueDate = approved.length ? null : today;
    if (!activeSchedule.enabled) reasons.push({ code: "VISIT_SCHEDULING_POLICY_PENDING" });
    else if (approved.length) {
      try { nextScheduledDueDate = schedulePolicy.scheduleAfterApproval(approved.at(-1)); }
      catch { reasons.push({ code: "APPROVED_VISIT_SCHEDULE_INCOMPLETE" }); }
    }
    if (activeSchedule.enabled && nextScheduledDueDate && today < nextScheduledDueDate) reasons.push({ code: "VISIT_NOT_OPEN", openingDate: nextScheduledDueDate });
    const scheduleStatus = nextScheduledDueDate ? schedulePolicy.scheduleStatus(nextScheduledDueDate, today) : "POLICY_PENDING";
    // Informational reasons (FIRST_VISIT_REGISTERS_BASELINE) never block creation.
    const canCreateVisit = reasons.every(reason => reason.informational === true);
    // D-5 (additive): read-only Section 1 context from the documents already read above (same release scope).
    const context = require("./sampleMonitoringViewContext").readinessContext({
      cohort: c, siteId: source.siteId || null,
      site: siteDoc?.exists ? siteDoc.data() : null, report: reportDoc?.exists ? reportDoc.data() : null,
      sampleTarget: firstVisit ? sampleTarget : c.samplingPlan?.status === "APPROVED" && Array.isArray(c.samplingPlan.selectedSamples) ? c.samplingPlan.selectedSamples.length : null,
      nextVisitNumber,
      monitoringStatus: open.length ? open[0].status : approved.length ? scheduleStatus : firstVisit && canCreateVisit ? "FIRST_VISIT_AVAILABLE" : "NOT_STARTED",
    });
    return { cohortId: doc.id, reportNumber: reportDoc?.exists ? reportDoc.data().reportNumber || null : null,
      siteName: siteDoc?.exists ? siteDoc.data().siteName || null : null,
      nextVisitNumber, nextScheduledDueDate, openingDate: nextScheduledDueDate,
      scheduleStatus,
      ...(firstVisit ? { registersBaseline: true, sampleTarget } : {}),
      canCreateVisit, reasons, context };
  }));
  return { cohorts, truncated: nextCursor !== null, nextCursor, gates,
    // Selectable reports (a visit can be created now) are separated from the rest, which keep their reasons.
    eligible: cohorts.filter(row => row.canCreateVisit), notEligible: cohorts.filter(row => !row.canCreateVisit),
    visitCreationAvailable: activeSchedule.enabled && cohorts.some(row => row.canCreateVisit),
    schedulingPolicyStatus: activeSchedule.enabled ? "ACTIVE" : "PENDING_MENRO_APPROVAL",
    schedulePolicy: { enabled: activeSchedule.enabled, policyVersion: activeSchedule.policyVersion } };
}
module.exports = {
  create,
  list,
  get,
  save,
  review,
  readiness,
  reportEligibilityProblems,
  reportNotEligible,
  // Server survival/condition summary, shared with the visit view context's history rows (B5).
  summary,
  _test: {
    summary,
    normalize,
    id,
    priorApprovedVisit,
    currentEvidence,
    inheritedDeadIsValid,
    assertCurrentEvidence,
    reportEligibilityProblems,
    withGrowth
  }
};
