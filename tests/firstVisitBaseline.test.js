const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FIRST_VISIT_BASELINE_POLICY_ID, firstVisitBaselineEnabled, calculateSampleTarget, generateTreeIds,
} = require("../src/config/firstVisitBaseline");

test("policy id is fixed", () => {
  assert.equal(FIRST_VISIT_BASELINE_POLICY_ID, "menro-ceil-10-percent-first-visit-baseline-v1");
});

test("flag: unset is false; true/false parse; padded and odd case accepted", () => {
  assert.equal(firstVisitBaselineEnabled({}), false);
  assert.equal(firstVisitBaselineEnabled({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "" }), false);
  assert.equal(firstVisitBaselineEnabled({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "true" }), true);
  assert.equal(firstVisitBaselineEnabled({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "false" }), false);
  assert.equal(firstVisitBaselineEnabled({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: " TRUE " }), true);
});

test("flag: garbage throws 503 with code", () => {
  for (const v of ["yes", "1", "0", "on", "truee"]) {
    assert.throws(() => firstVisitBaselineEnabled({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: v }),
      e => e.status === 503 && e.code === "PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_CONFIGURATION_INVALID");
  }
});

test("calculateSampleTarget spec examples and edges", () => {
  const cases = [[50, 5], [100, 10], [137, 14], [250, 25], [110, 11], [1, 1], [9, 1], [11, 2], [10, 1],
    [0, 0], [-5, 0], [2.5, 0], [NaN, 0], ["10", 0], [null, 0], [undefined, 0], [Infinity, 0], [2 ** 60, 0]];
  for (const [q, want] of cases) assert.equal(calculateSampleTarget(q), want, `q=${q}`);
});

test("calculateSampleTarget equals exact ceil(q/10) for 1..5000", () => {
  for (let q = 1; q <= 5000; q++) assert.equal(calculateSampleTarget(q), Math.floor((q + 9) / 10));
});

test("generateTreeIds pads to 3 digits, unique, regex-valid", () => {
  const ids = generateTreeIds("COHORT-ABC", 14);
  assert.equal(ids.length, 14);
  assert.equal(ids[0], "COHORT-ABC-T001");
  assert.equal(ids[13], "COHORT-ABC-T014");
  assert.equal(new Set(ids).size, 14);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{3,80}$/);
  assert.equal(generateTreeIds("P-1", 999).at(-1), "P-1-T999");
});

test("generateTreeIds widens all ids past 999", () => {
  const ids = generateTreeIds("P-1", 1000);
  assert.equal(ids[0], "P-1-T0001");
  assert.equal(ids[999], "P-1-T1000");
  assert.equal(new Set(ids).size, 1000);
});

test("generateTreeIds returns [] for n <= 0 and rejects bad prefixes", () => {
  assert.deepEqual(generateTreeIds("P-1", 0), []);
  assert.deepEqual(generateTreeIds("P-1", -3), []);
  assert.deepEqual(generateTreeIds("P-1", NaN), []);
  assert.throws(() => generateTreeIds("bad prefix!", 3));
  assert.throws(() => generateTreeIds("", 3));
  assert.throws(() => generateTreeIds(null, 3));
  assert.throws(() => generateTreeIds("x".repeat(80), 3));
  assert.equal(generateTreeIds("x".repeat(75), 1)[0].length, 80);
});
