const s = require("../services/sampleMonitoringVisit.service");
const { resolveVerifiedPlantingCohortConfig } = require("../config/verifiedPlantingCohort");

const gate = res => {
  if (resolveVerifiedPlantingCohortConfig().enabled) return false;
  res.status(409).json({ success: false, code: "COHORT_WORKFLOW_DISABLED" });
  return true;
};
// Evidence is retrieved by authorized visit/sample/history index. Its private
// transport reference and capture ledger never belong in a visit JSON response.
const publicVisit = visit => ({
  ...visit,
  originalEvidenceReviewRequirements: (()=>{try{return require("../services/sampleMonitoringOriginalEvidence").reviewRequirements(visit);}catch{return [];}})(),
  originalPhotoProposal: (()=>{try{return require("../config/sampleMonitoringOriginalProposal").requireOriginalProposal();}catch{return {linkingEnabled:false};}})(),
  ...(Array.isArray(visit?.sampleAssessments) ? {
    sampleAssessments: visit.sampleAssessments.map(assessment => ({
      ...assessment,
      evidenceHistory: (assessment.evidenceHistory || []).map(({ revision, linkedAt, location, source, evidenceId, capturedAt, accuracyStatus, verificationStatus, policyStatus }) => ({ revision, linkedAt, ...(source === "uploaded-original" ? {source,evidenceId,capturedAt,accuracyStatus,verificationStatus,policyStatus} : {}), ...(location ? { location: { latitude: location.latitude, longitude: location.longitude, accuracyMeters: location.accuracyMeters } } : {}) })),
    })),
  } : {}),
});
const send = (res, status, fn) => Promise.resolve().then(fn)
  .then(data => res.status(status).json({ success: true, data: publicVisit(data) }))
  .catch(error => res.status(error.status || 400).json({ success: false, code: error.code, message: error.message }));

exports.create = (req, res) => gate(res) || send(res, 201, () => s.create({
  cohortId: req.params.cohortId, actorId: req.user.uid, visitDate: req.body?.visitDate,
  testOnly: process.env.NODE_ENV === "test" && req.body?.testOnly === true,
}));
exports.list = (req, res) => gate(res) || send(res, 200, () => s.list({
  actorId: req.user.uid, actorRole: req.user.role, status: req.query.status, limit: req.query.limit, cursor: req.query.cursor,
}));
exports.get = (req, res) => gate(res) || send(res, 200, () => s.get(req.params.visitId, {
  actorId: req.user.uid, actorRole: req.user.role,
}));
exports.save = (req, res) => gate(res) || send(res, 200, () => s.save({
  visitId: req.params.visitId, actorId: req.user.uid, expectedVersion: req.body?.expectedVersion,
  assessments: req.body?.assessments, submit: req.body?.submit, visitRemarks: req.body?.visitRemarks, dateMonitored: req.body?.dateMonitored,
}));
exports.review = (req, res) => gate(res) || send(res, 200, () => s.review({
  visitId: req.params.visitId, actorId: req.user.uid, expectedVersion: req.body?.expectedVersion,
  approve: req.body?.approve, reasons: req.body?.reasons, originalEvidenceReviews:req.body?.originalEvidenceReviews,
}));
