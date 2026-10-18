const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEarlyMonitoringPolicy, earlyScheduleStatus, shiftCalendarDate } = require("../src/utils/earlyMonitoring.util");
const { validateMonitoringEvidenceTimestamp } = require("../src/utils/monitoringEvidenceTimestamp.util");
const { isValidatedMonitoringObservation } = require("../src/utils/monitoringObservation.util");

const env = { EARLY_MONITORING_ACTIVATION_AT: "2026-10-01T00:00:00+08:00" };

test("early opening uses later of submission plus three days and verification", () => {
  const early = buildEarlyMonitoringPolicy({ originalSubmittedAt: "2026-10-15T08:00:00+08:00",
    verifiedAt: "2026-10-16T08:00:00+08:00", officialOpeningDate: "2026-11-01" }, env);
  assert.equal(early.openingDate, "2026-10-18");
  assert.equal(early.deadlineDate, "2026-10-24");
  assert.equal(earlyScheduleStatus(early, "2026-10-25"), "Overdue");
  assert.equal(earlyScheduleStatus(early, "2026-11-01"), "Closed");
});

test("late verification controls opening and non-applicable windows", () => {
  const early = buildEarlyMonitoringPolicy({ originalSubmittedAt: "2026-10-15T08:00:00+08:00",
    verifiedAt: "2026-10-25T08:00:00+08:00", officialOpeningDate: "2026-10-24" }, env);
  assert.equal(early.openingDate, "2026-10-25");
  assert.equal(early.applicable, false);
});

test("activation is fail closed", () => {
  assert.equal(buildEarlyMonitoringPolicy({ originalSubmittedAt: new Date(), verifiedAt: new Date(),
    officialOpeningDate: shiftCalendarDate("2026-10-15", 14) }, {}), null);
});

test("early observations never qualify as official validated observations", () => {
  assert.equal(isValidatedMonitoringObservation({ workflowVersion: 2, observationType: "early",
    reviewStatus: "Approved", adminDecision: "Approve", adminDecidedBy: "admin", adminDecidedAt: {} }), false);
});

test("capture timestamp must match monitored Manila date and not be future", () => {
  const valid = validateMonitoringEvidenceTimestamp({ capturedAt: "2026-10-18T09:00:00+08:00",
    captureOffset: "+08:00" }, "2026-10-18", new Date("2026-10-20T00:00:00Z"));
  assert.equal(valid.captureDateManila, "2026-10-18");
  assert.throws(() => validateMonitoringEvidenceTimestamp({}, "2026-10-18"), /capture timestamp/);
  assert.throws(() => validateMonitoringEvidenceTimestamp({ capturedAt: "2026-10-19T00:00:00+08:00",
    captureOffset: "+08:00" }, "2026-10-18", new Date("2026-10-20T00:00:00Z")), /dates must match/);
  assert.throws(() => validateMonitoringEvidenceTimestamp({ capturedAt: "2026-10-21T00:00:00+08:00",
    captureOffset: "+08:00" }, "2026-10-21", new Date("2026-10-20T00:00:00Z")), /future/);
});

test("timezone-naive capture timestamps are interpreted as Manila camera time", () => {
  const result = validateMonitoringEvidenceTimestamp({
    capturedAt: "2026-10-18T23:59:59",
  }, "2026-10-18", new Date("2026-10-19T00:00:00Z"));

  assert.equal(result.captureDateManila, "2026-10-18");
  assert.equal(result.captureTimezoneSource, "Assumed Asia/Manila (timezone-naive EXIF)");
});

test("offset-aware capture timestamps use the Manila calendar date across midnight", () => {
  const result = validateMonitoringEvidenceTimestamp({
    capturedAt: "2026-10-18T18:30:00Z",
    captureOffset: "+00:00",
  }, "2026-10-19", new Date("2026-10-19T00:00:00Z"));

  assert.equal(result.captureDateManila, "2026-10-19");
  assert.equal(result.captureTimezoneSource, "EXIF offset");
});
