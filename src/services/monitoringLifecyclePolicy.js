// Pure Monitoring Lifecycle eligibility and policy resolution (no Firebase import).
// Shared by registration (monitoringLifecycleRegistration.service) and the read-only preflights, so a
// credential-free or ADC-based preflight can load the exact same rules without initializing Firebase.

function isVerifiedReport(report = {}) {
  const verification = String(report.verificationStatus || "").trim().toLowerCase();
  return report.archived !== true &&
    (["approved", "verified", "completed"].includes(verification) || String(report.reportingProgress || "").trim().toLowerCase() === "completed");
}

// Released policy snapshots can have a flattened method, the original approved
// definition, or both. Read either shape without rewriting the stored snapshot.
// Contradictory snapshots require review; neither value grants a workflow.
function monitoringPolicyResolution(report = {}) {
  if (!report.reportingPolicy) return { method: "LEGACY", conflict: false, source: "legacy" };
  const policy = report.reportingPolicy;
  const flat = String(policy.monitoring || "").trim();
  const nested = String(policy.definition?.monitoring || "").trim();
  if (flat && nested && flat !== nested) return { method: "UNSPECIFIED", conflict: true, source: "conflict" };
  return { method: flat || nested || "UNSPECIFIED", conflict: false,
    source: flat ? "reportingPolicy.monitoring" : nested ? "reportingPolicy.definition.monitoring" : "unspecified" };
}

function monitoringMethodOf(report = {}) {
  return monitoringPolicyResolution(report).method;
}

function eligible(report) {
  const policy = monitoringPolicyResolution(report);
  return isVerifiedReport(report) && !policy.conflict && policy.method !== "NONE";
}

module.exports = { eligible, isVerifiedReport, monitoringMethodOf, monitoringPolicyResolution };
