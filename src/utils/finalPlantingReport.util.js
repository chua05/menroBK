// One final Planting Report per planting event (submissionWorkflowVersion 4).
//
// A final report covers every released seedling type that still has an
// unreported balance. Per type: Final Planted = Remaining - Final Leftovers,
// computed here, never taken from the client. Each type is stored as its own
// plantingContributions row (so balances, analytics and cohorts stay
// per-species), and all rows of one submission share `finalReportGroupId` and
// are reviewed together. `finalReportId` is the stable logical report ID for
// the event; corrections and resubmissions after rejection are new revisions
// of it. Older records (versions 2/3) keep their per-row behaviour.
const { WORKFLOW_STATUS, deriveWorkflowStatus } = require("./plantingReviewWorkflow.util");
const { wholeQuantity } = require("./plantingBalance.util");

const FINAL_REPORT_VERSION = 4;
const MAX_LEFTOVER_REASON_LENGTH = 500;
const MAX_FINAL_ITEMS = 20;

const fail = (status, message, fieldErrors) =>
  Object.assign(new Error(message), { status, ...(fieldErrors ? { fieldErrors } : {}) });

const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function finalReportIdFor(eventId) {
  return `FPR-${eventId}`;
}

function isFinalReportRow(row = {}) {
  return Number(row.submissionWorkflowVersion) === FINAL_REPORT_VERSION && Boolean(row.finalReportGroupId);
}

// Shape-only validation of client items: [{ inventoryId, leftoverQuantity, leftoverReason }].
function parseFinalItems(input) {
  let items = input;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { throw fail(400, "Seedling quantities could not be read.", { items: "Refresh the form and try again." }); }
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_FINAL_ITEMS) {
    throw fail(400, "Report every released seedling type.", { items: "Report every released seedling type." });
  }
  const seen = new Set();
  return items.map((item, index) => {
    const inventoryId = item?.inventoryId;
    if (!safeId(inventoryId) || seen.has(inventoryId)) {
      throw fail(400, "Report each released seedling type once.", { items: "Report each released seedling type once." });
    }
    seen.add(inventoryId);
    const leftoverValue = item.leftoverQuantity === undefined || item.leftoverQuantity === "" ? 0 : item.leftoverQuantity;
    if (!wholeQuantity(leftoverValue)) {
      throw fail(400, "Leftovers must be a nonnegative whole number.", { [`leftoverQuantity-${index}`]: "Enter a nonnegative whole number." });
    }
    const leftoverQuantity = Number(leftoverValue);
    if (item.leftoverReason !== undefined && item.leftoverReason !== null && typeof item.leftoverReason !== "string") {
      throw fail(400, "The leftover reason must be text.", { [`leftoverReason-${index}`]: "Enter the reason as text." });
    }
    const leftoverReason = String(item.leftoverReason || "").trim();
    if (leftoverQuantity > 0 && !leftoverReason) {
      throw fail(400, "Enter the reason for the leftover seedlings.", { [`leftoverReason-${index}`]: "Enter the reason for the leftover seedlings." });
    }
    if (leftoverReason.length > MAX_LEFTOVER_REASON_LENGTH) {
      throw fail(400, `The leftover reason must be at most ${MAX_LEFTOVER_REASON_LENGTH} characters.`, { [`leftoverReason-${index}`]: `Use at most ${MAX_LEFTOVER_REASON_LENGTH} characters.` });
    }
    return { inventoryId, leftoverQuantity, leftoverReason: leftoverQuantity > 0 ? leftoverReason : "" };
  });
}

// `balances`: [{ inventoryId, species, remaining }] from the authoritative
// release/event ledger. The report must cover exactly the types that still
// have a balance (legacy partial reports: only what is still unreported).
function finalRowsFor(items, balances) {
  const open = balances.filter((entry) => Number(entry.remaining) > 0);
  if (open.length === 0) throw fail(409, "No seedlings remain to be reported for this planting event.");
  const byId = new Map(items.map((item) => [item.inventoryId, item]));
  const missing = open.filter((entry) => !byId.has(entry.inventoryId));
  const extra = items.filter((item) => !open.some((entry) => entry.inventoryId === item.inventoryId));
  if (missing.length || extra.length) {
    throw fail(409, "The final planting report must include every released seedling type with a remaining balance. Refresh and try again.",
      { items: "Include every released seedling type exactly once." });
  }
  return open.map((entry) => {
    const item = byId.get(entry.inventoryId);
    const remaining = Number(entry.remaining);
    if (item.leftoverQuantity > remaining) {
      throw fail(409, `Leftovers for ${entry.species || "a seedling type"} cannot exceed the ${remaining} seedlings remaining.`,
        { items: "Leftovers cannot exceed the remaining balance." });
    }
    return { inventoryId: entry.inventoryId, species: entry.species || "", remaining,
      quantity: remaining - item.leftoverQuantity, leftoverQuantity: item.leftoverQuantity, leftoverReason: item.leftoverReason };
  });
}

// A final-report row still in play: pending review/approval or Completed.
function isActiveFinalRow(row = {}) {
  if (!isFinalReportRow(row) || row.correctedBySubmission) return false;
  const stage = deriveWorkflowStatus(row);
  return stage !== WORKFLOW_STATUS.RETURNED && stage !== WORKFLOW_STATUS.REJECTED;
}

function assertNoActiveFinalReport(rows, { correctionGroupId = "" } = {}) {
  if (rows.some((row) => isActiveFinalRow(row) && row.finalReportGroupId !== correctionGroupId)) {
    throw fail(409, "A final planting report for this event is already pending review or approved.");
  }
}

function nextFinalRevision(rows) {
  const revisions = rows.filter(isFinalReportRow).map((row) => Number(row.finalReportRevision || 0));
  return revisions.length ? Math.max(...revisions) + 1 : 0;
}

// The rows of one final-report submission, in a stable order.
function sortGroupRows(rows) {
  return [...rows].sort((a, b) => Number(a.finalReportGroupIndex || 0) - Number(b.finalReportGroupIndex || 0) ||
    String(a.id).localeCompare(String(b.id)));
}

module.exports = {
  FINAL_REPORT_VERSION,
  MAX_LEFTOVER_REASON_LENGTH,
  finalReportIdFor,
  isFinalReportRow,
  parseFinalItems,
  finalRowsFor,
  isActiveFinalRow,
  assertNoActiveFinalReport,
  nextFinalRevision,
  sortGroupRows,
};
