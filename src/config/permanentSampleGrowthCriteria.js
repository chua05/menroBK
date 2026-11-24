// MENRO has not approved growth or stage thresholds. The criteria set is intentionally empty;
// Meets/Below are never computed until criteria are configured and approved.
const GROWTH_CRITERIA_VERSION = "growth-criteria-pending-v1";
const GROWTH_CRITERIA = Object.freeze({});
const GROWTH_STAGES = Object.freeze(["Seedling", "Sapling", "Pole", "Tree"]);
const GROWTH_LABELS = Object.freeze({
  MEETS: "Meets Expected Growth",
  BELOW: "Below Expected Growth",
  PENDING: "Pending Approved Criteria",
  NOT_APPLICABLE: "Not Applicable",
  STAGE_PENDING: "Pending Stage Criteria",
});

const hasNumber = value => typeof value === "number" && Number.isFinite(value);

function evaluateGrowthPerformance({ heightDifferenceCm, stemDiameterDifferenceMm, elapsedDays } = {}) {
  if (!hasNumber(heightDifferenceCm) || !hasNumber(stemDiameterDifferenceMm) || !hasNumber(elapsedDays)) {
    return GROWTH_LABELS.NOT_APPLICABLE;
  }
  return GROWTH_LABELS.PENDING;
}

function getGrowthStage() {
  return GROWTH_LABELS.STAGE_PENDING;
}

module.exports = {
  GROWTH_CRITERIA_VERSION, GROWTH_CRITERIA, GROWTH_STAGES, GROWTH_LABELS,
  evaluateGrowthPerformance, getGrowthStage,
};
