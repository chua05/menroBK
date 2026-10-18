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
  nextMonitoringDateForObservation,
  officialNextMonitoringDate,
  hasOutstandingObservation,
} = require("../src/services/monitoring.service");

test("monitoring dates use calendar-safe date-only calculations", () => {
  assert.equal(addDays("2026-01-17", 14), "2026-01-31");
  assert.equal(addCalendarMonth("2026-01-31"), "2026-02-28");
  assert.equal(addCalendarMonth("2028-01-31"), "2028-02-29");
  assert.equal(addCalendarMonth("2026-12-31"), "2027-01-31");
  assert.equal(addYears("2028-02-29", 2), "2030-02-28");
});

test("partial observations do not advance or create a cohort schedule", () => {
  assert.equal(nextMonitoringDateForObservation({
    currentNextMonitoringDate: null, fullHistoryCount: 0,
    monitoredDate: "2026-01-20", isFullCohortAssessment: false,
  }), null);
  assert.equal(nextMonitoringDateForObservation({
    currentNextMonitoringDate: "2026-02-20", fullHistoryCount: 1,
    monitoredDate: "2026-02-10", isFullCohortAssessment: false,
  }), "2026-02-20");
  assert.equal(nextMonitoringDateForObservation({
    currentNextMonitoringDate: null, fullHistoryCount: 0,
    monitoredDate: "2026-01-20", isFullCohortAssessment: true,
  }), "2026-02-24");
});

test("monitoring lifecycle statuses are derived from server dates and history", () => {
  const lifecycle = {
    quantityPlanted: 10,
    startMonitoringDate: "2026-01-15",
    nextMonitoringDate: null,
    monitoringEndDate: "2028-01-01",
    history: [],
  };

  assert.equal(lifecycleStatus(lifecycle, "2026-01-14"), "Not Yet Available");
  assert.equal(lifecycleStatus(lifecycle, "2026-01-15"), "Available for Monitoring");
  const fullObservation = { totalMonitored: 10, cohortQuantityAtObservation: 10,
    monitoredDate: "2026-01-16", reviewStatus: "Validated" };
  assert.equal(lifecycleStatus({ ...lifecycle, history: [fullObservation], nextMonitoringDate: "2026-02-20" }, "2026-02-19"), "Next Monitoring Scheduled");
  assert.equal(lifecycleStatus({ ...lifecycle, history: [fullObservation], nextMonitoringDate: "2026-02-20" }, "2026-02-20"), "Available for Monitoring");
  assert.equal(lifecycleStatus({ ...lifecycle, history: [fullObservation], nextMonitoringDate: null }, "2027-12-31"), "Available for Monitoring");
  assert.equal(lifecycleStatus({ ...lifecycle, history: [fullObservation], nextMonitoringDate: null }, "2026-02-01"), "Next Monitoring Scheduled");
  assert.equal(lifecycleStatus({ ...lifecycle, history: [{ totalMonitored: 4, cohortQuantityAtObservation: 10 }], nextMonitoringDate: null }, "2026-01-15"), "Available for Monitoring");
  assert.equal(lifecycleStatus(lifecycle, "2028-01-01"), "Monitoring Completed");
});

test("only approved full observations advance the official schedule", () => {
  const lifecycle = { quantityPlanted: 10 };
  const full = { workflowVersion: 2, totalMonitored: 10, cohortQuantityAtObservation: 10,
    monitoredDate: "2026-01-20", reviewStatus: "Pending Review", reviewVersion: 0 };
  assert.equal(officialNextMonitoringDate([full], lifecycle), null);
  assert.equal(officialNextMonitoringDate([{ ...full, reviewStatus: "Reviewed" }], lifecycle), null);
  assert.equal(officialNextMonitoringDate([{ ...full, reviewStatus: "Rejected" }], lifecycle), null);
  assert.equal(officialNextMonitoringDate([{ ...full, reviewStatus: "Approved",
    adminDecision: "Approve", adminDecidedBy: "admin-1", adminDecidedAt: { seconds: 1 } }], lifecycle),
  "2026-02-24");
  assert.equal(officialNextMonitoringDate([{ ...full, totalMonitored: 4,
    isFullCohortAssessment: false, reviewStatus: "Approved", adminDecision: "Approve",
    adminDecidedBy: "admin-1", adminDecidedAt: { seconds: 1 } }], lifecycle), null);
});

test("unresolved Phase 2 observations are guarded independently from scheduling", () => {
  for (const reviewStatus of ["Pending Review", "Reviewed", "Returned for Rechecking"]) {
    assert.equal(hasOutstandingObservation([{ workflowVersion: 2, reviewStatus }]), true);
  }
  assert.equal(hasOutstandingObservation([{ workflowVersion: 2, reviewStatus: "Rejected" }]), false);
  assert.equal(hasOutstandingObservation([{ workflowVersion: 2, reviewStatus: "Approved" }]), false);
});
