const FIRST_VISIT_BASELINE_POLICY_ID = "menro-ceil-10-percent-first-visit-baseline-v1";
const TREE_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;

function firstVisitBaselineEnabled(env = process.env) {
  const raw = String(env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED || "").trim().toLowerCase();
  if (!raw) return false;
  if (!["true", "false"].includes(raw)) {
    throw Object.assign(new Error("First-visit baseline configuration is invalid."), {
      status: 503, code: "PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_CONFIGURATION_INVALID",
    });
  }
  return raw === "true";
}

// ceil(q * 0.10) computed with integer arithmetic; floating-point 0.10 is inexact (110 * 0.10 -> 11.000000000000002).
function calculateSampleTarget(verifiedPlantedQuantity) {
  const q = verifiedPlantedQuantity;
  if (typeof q !== "number" || !Number.isSafeInteger(q) || q < 1) return 0;
  return Math.floor(q / 10) + (q % 10 === 0 ? 0 : 1);
}

function generateTreeIds(prefix, count) {
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  if (typeof prefix !== "string" || !prefix) throw new Error("A Tree ID prefix is required.");
  const width = Math.max(3, String(count).length);
  const sample = `${prefix}-T${String(count).padStart(width, "0")}`;
  if (!TREE_ID_PATTERN.test(sample)) throw new Error("Tree ID prefix would produce invalid Tree IDs.");
  return Array.from({ length: count }, (_, i) => `${prefix}-T${String(i + 1).padStart(width, "0")}`);
}

module.exports = { FIRST_VISIT_BASELINE_POLICY_ID, firstVisitBaselineEnabled, calculateSampleTarget, generateTreeIds };
