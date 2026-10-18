const assert = require("node:assert/strict");
const test = require("node:test");

const {
  monitoringObservationTotal,
  isFullCohortObservation,
  monitoringCoverageClassification,
  isValidatedMonitoringObservation,
  monitoringApprovalBasis,
  officialNextMonitoringDate,
} = require("../src/utils/monitoringObservation.util");

test("partial observation coverage is explicit and unassessed trees are not counted", () => {
  const observation = {
    healthyCount: 20,
    damagedCount: 3,
    deadCount: 2,
    totalMonitored: 25,
    cohortQuantityAtObservation: 100,
  };
  assert.equal(monitoringObservationTotal(observation), 25);
  assert.equal(isFullCohortObservation(observation, { quantityPlanted: 100 }), false);
  assert.equal(((observation.healthyCount + observation.damagedCount) / observation.totalMonitored) * 100, 92);
  assert.equal((observation.deadCount / observation.totalMonitored) * 100, 8);
});

test("legacy validated full observations reconstruct a missing schedule without fabrication", () => {
  assert.equal(officialNextMonitoringDate({ quantityPlanted: 10, history: [
    { reviewStatus: "Validated", monitoredDate: "2026-01-31", totalMonitored: 10 },
  ] }), "2026-03-07");
  assert.equal(officialNextMonitoringDate({ quantityPlanted: 10, history: [
    { reviewStatus: "Validated", totalMonitored: 10 },
  ] }), null);
});

test("Phase 2 requires an Admin final approval while legacy validation stays explicit", () => {
  const reviewed = { workflowVersion: 2, reviewStatus: "Reviewed", staffReviewedBy: "staff-1" };
  assert.equal(isValidatedMonitoringObservation(reviewed), false);
  const approved = { ...reviewed, reviewStatus: "Approved", adminDecision: "Approve",
    adminDecidedBy: "admin-1", adminDecidedAt: { seconds: 1 } };
  assert.equal(isValidatedMonitoringObservation(approved), true);
  assert.equal(monitoringApprovalBasis(approved), "Admin Approved");
  assert.equal(monitoringApprovalBasis({ reviewStatus: "Reviewed" }, { reviewStatus: "Reviewed" }),
    "Legacy Validated");
});

test("coverage classification keeps unknown legacy observations distinct from partial samples", () => {
  assert.equal(monitoringCoverageClassification(
    { healthyCount: 3, damagedCount: 1, deadCount: 1 }, {}
  ), "unknown");
  assert.equal(monitoringCoverageClassification(
    { totalMonitored: 5, cohortQuantityAtObservation: 10 }, {}
  ), "partial");
});

test("legacy observations infer totals and full-cohort coverage without migration", () => {
  const legacy = { healthyCount: 70, damagedCount: 5, deadCount: 25 };
  assert.equal(monitoringObservationTotal(legacy), 100);
  assert.equal(isFullCohortObservation(legacy, { quantityPlanted: 100 }), true);
  assert.equal(isFullCohortObservation(legacy, { quantityPlanted: 120 }), false);
});
