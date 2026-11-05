const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addWorkingDays,
  buildProcessingEstimate,
  validateReleasePlantingOrder,
  validateFuturePlantingSchedule,
  samePlantingSchedule,
  assertExpectedVersion,
} = require("../src/utils/seedlingRequestSchedule.util");

test("working-day estimates exclude weekends and cross month/year boundaries", () => {
  assert.equal(addWorkingDays("2026-10-16", 3), "2026-10-21");
  assert.equal(addWorkingDays("2026-12-30", 3), "2027-01-06");
  assert.deepEqual(buildProcessingEstimate("2026-10-16T01:00:00Z"), {
    timezone: "Asia/Manila", submittedDate: "2026-10-16", earliestDate: "2026-10-23",
    latestDate: "2026-10-23", workingDaysMinimum: 5, workingDaysMaximum: 5,
    holidayExclusionsApplied: true, calendarVersion: "2026-11-05", calendarBasis: "currently-proclaimed-holidays", advisory: true,
  });
});

test("published holidays are excluded and unknown calendar coverage never becomes a promised date", () => {
  assert.equal(addWorkingDays("2026-12-23", 5), "2027-01-06");
  assert.throws(() => addWorkingDays("2029-01-01", 5), /calendar needs an update/);
  assert.equal(buildProcessingEstimate("2029-01-01T00:00:00Z").earliestDate, null);
});

test("planting can be on the release date but never before it", () => {
  assert.doesNotThrow(() => validateReleasePlantingOrder({ preferredReleaseDate: "2026-10-20", plantingDate: "2026-10-20" }));
  assert.throws(() => validateReleasePlantingOrder({ preferredReleaseDate: "2026-10-21", plantingDate: "2026-10-20" }), /cannot be earlier/);
});

test("expired effective release and planting schedules are rejected in Manila time", () => {
  const now = new Date("2026-10-16T04:00:00Z");
  assert.throws(() => validateFuturePlantingSchedule({ preferredReleaseDate: "2026-10-11", plantingDate: "2026-10-20", startTime: "08:00" }, now), (error) => error.code === "SCHEDULE_STALE" && error.field === "preferredReleaseDate");
  assert.throws(() => validateFuturePlantingSchedule({ preferredReleaseDate: "2026-10-15", plantingDate: "2026-10-16", startTime: "06:00" }, now), /release date is in the past/);
  assert.throws(() => validateFuturePlantingSchedule({ preferredReleaseDate: "2026-10-16", plantingDate: "2026-10-16", startTime: "06:00" }, now), (error) => error.code === "SCHEDULE_STALE" && error.field === "plantingDate");
});

test("a valid replacement and same-day release/planting schedule are accepted", () => {
  const now = new Date("2026-10-16T04:00:00Z");
  assert.doesNotThrow(() => validateFuturePlantingSchedule({ preferredReleaseDate: "2026-10-20", plantingDate: "2026-10-20", startTime: "08:00" }, now));
});

test("planting schedule comparison includes date and applicable times", () => {
  const value = { plantingDate: "2026-10-20", startTime: "08:00", endTime: "10:00" };
  assert.equal(samePlantingSchedule(value, { ...value }), true);
  assert.equal(samePlantingSchedule(value, { ...value, startTime: "09:00" }), false);
});

test("request version rejects stale and missing mutations", () => {
  assert.doesNotThrow(() => assertExpectedVersion({ requestVersion: 2 }, 2));
  assert.throws(() => assertExpectedVersion({ requestVersion: 2 }, 1), (error) => error.code === "STALE_REQUEST_VERSION");
  assert.throws(() => assertExpectedVersion({ requestVersion: 0 }), (error) => error.code === "STALE_REQUEST_VERSION");
});
