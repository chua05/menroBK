// Participant-facing Planting Report notification wording.
// Participants see their report as "Submitted" for the whole internal review: Staff review and
// Admin verification are internal steps, so Participant notices never say Reviewed, Approved,
// Completed or Verified. Stored statuses, reviewer/verifier identities and audit logs are
// unchanged. Returned and Rejected notices stay explicit because the Participant must act on
// (or know about) those outcomes.
const PARTICIPANT_PLANTING_NOTICES = Object.freeze({
  submitted: Object.freeze({
    title: "Planting Report Submitted",
    message: (subject = "Your planting report") => `${subject} was submitted to MENRO.`,
  }),
  // Sent when MENRO Admin verifies a Participant submission (stored stage: Completed).
  recorded: Object.freeze({
    title: "Planting Report Recorded",
    message: "MENRO has recorded your planting report. No further action is needed.",
  }),
});

// Words that reveal internal review progress and must not appear in Participant notices
// other than Returned/Rejected outcomes.
const INTERNAL_STATUS_WORDS = /\b(reviewed|approved|approval|completed|verified|verification|forwarded)\b/i;

module.exports = { PARTICIPANT_PLANTING_NOTICES, INTERNAL_STATUS_WORDS };
