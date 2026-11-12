const crypto = require("node:crypto");
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
const { assessmentFingerprint } = require("./sampleMonitoringOriginalEvidence");
const originals = require("./sampleMonitoringOriginalPhoto.service");
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
  release.assertUser(actorId); release.assertWrite();
  if (!files?.length || files.length !== 1) throw Object.assign(new Error("One verified assessment photo is required."), {
    status: 400
  });
  const visit = (await db.collection("sampleMonitoringVisits").doc(visitId).get()).data();
  // Ownership/scope is checked before a historical operation can be read, but
  // editability is intentionally checked after an exact completed retry.
  if (!visit || visit.createdBy !== actorId) throw bad("This monitoring visit is no longer editable.");
  release.assertScope(actorId, visit.cohortId);
  const assessment = visit.sampleAssessments?.find(a => a.sampleId === sampleId);
  if (!assessment) throw bad("Permanent sample is not part of this visit.");
  const cohort = (await db.collection("verifiedPlantingCohorts").doc(visit.cohortId).get()).data();
  if (!cohort || cohort?.samplingPlan?.status !== "APPROVED" ||
      Number(cohort.samplingPlan.version) !== Number(visit.samplingPlanVersion) ||
      cohort?.baseline?.approvalStatus !== "APPROVED" ||
      Number(cohort.baselineVersion || 0) !== Number(visit.baselineVersion)) {
    throw bad("The verified planting cohort no longer matches this monitoring visit.");
  }
  const original = evidenceManifest?.[0]?.source === "uploaded-original" && process.env.MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL === "true";
  if (original) require("../config/sampleMonitoringOriginalProposal").requireOriginalProposal();
  const payload = { visitId, sampleId, assessmentRevision, expectedVisitVersion };
  const binding = {
    cohortId: visit.cohortId, siteId: visit.siteId, visitId, sampleId,
    samplingPlanVersion: visit.samplingPlanVersion, baselineVersion: visit.baselineVersion,
    visitVersion: expectedVisitVersion, assessmentRevision,
    captureSessionId: captureSessionIdFrom(evidenceManifest),
    ...(original ? { source: "uploaded-original", originalVerificationId: evidenceManifest[0].originalVerificationId || "" } : {}),
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
    const proof = original ? await originals.resolveOriginal({actorId, visit: {id:visitId,...visit}, sampleId, assessmentRevision, expectedVisitVersion, file:files[0], descriptor:evidenceManifest[0]}) : null;
    const sessions = original ? [] : await capture.resolveSubmissionEvidence({
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
    if (!original && !session) throw Object.assign(bad(
      "Verified Staff capture is required. Use Take Photo; existing-photo uploads are awaiting MENRO approval."
    ), { code: "MONITORING_CAPTURE_REQUIRED" });
    const ref = await workflow().upload(op, 0, files[0], {
      recordId: rid(visitId, sampleId, assessmentRevision),
      evidenceType: "sample-monitoring",
      verification: original ? {latitude:proof.location.latitude,longitude:proof.location.longitude,gpsValid:true,timestampValid:true,siteGpsValid:true,
        capturedAt:proof.capturedAt,captureOffset:proof.captureOffset,captureDateManila:proof.captureDateManila,
        evidenceSource:"uploaded-original",locationSource:"Original EXIF (accuracy unknown)",locationAccuracyMeters:null,verificationPolicyVersion:"local-original-exif-review-v1"} : {
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
      const otherHashes = original ? await Promise.all(["baselineEvidenceHashes","plantingEvidenceHashes","monitoringEvidenceHashes"].map(name=>tx.get(db.collection(name).doc(ref.sha256)))) : [];
      const site = original ? await tx.get(db.collection("sites").doc(visit.siteId)) : null;
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
      if (original) {
        failed.originalOwner = current?.createdBy !== actorId || !["DRAFT","RETURNED"].includes(current?.status);
        failed.originalCohortSite = cohort?.source?.siteId !== current?.siteId;
        failed.originalRegisteredTree = !cohort?.baseline?.sampleUnits?.some(unit=>unit.permanentId===sampleId);
        failed.originalAssessment = !latest || assessmentFingerprint(latest,current?.dateMonitored)!==proof.assessmentFingerprint;
        failed.originalDuplicate = otherHashes.some(doc=>doc.exists);
        failed.originalSite = !site.exists || String(site.data().status||"").toLowerCase()==="inactive";
        if (!failed.originalSite) try { capture.validateSiteLocation(site.data(),proof.location); } catch { failed.originalSite=true; }
      }
      const hashBinding = h.exists ? h.data() : null;
      const existingHashMatchesCurrentBinding = Boolean(hashBinding && hashBinding.visitId === visitId && hashBinding.sampleId === sampleId && Number(hashBinding.assessmentRevision) === Number(assessmentRevision));
      if (Object.values(failed).some(Boolean)) { browserDiagnostic({ visitId, sampleId, expectedVisitVersion, assessmentRevision, existingHashMatchesCurrentBinding, failed }); throw bad("Assessment evidence changed while uploading."); }
      const items = current.sampleAssessments.map(a => a.sampleId !== sampleId ? a : {
        ...a,
        evidenceHistory: [...(a.evidenceHistory || []), {
          revision: assessmentRevision,
          privateEvidence: ref,
          assessmentFingerprint: assessmentFingerprint(latest,current.dateMonitored),
          ...(original ? {source:"uploaded-original",evidenceId:proof.evidenceId,capturedAt:proof.capturedAt,accuracyStatus:"UNKNOWN",
            reportedAccuracyMeters:proof.reportedAccuracyMeters,verificationStatus:"NEEDS_ADMIN_REVIEW",policyStatus:proof.policyStatus,
            originalVerificationId:proof.id,location:proof.location} : {captureSessionId:session.id,location:{latitude:session.latitude,longitude:session.longitude,accuracyMeters:session.accuracyMeters}}),
          linkedAt: Timestamp.now()
        }]
      });
      const complete = await workflow().prepareLink(tx, op),
        consume = original ? await originals.prepareOriginalConsumption(tx, proof) : await capture.prepareConsumption(tx, sessions);
      release.writeScope(actorId, visit.cohortId);
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
