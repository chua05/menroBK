const test = require("node:test");
const assert = require("node:assert/strict");
const { lifecycleStatus } = require("../src/services/monitoring.service");
const registration = require("../src/services/monitoringLifecycleRegistration.service");

test("a registered lifecycle awaiting a MENRO monitoring policy is never available for monitoring", () => {
  assert.equal(lifecycleStatus({ scheduleStatus: "AWAITING_MONITORING_POLICY", startMonitoringDate: null, monitoringEndDate: null, history: [] }, "2026-11-18"), "Awaiting Monitoring Setup");
  // Existing aggregate schedules are unchanged.
  assert.equal(lifecycleStatus({ startMonitoringDate: "2026-12-01", monitoringEndDate: "2028-11-17", history: [] }, "2026-11-18"), "Not Yet Available");
  assert.equal(lifecycleStatus({ startMonitoringDate: "2026-10-15", monitoringEndDate: "2028-10-01", history: [] }, "2026-11-18"), "Available for Monitoring");
});

test("registration eligibility follows verification and the stored monitoring method", () => {
  const verified = { reportingProgress: "Completed", reportingPolicy: { monitoring: "STAFF_SPOT_CHECK" } };
  assert.equal(registration.eligible(verified), true);
  assert.equal(registration.monitoringMethodOf(verified), "STAFF_SPOT_CHECK");
  assert.equal(registration.monitoringMethodOf({ reportingProgress: "Completed" }), "LEGACY");
  assert.equal(registration.eligible({ reportingProgress: "Completed", reportingPolicy: { monitoring: "NONE" } }), false);
  assert.equal(registration.eligible({ reportingProgress: "Awaiting Submission", verificationStatus: "Pending" }), false);
  assert.equal(registration.eligible({ ...verified, archived: true }), false);
  assert.equal(registration.eligible({ verificationStatus: "Approved", reportingPolicy: { monitoring: "PERMANENT_SAMPLE" } }), true);
});
