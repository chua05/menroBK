const assert = require("node:assert/strict");
const test = require("node:test");

const schedule = require("../src/config/permanentSampleSchedule");

test("permanent-sample scheduling is opt-in and invalid deployment values fail closed", () => {
  assert.equal(schedule.resolvePermanentSampleSchedule({}).enabled, false);
  assert.equal(schedule.resolvePermanentSampleSchedule({
    NODE_ENV: "production",
    PERMANENT_SAMPLE_SCHEDULE_ENABLED: "false",
  }).enabled, false);
  assert.equal(schedule.resolvePermanentSampleSchedule({
    NODE_ENV: "production",
    PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true",
  }).enabled, true);
  assert.throws(
    () => schedule.resolvePermanentSampleSchedule({
      NODE_ENV: "production",
      PERMANENT_SAMPLE_SCHEDULE_ENABLED: "yes",
    }),
    error => error.code === "PERMANENT_SAMPLE_SCHEDULE_CONFIGURATION_INVALID" &&
      error.status === 503
  );
});

test("calendar-month scheduling clamps month ends and crosses leap years without drift", () => {
  assert.equal(schedule.addCalendarMonths("2027-01-31", 1), "2027-02-28");
  assert.equal(schedule.addCalendarMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(schedule.addCalendarMonths("2028-02-29", 12), "2029-02-28");
  assert.equal(schedule.addCalendarMonths("2027-11-30", 3), "2028-02-29");
  assert.equal(schedule.addCalendarMonths("2027-12-31", 3), "2028-03-31");
  assert.throws(() => schedule.addCalendarMonths("2027-02-29", 1));
  assert.throws(() => schedule.addCalendarMonths("2027-01-01", -1));
});

test("visit two anchors to first actual date and later visits retain their planned cadence", () => {
  assert.equal(schedule.scheduleAfterApproval({
    visitNumber: 1,
    dateMonitored: "2027-01-31",
    scheduledDueDate: "2027-01-15",
  }), "2027-02-28");
  assert.equal(schedule.scheduleAfterApproval({
    visitNumber: 2,
    dateMonitored: "2027-03-03",
    scheduledDueDate: "2027-02-28",
  }), "2027-05-28");
  assert.equal(schedule.scheduleAfterApproval({
    visitNumber: 3,
    dateMonitored: "2027-06-05",
    scheduledDueDate: "2027-05-28",
  }), "2027-08-28");
});

test("schedule status distinguishes pending, scheduled, due, and overdue dates", () => {
  assert.equal(schedule.scheduleStatus(""), "POLICY_PENDING");
  assert.equal(schedule.scheduleStatus("2027-05-02", "2027-05-01"), "SCHEDULED");
  assert.equal(schedule.scheduleStatus("2027-05-01", "2027-05-01"), "DUE");
  assert.equal(schedule.scheduleStatus("2027-04-30", "2027-05-01"), "OVERDUE");
});
