const test = require("node:test");
const assert = require("node:assert/strict");
const growth = require("../src/config/permanentSampleGrowthCriteria");
const vocab = require("../src/config/permanentSampleMonitoringVocabulary");

test("growth: pending labels and constants", () => {
  assert.equal(growth.GROWTH_CRITERIA_VERSION, "growth-criteria-pending-v1");
  assert.ok(Object.isFrozen(growth.GROWTH_CRITERIA));
  assert.equal(Object.keys(growth.GROWTH_CRITERIA).length, 0);
  assert.deepEqual([...growth.GROWTH_STAGES], ["Seedling", "Sapling", "Pole", "Tree"]);
  assert.ok(Object.isFrozen(growth.GROWTH_STAGES));
  assert.equal(growth.GROWTH_LABELS.MEETS, "Meets Expected Growth");
  assert.equal(growth.GROWTH_LABELS.BELOW, "Below Expected Growth");
  assert.equal(growth.GROWTH_LABELS.PENDING, "Pending Approved Criteria");
  assert.equal(growth.GROWTH_LABELS.NOT_APPLICABLE, "Not Applicable");
  assert.equal(growth.GROWTH_LABELS.STAGE_PENDING, "Pending Stage Criteria");
});

test("evaluateGrowthPerformance never yields Meets/Below without criteria", () => {
  const full = { species: "Narra", heightDifferenceCm: 12, stemDiameterDifferenceMm: 3, elapsedDays: 90 };
  assert.equal(growth.evaluateGrowthPerformance(full), "Pending Approved Criteria");
  assert.equal(growth.evaluateGrowthPerformance({ ...full, heightDifferenceCm: -50 }), "Pending Approved Criteria");
  assert.equal(growth.evaluateGrowthPerformance({ ...full, heightDifferenceCm: null }), "Not Applicable");
  assert.equal(growth.evaluateGrowthPerformance({ ...full, stemDiameterDifferenceMm: undefined }), "Not Applicable");
  assert.equal(growth.evaluateGrowthPerformance({ ...full, elapsedDays: NaN }), "Not Applicable");
  assert.equal(growth.evaluateGrowthPerformance({}), "Not Applicable");
  assert.equal(growth.evaluateGrowthPerformance(), "Not Applicable");
});

test("getGrowthStage is pending", () => {
  assert.equal(growth.getGrowthStage({ species: "Narra", heightCm: 200 }), "Pending Stage Criteria");
  assert.equal(growth.getGrowthStage(), "Pending Stage Criteria");
});

test("vocabulary frozen and provisional", () => {
  assert.deepEqual([...vocab.MORTALITY_CAUSES], ["Unknown", "Drought", "Pest/Disease", "Flooding", "Physical Damage"]);
  assert.ok(Object.isFrozen(vocab.MORTALITY_CAUSES));
  assert.equal(vocab.MORTALITY_CAUSES_STATUS, "PROVISIONAL_PENDING_MENRO_CONFIRMATION");
  assert.equal(vocab.PROPOSED_MONITORING_GPS_LIMIT_METERS, 100);
  assert.equal(vocab.MONITORING_GPS_LIMIT_ACTIVE, false);
});
