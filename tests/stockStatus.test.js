const assert = require("node:assert/strict");
const test = require("node:test");
const {
  STOCK_STATUS, LIMITED_THRESHOLD_PERCENT, resolveReceivedBaseline,
  calculateStockStatus, stockStatusForRecord,
} = require("../src/utils/stockStatus.util");

test("constants", () => {
  assert.equal(LIMITED_THRESHOLD_PERCENT, 30);
  assert.deepEqual(STOCK_STATUS, { AVAILABLE: "Available", LIMITED: "Limited", OUT_OF_STOCK: "Out of Stock", NEEDS_REVIEW: "Needs Review" });
});

test("100 received boundaries", () => {
  assert.equal(calculateStockStatus(31, 100), "Available");
  assert.equal(calculateStockStatus(30, 100), "Limited");
  assert.equal(calculateStockStatus(1, 100), "Limited");
  assert.equal(calculateStockStatus(0, 100), "Out of Stock");
  assert.equal(calculateStockStatus(100, 100), "Available");
});

test("no rounding of percentages", () => {
  assert.equal(calculateStockStatus(2, 7), "Limited");
  assert.equal(calculateStockStatus(3, 10), "Limited");
  assert.equal(calculateStockStatus(4, 10), "Available");
});

test("missing or invalid baseline", () => {
  assert.equal(calculateStockStatus(5, null), "Needs Review");
  assert.equal(calculateStockStatus(5, 0), "Needs Review");
  assert.equal(calculateStockStatus(0, null), "Out of Stock");
  assert.equal(calculateStockStatus(11, 10), "Needs Review");
  assert.equal(calculateStockStatus(0, 10), "Out of Stock");
});

test("resolveReceivedBaseline", () => {
  assert.equal(resolveReceivedBaseline({ totalReceivedQuantity: 150, initialQuantity: 100, replenishmentCycle: 2 }), 150);
  assert.equal(resolveReceivedBaseline({ initialQuantity: 100, currentQuantity: 100 }), 100);
  assert.equal(resolveReceivedBaseline({ initialQuantity: 100, currentQuantity: 60, distributedQuantity: 40, replenishmentCycle: 0 }), 100);
  assert.equal(resolveReceivedBaseline({ initialQuantity: 100, replenishmentCycle: 1 }), null);
  assert.equal(resolveReceivedBaseline({ totalReceivedQuantity: 0, initialQuantity: 0 }), null);
  assert.equal(resolveReceivedBaseline({ totalReceivedQuantity: -5 }), null);
  assert.equal(resolveReceivedBaseline({ totalReceivedQuantity: 2.5 }), null);
  assert.equal(resolveReceivedBaseline({ initialQuantity: 10.5 }), null);
  assert.equal(resolveReceivedBaseline({}), null);
  assert.equal(resolveReceivedBaseline(null), null);
});

test("stockStatusForRecord", () => {
  const ok = stockStatusForRecord({ currentQuantity: 30, totalReceivedQuantity: 100 });
  assert.deepEqual(ok, { status: "Limited", currentQuantity: 30, totalReceivedQuantity: 100, remainingPercent: 30, baselineIssue: null });
  const legacy = stockStatusForRecord({ currentQuantity: 5, initialQuantity: 100, replenishmentCycle: 1 });
  assert.equal(legacy.status, "Needs Review");
  assert.equal(legacy.totalReceivedQuantity, null);
  assert.equal(legacy.remainingPercent, null);
  assert.ok(legacy.baselineIssue);
  const fallback = stockStatusForRecord({ availableQuantity: 50, distributedQuantity: 50, initialQuantity: 100 });
  assert.equal(fallback.status, "Available");
  assert.equal(stockStatusForRecord({ currentQuantity: 0, initialQuantity: 100, replenishmentCycle: 3 }).status, "Out of Stock");
  assert.equal(stockStatusForRecord({ currentQuantity: 9, totalReceivedQuantity: 5 }).status, "Needs Review");
});

test("baseline from initialQuantity requires exact conservation", () => {
  const sr = stockStatusForRecord;
  assert.equal(sr({ initialQuantity: 100, currentQuantity: 30, distributedQuantity: 70 }).status, "Limited");
  assert.equal(sr({ initialQuantity: 100, currentQuantity: 20, distributedQuantity: 70, reservedQuantity: 10 }).status, "Limited");
  assert.equal(sr({ initialQuantity: 100, currentQuantity: 100 }).status, "Available");
  // restocked before replenishmentCycle existed: 100 + 200 received, 250 distributed
  const prePatch = { initialQuantity: 100, currentQuantity: 50, distributedQuantity: 250 };
  assert.equal(sr(prePatch).status, "Needs Review");
  assert.equal(resolveReceivedBaseline(prePatch), null);
  assert.equal(sr({ initialQuantity: 100, currentQuantity: 30, distributedQuantity: 60 }).status, "Needs Review");
  assert.equal(resolveReceivedBaseline({ initialQuantity: 100, currentQuantity: 30, distributedQuantity: 70.5 }), null);
  assert.equal(resolveReceivedBaseline({ initialQuantity: 100, currentQuantity: 30, distributedQuantity: -1, reservedQuantity: 71 }), null);
  assert.equal(resolveReceivedBaseline({ totalReceivedQuantity: 300, initialQuantity: 100, currentQuantity: 50, distributedQuantity: 250 }), 300);
});
