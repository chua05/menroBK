// Authorized visit display context only. No scheduling or sampling decisions.
async function monitoringContext(db, visit) {
  if (!visit.cohortId || !visit.siteId) return null;
  const cohortDoc = await db.collection("verifiedPlantingCohorts").doc(visit.cohortId).get();
  if (!cohortDoc.exists) return null;
  const cohort = cohortDoc.data(), source = cohort.source || {};
  if (source.siteId !== visit.siteId) return null;
  const [siteDoc, reportDoc, priorDoc] = await Promise.all([
    db.collection("sites").doc(visit.siteId).get(),
    source.plantingReportId ? db.collection("plantingReports").doc(source.plantingReportId).get() : null,
    visit.priorVisitId ? db.collection("sampleMonitoringVisits").doc(visit.priorVisitId).get() : null,
  ]);
  const site = siteDoc.exists ? siteDoc.data() : {}, report = reportDoc?.exists ? reportDoc.data() : {};
  const prior = priorDoc?.exists ? priorDoc.data() : null;
  const matchingPrior = prior?.status === "APPROVED" && prior.cohortId === visit.cohortId && prior.siteId === visit.siteId && prior.baselineVersion === visit.baselineVersion && prior.samplingPlanVersion === visit.samplingPlanVersion && prior.visitDate < visit.visitDate ? prior : null;
  const plan = cohort.samplingPlan || {}, baseline = cohort.baseline || {};
  const units = Array.isArray(baseline.sampleUnits) ? baseline.sampleUnits : null;
  const selectedSamples = Array.isArray(plan.selectedSamples) ? plan.selectedSamples : [];
  return {
    plantingReportId: source.plantingReportId || null, reportNumber: report.reportNumber || null,
    siteName: site.siteName || report.siteName || null, barangay: site.barangay || report.barangay || null,
    plantingDate: report.plantingDate || report.eventDate || source.plantingDate || null,
    reportStatus: report.reportingProgress || report.verificationStatus || null,
    verifiedPlantedQuantity: cohort.verifiedPlantedQuantity ?? null,
    // Display only: authoritative cohort species rows. Unknown per-species planted counts stay null.
    speciesQuantities: (Array.isArray(source.species) ? source.species : [])
      .filter(row => row && typeof row.species === "string" && row.species.trim())
      .map(row => ({ species: row.species.trim(),
        verifiedPlantedQuantity: Number.isSafeInteger(row.verifiedPlantedQuantity) && row.verifiedPlantedQuantity >= 0 ? row.verifiedPlantedQuantity : null })),
    planStatus: plan.status || null, baselineStatus: baseline.approvalStatus || null,
    approvedSampleTarget: plan.status === "APPROVED" && Array.isArray(plan.selectedSamples) ? plan.selectedSamples.length : null,
    registeredSampleTrees: units ? units.length : null,
    site: { siteName: site.siteName || null, barangay: site.barangay || null, latitude: site.latitude ?? null,
      longitude: site.longitude ?? null, coverageRadiusMeters: site.coverageRadiusMeters ?? null, polygon: Array.isArray(site.polygon) ? site.polygon.filter(point => point && typeof point === "object").map(point => ({ lat: point.lat, lng: point.lng })) : null },
    schedule: { startMonitoringDate: visit.startMonitoringDate || cohort.samplingReadiness?.firstVisitDueDate || null,
      nextMonitoringDate: visit.nextMonitoringDate || null, visitNumber: visit.visitNumber || null,
      status: visit.scheduleStatus || cohort.samplingReadiness?.status || null },
    samples: (units || []).filter(unit => unit && typeof unit.permanentId === "string").map(unit => {
      const selected = selectedSamples.find(row => row?.permanentId === unit.permanentId);
      const previous = matchingPrior?.sampleAssessments?.find(row => row.sampleId === unit.permanentId);
      return { sampleId: unit.permanentId, species: selected?.species || unit.species || null,
        latitude: unit.latitude ?? null, longitude: unit.longitude ?? null,
        baseline: { condition: unit.condition || null, heightCentimeters: Number.isFinite(unit.heightMeters) ? unit.heightMeters * 100 : null,
          diameterCentimeters: unit.diameterCentimeters ?? null, remarks: unit.remarks || "", date: unit.captureDate || null,
          photoCount: (unit.photoReferences || []).length },
        previous: previous ? { visitId: visit.priorVisitId, date: matchingPrior.visitDate, condition: previous.condition,
          heightCentimeters: previous.heightCentimeters ?? null, diameterCentimeters: previous.diameterCentimeters ?? null,
          remarks: previous.remarks || "", recheckQueued: Boolean(previous.recheckQueued),
          evidence: (previous.evidenceHistory || []).map(({ revision, linkedAt }, index) => ({ revision, linkedAt, index })) } : null };
    }),
  };
}
module.exports = { monitoringContext };
