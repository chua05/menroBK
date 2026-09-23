const assert = require("node:assert/strict");
const test = require("node:test");

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: { db: { collection: () => ({}) } },
};

const {
  addDays,
  addCalendarMonth,
  addYears,
  lifecycleStatus,
} = require("../src/services/monitoring.service");

test("monitoring dates use calendar-safe date-only calculations", () => {
  assert.equal(addDays("2026-01-17", 14), "2026-01-31");
  assert.equal(addCalendarMonth("2026-01-31"), "2026-02-28");
  assert.equal(addCalendarMonth("2028-01-31"), "2028-02-29");
  assert.equal(addCalendarMonth("2026-12-31"), "2027-01-31");
  assert.equal(addYears("2028-02-29", 2), "2030-02-28");
});

test("monitoring lifecycle statuses are derived from server dates and history", () => {
  const lifecycle = {
    startMonitoringDate: "2026-01-15",
    nextMonitoringDate: null,
    monitoringEndDate: "2028-01-01",
    history: [],
  };

  assert.equal(lifecycleStatus(lifecycle, "2026-01-14"), "Not Yet Available");
  assert.equal(lifecycleStatus(lifecycle, "2026-01-15"), "Available for Monitoring");
  assert.equal(lifecycleStatus({ ...lifecycle, history: [{}], nextMonitoringDate: "2026-02-20" }, "2026-02-19"), "Next Monitoring Scheduled");
  assert.equal(lifecycleStatus({ ...lifecycle, history: [{}], nextMonitoringDate: "2026-02-20" }, "2026-02-20"), "Available for Monitoring");
  assert.equal(lifecycleStatus({ ...lifecycle, history: [{}], nextMonitoringDate: null }, "2027-12-31"), "Next Monitoring Scheduled");
  assert.equal(lifecycleStatus(lifecycle, "2028-01-01"), "Monitoring Completed");
});
