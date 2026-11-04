const crypto = require("node:crypto");
const {
  Timestamp
} = require("firebase-admin/firestore");
const {
  db
} = require("../config/firebase");
const {
  resolveVerifiedPlantingCohortConfig
} = require("../config/verifiedPlantingCohort");
const capture = require("./evidenceCaptureSession.service"),
  {
    workflow,
    runWorkflow
  } = require("./evidenceWorkflow.service");
const bad = m => Object.assign(new Error(m), {
  status: 409
});
const rid = (visitId, sampleId, revision) => `VPME-${crypto.createHash("sha256").update(`${visitId}\0${sampleId}\0${revision}`).digest("hex").slice(0, 48)}`;
const captureSessionIdFrom = manifest => typeof manifest?.[0]?.captureSessionId === "string"
  ? manifest[0].captureSessionId : "";
const browserDiagnostic = (value) => {
  if (process.env.NODE_ENV === "test" && process.env.MENRO_INTEGRATION_TEST === "true" &&
      process.env.MENRO_PHASE3C_BROWSER_ACCEPTANCE === "true") console.info("[phase3c-evidence-linkage]", value);
};
async function upload({
  visitId,
  sampleId,
  assessmentRevision,
  expectedVisitVersion,
  actorId,
  files,
  evidenceManifest,
  idempotencyKey
}) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw Object.assign(new Error("Verified planting cohort workflow is disabled."), {
    status: 409,
    code: "COHORT_WORKFLOW_DISABLED"
  });
  if (!files?.length || files.length !== 1) throw Object.assign(new Error("One verified assessment photo is required."), {
    status: 400
  });
  const visit = (await db.collection("sampleMonitoringVisits").doc(visitId).get()).data();
  // Ownership/scope is checked before a historical operation can be read, but
  // editability is intentionally checked after an exact completed retry.
  if (!visit || visit.createdBy !== actorId) throw bad("This monitoring visit is no longer editable.");
  const assessment = visit.sampleAssessments?.find(a => a.sampleId === sampleId);
  if (!assessment) throw bad("Permanent sample is not part of this visit.");
  const cohort = (await db.collection("verifiedPlantingCohorts").doc(visit.cohortId).get()).data();
  if (!cohort || cohort?.samplingPlan?.status !== "APPROVED" ||
      Number(cohort.samplingPlan.version) !== Number(visit.samplingPlanVersion) ||
      cohort?.baseline?.approvalStatus !== "APPROVED" ||
      Number(cohort.baselineVersion || 0) !== Number(visit.baselineVersion)) {
    throw bad("The verified planting cohort no longer matches this monitoring visit.");
  }
  const payload = { visitId, sampleId, assessmentRevision, expectedVisitVersion };
  const binding = {
    cohortId: visit.cohortId, siteId: visit.siteId, visitId, sampleId,
    samplingPlanVersion: visit.samplingPlanVersion, baselineVersion: visit.baselineVersion,
    visitVersion: expectedVisitVersion, assessmentRevision,
    captureSessionId: captureSessionIdFrom(evidenceManifest),
  };
  const operation = {
    actor: {
      uid: actorId
    },
    workflow: "sample-monitoring",
    target: visitId,
    key: idempotencyKey,
    payload,
    binding,
    files
  };
  const resolveResult = link => ({ visitId: link.visitId, sampleId: link.sampleId });
  const completed = await workflow().resolveCompletedOperation(operation, resolveResult);
  if (completed) return completed;
  if (!['DRAFT', 'RETURNED'].includes(visit.status) || Number(visit.version) !== Number(expectedVisitVersion)) throw bad("This monitoring visit is no longer editable.");
  return runWorkflow(operation, async op => {
    const sessions = await capture.resolveSubmissionEvidence({
      actorId,
      workflow: "sample-monitoring",
      binding: {
        cohortId: visit.cohortId,
        siteId: visit.siteId,
        visitId,
        sampleId,
        samplingPlanVersion: visit.samplingPlanVersion,
        baselineVersion: visit.baselineVersion,
        visitVersion: expectedVisitVersion,
        assessmentRevision
      },
      files,
      manifest: evidenceManifest
    });
    const session = sessions[0];
    if (!session) throw bad("Verified Staff capture is required.");
    const ref = await workflow().upload(op, 0, files[0], {
      recordId: rid(visitId, sampleId, assessmentRevision),
      evidenceType: "sample-monitoring",
      verification: {
        latitude: session.latitude,
        longitude: session.longitude,
        gpsValid: true,
        evidenceSource: assessment.condition === "Needs Rechecking" ? "site-search-camera" : "sample-camera",
        locationSource: "Browser Capture Session",
        locationAccuracyMeters: session.accuracyMeters
      }
    });
    await db.runTransaction(async tx => {
      const vr = db.collection("sampleMonitoringVisits").doc(visitId),
        hash = db.collection("sampleMonitoringEvidenceHashes").doc(ref.sha256),
        cr = db.collection("verifiedPlantingCohorts").doc(visit.cohortId);
      const [v, h, c] = await Promise.all([tx.get(vr), tx.get(hash), tx.get(cr)]);
      const current = v.data(),
        cohort = c.data(),
        latest = current?.sampleAssessments?.find(a => a.sampleId === sampleId);
      const failed = { missingVisit: !v.exists, missingCohort: !c.exists, existingHash: h.exists,
        visitVersion: Number(current?.version) !== Number(expectedVisitVersion), cohortId: current?.cohortId !== visit.cohortId,
        siteId: current?.siteId !== visit.siteId, planVersion: Number(current?.samplingPlanVersion) !== Number(visit.samplingPlanVersion),
        baselineVersion: Number(current?.baselineVersion) !== Number(visit.baselineVersion), planStatus: cohort?.samplingPlan?.status !== "APPROVED",
        cohortPlanVersion: Number(cohort?.samplingPlan?.version) !== Number(current?.samplingPlanVersion), baselineStatus: cohort?.baseline?.approvalStatus !== "APPROVED",
        cohortBaselineVersion: Number(cohort?.baselineVersion || 0) !== Number(current?.baselineVersion), missingAssessment: !latest,
        assessmentRevision: Number(latest?.assessmentRevision || 0) !== Number(assessmentRevision) };
      const hashBinding = h.exists ? h.data() : null;
      const existingHashMatchesCurrentBinding = Boolean(hashBinding && hashBinding.visitId === visitId && hashBinding.sampleId === sampleId && Number(hashBinding.assessmentRevision) === Number(assessmentRevision));
      if (Object.values(failed).some(Boolean)) { browserDiagnostic({ visitId, sampleId, expectedVisitVersion, assessmentRevision, existingHashMatchesCurrentBinding, failed }); throw bad("Assessment evidence changed while uploading."); }
      const items = current.sampleAssessments.map(a => a.sampleId !== sampleId ? a : {
        ...a,
        evidenceHistory: [...(a.evidenceHistory || []), {
          revision: assessmentRevision,
          privateEvidence: ref,
          captureSessionId: session.id,
          linkedAt: Timestamp.now()
        }]
      });
      const complete = await workflow().prepareLink(tx, op),
        consume = await capture.prepareConsumption(tx, sessions);
      tx.update(vr, {
        sampleAssessments: items,
        updatedAt: Timestamp.now()
      });
      tx.create(hash, {
        visitId,
        sampleId,
        assessmentRevision,
        createdAt: Timestamp.now()
      });
      consume(visitId);
      complete({
        visitId,
        sampleId,
        assessmentRevision
      });
    });
    return {
      visitId,
      sampleId
    };
  }, resolveResult);
}
module.exports = {
  upload,
  rid
};
