const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../src/config/permanentSampleSchedule");

test("permanent-sample schedule is explicitly enabled and versioned", () => {
  assert.equal(policy.resolvePermanentSampleSchedule({}).enabled, false);
  assert.deepEqual(policy.resolvePermanentSampleSchedule({ PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" }), {
    enabled: true,
    policyVersion: "permanent-sample-calendar-v1",
    firstVisitRule: "ANY_NONFUTURE_ELIGIBLE_DATE",
    secondVisitIntervalMonths: 1,
    laterVisitIntervalMonths: 3,
    timeZone: "Asia/Manila",
  });
  assert.throws(() => policy.resolvePermanentSampleSchedule({ PERMANENT_SAMPLE_SCHEDULE_ENABLED: "yes" }),
    error => error.code === "PERMANENT_SAMPLE_SCHEDULE_CONFIGURATION_INVALID");
});

test("calendar-month schedule clamps month ends and preserves the planned anchor after visit two", () => {
  assert.equal(policy.addCalendarMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(policy.addCalendarMonths("2027-01-31", 1), "2027-02-28");
  assert.equal(policy.addCalendarMonths("2028-02-29", 3), "2028-05-29");
  assert.equal(policy.scheduleAfterApproval({ visitNumber: 1, dateMonitored: "2028-01-31", scheduledDueDate: "2028-01-31" }), "2028-02-29");
  assert.equal(policy.scheduleAfterApproval({ visitNumber: 2, dateMonitored: "2028-03-05", scheduledDueDate: "2028-02-29" }), "2028-05-29");
});

test("schedule status distinguishes scheduled, due, and overdue", () => {
  assert.equal(policy.scheduleStatus("2028-02-01", "2028-01-31"), "SCHEDULED");
  assert.equal(policy.scheduleStatus("2028-02-01", "2028-02-01"), "DUE");
  assert.equal(policy.scheduleStatus("2028-02-01", "2028-02-02"), "OVERDUE");
});
