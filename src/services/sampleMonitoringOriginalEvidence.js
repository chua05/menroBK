// Original-photo policy applies only in the guarded local proposal.
const { createHash } = require("node:crypto");
const fail = (code, message, status = 409) => Object.assign(new Error(message), { status, code });
const numeric = value => value === "" || value == null ? null : Number(value);
function assessmentFingerprint(row, date) {
  return createHash("sha256").update(JSON.stringify([row.sampleId, date || null, row.condition || null,
    numeric(row.heightCentimeters), numeric(row.diameterCentimeters), String(row.remarks || "").trim(),
    row.investigationOutcome || null, String(row.searchFindings || "").trim()])).digest("hex");
}
function reviewRequirements(visit) {
  if (!(visit.sampleAssessments || []).some(row => row.evidenceHistory?.some(e => e.source === "uploaded-original"))) return [];
  require("../config/sampleMonitoringOriginalProposal").requireOriginalProposal();
  const required = [];
  for (const row of visit.sampleAssessments || []) {
    if (!row.evidenceHistory?.some(e => e.source === "uploaded-original")) continue;
    const relevant = row.evidenceHistory.filter(e => Number(e.revision) === Number(row.assessmentRevision || 0) && e.assessmentFingerprint === assessmentFingerprint(row, visit.dateMonitored));
    if (!relevant.length) throw fail("ORIGINAL_REPLACEMENT_REQUIRED", "An assessment or monitoring date changed. Save the draft and provide new relevant evidence; historical photos remain preserved.");
    for (const e of relevant.filter(e => e.source === "uploaded-original")) {
      if (!e.evidenceId || !e.privateEvidence || e.accuracyStatus !== "UNKNOWN" || e.verificationStatus !== "NEEDS_ADMIN_REVIEW") throw fail("ORIGINAL_REVIEW_INVALID", "Original evidence review information is incomplete.");
      required.push({ sampleId: row.sampleId, evidenceId: e.evidenceId, assessmentRevision: Number(row.assessmentRevision || 0) });
    }
  }
  return required;
}
function assertOriginalReview(visit, acknowledgments) {
  const required = reviewRequirements(visit);
  if (!required.length && acknowledgments === undefined) return [];
  const key = e => JSON.stringify([e?.sampleId, e?.evidenceId, e?.assessmentRevision]);
  if (!Array.isArray(acknowledgments) || acknowledgments.length !== required.length || new Set(acknowledgments.map(key)).size !== required.length || required.some(e => !acknowledgments.some(a => key(a) === key(e)))) throw fail("ORIGINAL_ADMIN_REVIEW_REQUIRED", "Explicit Admin review of each current original photo with unknown GPS accuracy is required.", 400);
  return required;
}
module.exports = { assessmentFingerprint, reviewRequirements, assertOriginalReview };
