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

test("registration reads nested approved policy definitions without changing them", () => {
  for (const method of ["STAFF_SPOT_CHECK", "PERMANENT_SAMPLE", "PENDING_MENRO_POLICY", "NONE"]) {
    const report = { verificationStatus: "Completed", reportingPolicy: { policyVersion: 7, definition: { monitoring: method } } };
    const original = structuredClone(report);
    assert.equal(registration.monitoringMethodOf(report), method);
    assert.equal(registration.eligible(report), method !== "NONE");
    assert.equal(registration.monitoringPolicyResolution(report).source, "reportingPolicy.definition.monitoring");
    assert.deepEqual(report, original);
    assert.equal(registration.monitoringMethodOf({ ...report, reportingPolicy: { ...report.reportingPolicy, monitoring: method } }), method);
  }
});

test("conflicting flat and nested policies never silently register a method or exemption", () => {
  for (const [flat, nested] of [["NONE", "STAFF_SPOT_CHECK"], ["PERMANENT_SAMPLE", "STAFF_SPOT_CHECK"], ["STAFF_SPOT_CHECK", "NONE"], [123, "STAFF_SPOT_CHECK"]]) {
    const report = { verificationStatus: "Approved", reportingPolicy: { monitoring: flat, definition: { monitoring: nested } } };
    const original = structuredClone(report);
    assert.deepEqual(registration.monitoringPolicyResolution(report), { method: "UNSPECIFIED", conflict: true, source: "conflict" });
    assert.equal(registration.eligible(report), false);
    assert.deepEqual(report, original);
  }
});
