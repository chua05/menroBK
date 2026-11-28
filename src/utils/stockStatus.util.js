const STOCK_STATUS = Object.freeze({
  AVAILABLE: "Available",
  LIMITED: "Limited",
  OUT_OF_STOCK: "Out of Stock",
  NEEDS_REVIEW: "Needs Review",
});

const LIMITED_THRESHOLD_PERCENT = 30;

const isPositiveInteger = (value) =>
  value !== null && value !== undefined && value !== "" &&
  Number.isInteger(Number(value)) && Number(value) > 0;

// Total ever received for a batch. Never guessed: a restocked legacy record
// without an explicit total has no trustworthy baseline.
function resolveReceivedBaseline(record) {
  if (!record) return null;
  if (isPositiveInteger(record.totalReceivedQuantity)) return Number(record.totalReceivedQuantity);
  if (isPositiveInteger(record.initialQuantity) && !(Number(record.replenishmentCycle) > 0)) {
    // Restocks before replenishmentCycle existed left no marker, so require exact
    // conservation: available + distributed + reserved === initial.
    const current = record.currentQuantity ?? record.availableQuantity;
    const parts = [current, record.distributedQuantity ?? 0, record.reservedQuantity ?? 0].map(Number);
    const valid = current !== undefined && current !== null &&
      parts.every((n) => Number.isInteger(n) && n >= 0);
    if (valid && parts[0] + parts[1] + parts[2] === Number(record.initialQuantity)) {
      return Number(record.initialQuantity);
    }
  }
  return null;
}

function calculateStockStatus(currentQuantity, totalReceived) {
  const current = Number(currentQuantity ?? 0);
  if (!(current > 0)) return STOCK_STATUS.OUT_OF_STOCK;
  if (!isPositiveInteger(totalReceived)) return STOCK_STATUS.NEEDS_REVIEW;
  const total = Number(totalReceived);
  if (current > total) return STOCK_STATUS.NEEDS_REVIEW;
  return current * 100 <= total * LIMITED_THRESHOLD_PERCENT
    ? STOCK_STATUS.LIMITED
    : STOCK_STATUS.AVAILABLE;
}

function stockStatusForRecord(record) {
  const current = Number(record?.currentQuantity ?? record?.availableQuantity ?? 0);
  const baseline = resolveReceivedBaseline(record);
  const status = calculateStockStatus(current, baseline);
  let baselineIssue = null;
  if (baseline === null) {
    baselineIssue = "Total received quantity is missing or invalid.";
  } else if (current > baseline) {
    baselineIssue = "Current quantity exceeds total received quantity.";
  }
  return {
    status,
    currentQuantity: current,
    totalReceivedQuantity: baseline,
    remainingPercent: baseline === null ? null : (current / baseline) * 100,
    baselineIssue,
  };
}

module.exports = {
  STOCK_STATUS, LIMITED_THRESHOLD_PERCENT,
  resolveReceivedBaseline, calculateStockStatus, stockStatusForRecord,
};
