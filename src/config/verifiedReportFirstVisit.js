// Every Admin-verified Planting Report may start the simplified first visit, whatever monitoring method was stored when
// its request was approved. Off by default. The stored policy is never changed: the cohort records it with this policy ID.
const VERIFIED_REPORT_POLICY_ID = "menro-verified-report-first-visit-v1";

function verifiedReportFirstVisitEnabled(env = process.env) {
  const raw = String(env.VERIFIED_REPORT_FIRST_VISIT_ENABLED || "").trim().toLowerCase();
  if (!raw) return false;
  if (!["true", "false"].includes(raw)) {
    throw Object.assign(new Error("Verified-report first-visit configuration is invalid."), {
      status: 503, code: "VERIFIED_REPORT_FIRST_VISIT_CONFIGURATION_INVALID",
    });
  }
  return raw === "true";
}

module.exports = { VERIFIED_REPORT_POLICY_ID, verifiedReportFirstVisitEnabled };
