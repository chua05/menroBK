// Authorized visit display context only. No scheduling or sampling decisions.
const validation = require("./sampleMonitoringValidation");
// A visit belongs to its cohort's source site only; any mismatch yields no context or labels.
const cohortMatchesVisit = (cohort, visit) => Boolean(cohort && visit?.siteId && (cohort.source || {}).siteId === visit.siteId);
// Shared report/site display labels (Admin Monitoring Records rows and the visit form context).
const contextLabels = (site = {}, report = {}) => ({ reportNumber: report.reportNumber || null,
  siteName: site.siteName || report.siteName || null, barangay: site.barangay || report.barangay || null });
// --- B5: visit history, approved per-tree timeline and tree map markers (read-only, derived on every read) ---
const schedulePolicy = require("../config/permanentSampleSchedule");
// Loaded lazily: the visit service loads this module at read time, and its summary is the single server formula.
const visitSummary = rows => require("./sampleMonitoringVisit.service").summary(rows);
const coordinate = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const orderNumber = value => Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
const byVisitNumber = (a, b) => orderNumber(a.visitNumber) - orderNumber(b.visitNumber) ||
  String(a.scheduledDueDate || a.visitDate || "").localeCompare(String(b.scheduledDueDate || b.visitDate || "")) || String(a.id).localeCompare(String(b.id));
