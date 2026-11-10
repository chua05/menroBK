// Planting report review workflow.
//
// `staffReviewStatus` remains the quantity-ledger state used by balances,
// analytics and cohorts ("Pending Review" | "Accepted" | "Rejected" |
// "Not Required"). `workflowStatus` is the review stage shown to people:
//
//   Participant: Pending Review -> Reviewed (Staff forwarded) -> Completed | Rejected (Admin)
//                Pending Review -> Returned for Correction (Staff)
//   Staff:       Pending Admin Approval -> Completed | Rejected | Returned for Correction (Admin)
//
// Returned and Rejected submissions both release their quantities
// (staffReviewStatus "Rejected"); only Returned ones may be corrected.
const WORKFLOW_STATUS = Object.freeze({
  PENDING_REVIEW: "Pending Review",
  REVIEWED: "Reviewed",
  PENDING_ADMIN_APPROVAL: "Pending Admin Approval",
  RETURNED: "Returned for Correction",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
});

const KNOWN = new Set(Object.values(WORKFLOW_STATUS));

// Records written before this workflow carry no workflowStatus; derive it from
// the ledger state without rewriting history. Legacy official Staff rejections
// were always correctable ("returned for correction"), so they stay correctable.
function deriveWorkflowStatus(entry = {}) {
  if (KNOWN.has(entry.workflowStatus)) return entry.workflowStatus;
  const official = entry.officialStaffReport === true;
  switch (entry.staffReviewStatus) {
    case "Accepted":
    case "Not Required":
      return WORKFLOW_STATUS.COMPLETED;
    case "Rejected":
      return official ? WORKFLOW_STATUS.RETURNED : WORKFLOW_STATUS.REJECTED;
    default:
      return official ? WORKFLOW_STATUS.PENDING_ADMIN_APPROVAL : WORKFLOW_STATUS.PENDING_REVIEW;
  }
}

// Standalone (pre-event) reports keep their stage on the report document.
function deriveStandaloneWorkflowStatus(report = {}, normalizedStatus = "") {
  if (KNOWN.has(report.workflowStatus)) return report.workflowStatus;
  if (normalizedStatus === "Approved") return WORKFLOW_STATUS.COMPLETED;
  if (normalizedStatus === "Rejected") return WORKFLOW_STATUS.REJECTED;
  return WORKFLOW_STATUS.PENDING_REVIEW;
}

const fail = (status, message, fieldErrors) =>
  Object.assign(new Error(message), { status, ...(fieldErrors ? { fieldErrors } : {}) });

const MAX_REASON_LENGTH = 1000;

function requiredReason(value, label) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason) throw fail(400, `A ${label} reason is required.`, { remarks: `Enter the ${label} reason.` });
  if (reason.length > MAX_REASON_LENGTH) {
    throw fail(400, `The ${label} reason must be at most ${MAX_REASON_LENGTH} characters.`,
      { remarks: `Use at most ${MAX_REASON_LENGTH} characters.` });
  }
  return reason;
}

function optionalRemarks(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw fail(400, "Remarks must be text.");
  const remarks = value.trim();
  if (remarks.length > MAX_REASON_LENGTH) throw fail(400, `Remarks must be at most ${MAX_REASON_LENGTH} characters.`, { remarks: `Use at most ${MAX_REASON_LENGTH} characters.` });
  return remarks;
}

module.exports = {
  WORKFLOW_STATUS,
  MAX_REASON_LENGTH,
  deriveWorkflowStatus,
  deriveStandaloneWorkflowStatus,
  requiredReason,
  optionalRemarks,
  fail,
};
