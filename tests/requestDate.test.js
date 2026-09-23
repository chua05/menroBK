const assert = require("node:assert/strict");
const test = require("node:test");
const { validatePreferredReleaseDate, validateProposedEventDate } = require("../src/utils/requestDate.util");

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