// GPS checked by the server at capture (browser capture session), or explicitly marked VERIFIED; anything else
// (an uploaded original awaiting review, a manually entered legacy position) is reported as UNVERIFIED.
const gpsVerification = entry => (entry?.verificationStatus ? entry.verificationStatus === "VERIFIED" : Boolean(entry?.captureSessionId)) ? "VERIFIED" : "UNVERIFIED";
// The latest current-revision evidence of a row, used only when it carries an evidence id and stored GPS (B3 rule).
function currentLocatedEvidence(row = {}) {
  const latest = (row.evidenceHistory || []).filter(evidence =>
    Number(evidence?.revision) === Number(row.assessmentRevision || 0) && Boolean(evidence?.privateEvidence)).at(-1);
  const location = latest?.location || {};
  return latest && (latest.evidenceId || latest.captureSessionId) && coordinate(location.latitude) && coordinate(location.longitude) ? latest : null;
}
function historyRows(visits, cohort, viewer = {}) {
  const rows = visits.map(entry => {
    const dates = { visitNumber: entry.visitNumber ?? null, scheduledDueDate: entry.scheduledDueDate || null, visitDate: entry.visitDate || null,
      dateMonitored: entry.dateMonitored || null, status: entry.status || null };
    // Staff see another Staff member's unapproved visit only as a schedule entry (no id, no counts). Admin is unchanged.
    if (viewer.actorRole === "staff" && entry.status !== "APPROVED" && entry.createdBy !== viewer.actorId) {
      return { visitId: null, ...dates, healthy: null, damaged: null, confirmedDead: null, needsRechecking: null, notAssessed: null,
        survivalRate: null, survivalStatus: null };
    }
    const counts = visitSummary(Array.isArray(entry.sampleAssessments) ? entry.sampleAssessments.filter(row => row && typeof row === "object") : []);
    // Staff open their own visits; approved results of other Staff stay summarized here and in the tree timeline.
    return { visitId: entry.id, canView: viewer.actorRole === "admin" || Boolean(viewer.actorId) && entry.createdBy === viewer.actorId, ...dates, healthy: counts.healthy, damaged: counts.damaged,
      confirmedDead: counts.confirmedDead, needsRechecking: counts.needsRechecking, notAssessed: counts.notAssessed,
      survivalRate: counts.survivalRate, survivalStatus: counts.survivalStatus };
  });
  // The next visit only when the server-written schedule names it and no visit exists for it yet.
  const next = cohort.permanentSampleSchedule || {};
  if (Number.isSafeInteger(next.nextVisitNumber) && schedulePolicy.validDateOnly(next.nextScheduledDueDate) &&
      !visits.some(entry => Number(entry.visitNumber) === next.nextVisitNumber)) {
    rows.push({ visitId: null, visitNumber: next.nextVisitNumber, scheduledDueDate: next.nextScheduledDueDate, visitDate: null, dateMonitored: null, status: "SCHEDULED",
      availability: next.nextScheduledDueDate > schedulePolicy.dateOnlyInManila() ? "NOT_YET_AVAILABLE" : "AVAILABLE",
      healthy: null, damaged: null, confirmedDead: null, needsRechecking: null, notAssessed: null, survivalRate: null, survivalStatus: null });
  }
  return rows;
}
function approvedTimeline(visits) {
  const timeline = {};
  for (const entry of visits.filter(row => row.status === "APPROVED")) {
    for (const row of entry.sampleAssessments || []) {
      if (!row || typeof row.sampleId !== "string") continue;
      (timeline[row.sampleId] ||= []).push({ visitId: entry.id, visitNumber: entry.visitNumber ?? null, assessedOn: row.assessedOn || null,
        dateMonitored: entry.dateMonitored || null, condition: row.condition || null, heightCentimeters: row.heightCentimeters ?? null,
        stemDiameterMillimeters: validation.cmToMm(row.diameterCentimeters), mortalityCause: row.mortalityCause || null,
        recheckReason: row.recheckReason || null, remarks: row.remarks || "" });
    }
  }
  return timeline;
}
function treeMarkers({ cohort, visit, visits, timeline, samples, selectedSamples }) {
  const speciesOf = (id, fallback) => selectedSamples.find(row => row?.permanentId === id)?.species || fallback || null;
  const byId = new Map(visits.map(entry => [entry.id, entry]));
  const markers = [];
  const baseline = cohort.baseline || {};
  // APPROVED: the registered position of the approved baseline (for first-visit cohorts, from approved visit 1).
  if (baseline.approvalStatus === "APPROVED" && Array.isArray(baseline.sampleUnits)) {
    for (const unit of baseline.sampleUnits) {
      if (!unit || typeof unit.permanentId !== "string" || !coordinate(unit.latitude) || !coordinate(unit.longitude)) continue;
      const last = timeline[unit.permanentId]?.at(-1);
      const reference = (unit.photoReferences || [])[0];
      const source = reference?.sourceVisitId ? (byId.get(reference.sourceVisitId)?.sampleAssessments || []).find(row => row?.sampleId === unit.permanentId) : null;
      const sourceEvidence = source && (source.evidenceHistory || []).filter(evidence => evidence?.privateEvidence &&
        Number(evidence.revision) === Number(reference.sourceAssessmentRevision) &&
        String(evidence.evidenceId || evidence.captureSessionId || "") === String(reference.evidenceId)).at(-1);
      markers.push({ sampleId: unit.permanentId, species: speciesOf(unit.permanentId, unit.species), latitude: Number(unit.latitude), longitude: Number(unit.longitude),
        kind: "APPROVED", ...(last ? { latestApprovedCondition: last.condition, visitNumber: last.visitNumber, assessedOn: last.assessedOn,
          heightCentimeters: last.heightCentimeters, stemDiameterMillimeters: last.stemDiameterMillimeters }
          : { latestApprovedCondition: unit.condition || null, visitNumber: null, assessedOn: unit.captureDate || null,
            heightCentimeters: Number.isFinite(unit.heightMeters) ? Number((unit.heightMeters * 100).toFixed(6)) : null,
            stemDiameterMillimeters: validation.cmToMm(unit.diameterCentimeters) }),
        gpsVerification: gpsVerification(reference?.sourceVisitId ? sourceEvidence : reference) });
    }
  }
  // DRAFT: the viewed visit, while not approved, at its current verified evidence location. Never official.
  if (visit.status !== "APPROVED") {
    const ids = new Map(samples.filter(unit => unit && typeof unit.permanentId === "string").map(unit => [unit.permanentId, unit]));
    for (const row of visit.sampleAssessments || []) {
      if (!row || !ids.has(row.sampleId)) continue;
      const evidence = currentLocatedEvidence(row);
      // Only server-verified GPS places a draft marker; UNVERIFIED appears on APPROVED registered positions only.
      if (!evidence || gpsVerification(evidence) !== "VERIFIED") continue;
      markers.push({ sampleId: row.sampleId, species: speciesOf(row.sampleId, ids.get(row.sampleId).species),
        latitude: Number(evidence.location.latitude), longitude: Number(evidence.location.longitude), kind: "DRAFT",
        latestApprovedCondition: timeline[row.sampleId]?.at(-1)?.condition ?? null, visitNumber: visit.visitNumber ?? null,
        assessedOn: row.assessedOn || null, heightCentimeters: row.heightCentimeters ?? null,
        stemDiameterMillimeters: validation.cmToMm(row.diameterCentimeters), gpsVerification: gpsVerification(evidence) });
    }
  }
  return markers;
}
// Shared display rows (visit context and readiness context). Unknown per-species planted counts stay null.
const speciesQuantities = (source = {}) => (Array.isArray(source.species) ? source.species : [])
  .filter(row => row && typeof row.species === "string" && row.species.trim())
  .map(row => ({ species: row.species.trim(),
    verifiedPlantedQuantity: Number.isSafeInteger(row.verifiedPlantedQuantity) && row.verifiedPlantedQuantity >= 0 ? row.verifiedPlantedQuantity : null }));
