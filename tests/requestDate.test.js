const assert = require("node:assert/strict");
const test = require("node:test");
const { validatePreferredReleaseDate, validateProposedEventDate, validatePlantingSchedule } = require("../src/utils/requestDate.util");

test("preferred release date rejects yesterday and accepts today or the future", () => {
  const today = "2026-09-23";
  assert.match(validatePreferredReleaseDate("2026-09-22", today), /cannot be in the past/);
  assert.equal(validatePreferredReleaseDate(today, today), "");
  assert.equal(validatePreferredReleaseDate("2026-09-24", today), "");
});

test("proposed event date rejects only a past year", () => {
  const today = "2026-09-23";
  assert.match(validateProposedEventDate("2025-12-31", today), /past year/);
  assert.equal(validateProposedEventDate("2026-01-01", today), "");
  assert.equal(validateProposedEventDate("2027-01-01", today), "");
});

test("individual planting requires a future Manila start but no end time", () => {
  const now = new Date("2026-10-10T09:00:00Z"); // 5:00 PM in Manila
  assert.equal(validatePlantingSchedule({ proposedDate: "2026-10-10", startTime: "18:00", endTime: "", isGroup: false, expectedParticipants: 1 }, now), null);
  assert.equal(validatePlantingSchedule({ proposedDate: "2026-10-11", startTime: "08:00", endTime: "", isGroup: false, expectedParticipants: 2 }, now), null);
  assert.equal(validatePlantingSchedule({ proposedDate: "2026-10-10", startTime: "08:00", endTime: "", isGroup: false, expectedParticipants: 1 }, now).field, "startTime");
  assert.equal(validatePlantingSchedule({ proposedDate: "2026-10-09", startTime: "08:00", endTime: "", isGroup: false, expectedParticipants: 1 }, now).field, "activityDate");
});

test("group planting requires a later same-day end time and positive participants", () => {
  const now = new Date("2026-10-10T09:00:00Z");
  assert.equal(validatePlantingSchedule({ proposedDate: "2026-10-11", startTime: "08:00", endTime: "11:00", isGroup: true, expectedParticipants: 10 }, now), null);
  assert.equal(validatePlantingSchedule({ proposedDate: "2026-10-11", startTime: "08:00", endTime: "08:00", isGroup: true, expectedParticipants: 10 }, now).field, "endTime");
  assert.equal(validatePlantingSchedule({ proposedDate: "2026-10-11", startTime: "08:00", endTime: "", isGroup: true, expectedParticipants: 10 }, now).field, "endTime");
  assert.equal(validatePlantingSchedule({ proposedDate: "2026-10-11", startTime: "08:00", endTime: "11:00", isGroup: true, expectedParticipants: 0 }, now).field, "participants");
});