// Authoritative site geometry only; a missing or invalid polygon is never fabricated.
const siteDisplay = (site = {}) => ({ siteName: site.siteName || null, barangay: site.barangay || null, latitude: site.latitude ?? null,
  longitude: site.longitude ?? null, coverageRadiusMeters: site.coverageRadiusMeters ?? null, polygon: Array.isArray(site.polygon) ? site.polygon.filter(point => point && typeof point === "object").map(point => ({ lat: point.lat, lng: point.lng })) : null });
// Final fix wave D-5: read-only spec section 3 / 8 Section 1 fields for a readiness row, built only from the
// cohort, report and site documents readiness already read inside the caller's release scope. It never
// includes requester details, evidence, plan Tree IDs or other Staff members.
function readinessContext({ cohort = {}, site = null, siteId = null, report = null, sampleTarget = null, nextVisitNumber = null, monitoringStatus = null }) {
  const source = cohort.source || {}, plan = cohort.samplingPlan || null, baseline = cohort.baseline || null;
  const siteData = site || {}, reportData = report || {};
  return {
    plantingReportId: source.plantingReportId || null,
    plantingReportNumber: reportData.reportNumber || null,
    site: { id: siteId || null, ...siteDisplay(siteData), address: siteData.address || siteData.locationDescription || null },
    plantingDate: reportData.plantingDate || reportData.eventDate || source.plantingDate || null,
    verificationStatus: reportData.verificationStatus || null,
    verifiedPlantedQuantity: cohort.verifiedPlantedQuantity ?? null,
    species: speciesQuantities(source).map(row => ({ species: row.species, quantity: row.verifiedPlantedQuantity })),
    sampleTarget,
    sampleRegistrationStatus: baseline?.approvalStatus === "APPROVED" ? "APPROVED" : plan?.status || "NOT_STARTED",
    registeredSampleCount: Array.isArray(baseline?.sampleUnits) ? baseline.sampleUnits.length : 0,
    nextVisitNumber,
    monitoringStatus,
  };
}
async function monitoringContext(db, visit, viewer = {}) {
  if (!visit.cohortId || !visit.siteId) return null;
  const cohortDoc = await db.collection("verifiedPlantingCohorts").doc(visit.cohortId).get();
  if (!cohortDoc.exists) return null;
  const cohort = cohortDoc.data(), source = cohort.source || {};
  if (!cohortMatchesVisit(cohort, visit)) return null;
  const [siteDoc, reportDoc, priorDoc, cohortVisitDocs] = await Promise.all([
    db.collection("sites").doc(visit.siteId).get(),
    source.plantingReportId ? db.collection("plantingReports").doc(source.plantingReportId).get() : null,
    visit.priorVisitId ? db.collection("sampleMonitoringVisits").doc(visit.priorVisitId).get() : null,
    // Unlimited history: every visit of this cohort (same site), ordered by visit number.
    db.collection("sampleMonitoringVisits").where("cohortId", "==", visit.cohortId).get(),
  ]);
  const cohortVisits = cohortVisitDocs.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(entry => entry.cohortId === visit.cohortId && entry.siteId === visit.siteId).sort(byVisitNumber);
  const site = siteDoc.exists ? siteDoc.data() : {}, report = reportDoc?.exists ? reportDoc.data() : {};
  const prior = priorDoc?.exists ? priorDoc.data() : null;
  const matchingPrior = prior?.status === "APPROVED" && prior.cohortId === visit.cohortId && prior.siteId === visit.siteId && prior.baselineVersion === visit.baselineVersion && prior.samplingPlanVersion === visit.samplingPlanVersion && prior.visitDate < visit.visitDate ? prior : null;
  const plan = cohort.samplingPlan || {}, baseline = cohort.baseline || {};
  const units = Array.isArray(baseline.sampleUnits) ? baseline.sampleUnits : null;
  const selectedSamples = Array.isArray(plan.selectedSamples) ? plan.selectedSamples : [];
  // Visit 1 registers the baseline: until it is approved its samples are the first-visit plan's Tree IDs.
  const registeringBaseline = validation.registersFirstVisitBaseline(cohort, visit);
  const samples = validation.samplesFor(cohort, visit);
  // The approved timeline (and the markers' latest approved values) use only visits bound to the cohort's
  // current baseline and plan versions, as the previous-visit context does.
  const currentVersionVisits = cohortVisits.filter(entry => (entry.baselineVersion ?? null) === (cohort.baselineVersion ?? null) &&
    (plan.version === undefined || plan.version === null || entry.samplingPlanVersion === plan.version));
  const treeTimeline = approvedTimeline(currentVersionVisits);
  return {
    plantingReportId: source.plantingReportId || null, ...contextLabels(site, report),
    plantingDate: report.plantingDate || report.eventDate || source.plantingDate || null,
    reportStatus: report.reportingProgress || report.verificationStatus || null,
    verifiedPlantedQuantity: cohort.verifiedPlantedQuantity ?? null,
    // Display only: authoritative cohort species rows. Unknown per-species planted counts stay null.
    speciesQuantities: speciesQuantities(source),
    planStatus: plan.status || null, baselineStatus: baseline.approvalStatus || null,
    approvedSampleTarget: plan.status === "APPROVED" && Array.isArray(plan.selectedSamples) ? plan.selectedSamples.length : null,
    // Server-calculated target: the first-visit plan's provisional 10% target while visit 1 registers the baseline.
    sampleTarget: registeringBaseline ? (Number.isSafeInteger(plan.provisionalTarget) ? plan.provisionalTarget : null)
      : plan.status === "APPROVED" && Array.isArray(plan.selectedSamples) ? plan.selectedSamples.length : null,
    registersBaseline: visit.registersBaseline === true,
    registeredSampleTrees: units ? units.length : null,
    site: siteDisplay(site),
    schedule: {
      policyVersion: visit.schedulePolicyVersion || null,
      visitNumber: visit.visitNumber || null,
      scheduledDueDate: visit.scheduledDueDate || visit.visitDate || null,
      openingDate: visit.openingDate || visit.scheduledDueDate || visit.visitDate || null,
      actualVisitDate: visit.dateMonitored || null,
      nextScheduledDueDate: visit.nextScheduledDueDate || cohort.permanentSampleSchedule?.nextScheduledDueDate || null,
      status: visit.scheduleStatus || cohort.samplingReadiness?.status || null,
      // Compatibility aliases for existing clients. Values are server-owned.
      startMonitoringDate: visit.openingDate || visit.scheduledDueDate || visit.visitDate || null,
      nextMonitoringDate: visit.nextScheduledDueDate || cohort.permanentSampleSchedule?.nextScheduledDueDate || null,
    },
    samples: samples.filter(unit => unit && typeof unit.permanentId === "string").map(unit => {
      const selected = selectedSamples.find(row => row?.permanentId === unit.permanentId);
      const previous = matchingPrior?.sampleAssessments?.find(row => row.sampleId === unit.permanentId);
      return { sampleId: unit.permanentId, species: selected?.species || unit.species || null,
        latitude: unit.latitude ?? null, longitude: unit.longitude ?? null,
        baseline: registeringBaseline ? null : { condition: unit.condition || null, heightCentimeters: Number.isFinite(unit.heightMeters) ? unit.heightMeters * 100 : null,
          diameterCentimeters: unit.diameterCentimeters ?? null, stemDiameterMillimeters: validation.cmToMm(unit.diameterCentimeters),
          remarks: unit.remarks || "", date: unit.captureDate || null,
          photoCount: (unit.photoReferences || []).length },
        previous: previous ? { visitId: visit.priorVisitId, date: matchingPrior.visitDate, condition: previous.condition,
          heightCentimeters: previous.heightCentimeters ?? null, diameterCentimeters: previous.diameterCentimeters ?? null,
          // API unit (mm) derived from the stored cm value; the per-tree date and recorded cause when present.
          stemDiameterMillimeters: validation.cmToMm(previous.diameterCentimeters), assessedOn: previous.assessedOn || null,
          mortalityCause: previous.mortalityCause || null,
          remarks: previous.remarks || "", recheckQueued: Boolean(previous.recheckQueued),
          evidence: (previous.evidenceHistory || []).map(({ revision, linkedAt }, index) => ({ revision, linkedAt, index })) } : null };
    }),
    // B5 (additive): spec section 22 history, approved per-tree history and spec section 11 map markers.
    history: historyRows(cohortVisits, cohort, viewer),
    treeTimeline,
    treeMarkers: treeMarkers({ cohort, visit, visits: cohortVisits, timeline: treeTimeline, samples, selectedSamples }),
  };
}
module.exports = { monitoringContext, contextLabels, cohortMatchesVisit, readinessContext };
