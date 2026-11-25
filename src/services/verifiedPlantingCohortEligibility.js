// Permanent-sample cohort eligibility shared by automatic provisioning, readiness and historical recovery.
// No Firebase import (directly or transitively), so a credential-free dry run applies the exact same rules.
const crypto = require("node:crypto");
const { monitoringPolicyResolution } = require("./monitoringLifecyclePolicy");

function cohortIdFor(reportId) {
  if (typeof reportId !== "string" || !reportId || reportId.includes("/")) {
    throw new Error("Invalid planting report ID.");
  }
  return `VPC-${crypto.createHash("sha256").update(reportId).digest("hex").slice(0, 24)}`;
}

// "" when absent, null when it is not a plain Firestore document ID (never turned into a reference).
function documentReference(value) {
  if (!value) return "";
  return typeof value === "string" && value === value.trim() && !value.includes("/") && !/^(\.{1,2}|__.*__)$/.test(value) ? value : null;
}

function normalizedSpecies(event = {}, report = {}) {
  const items = Array.isArray(event.seedlingItems) ? event.seedlingItems : [];
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const inventoryId = String(item?.inventoryId || "").trim();
    const species = String(item?.species || "").trim();
    const key = `${inventoryId}|${species}`;
    if ((!inventoryId && !species) || seen.has(key)) continue;
    seen.add(key);
    output.push({ inventoryId, species, releasedQuantity: Number(item?.quantity || 0) || 0,
      ...(report.officialPlantingWorkflow === true ? { verifiedPlantedQuantity: Number(report.acceptedSeedlingsByInventory?.[inventoryId] || 0) } : {}) });
  }
  if (!output.length && String(report.species || "").trim()) {
    output.push({ inventoryId: String(report.inventoryId || "").trim(), species: String(report.species).trim(), releasedQuantity: 0 });
  }
  return output;
}

function isAuthoritativelyVerified(report = {}) {
  return report.reportType === "parent" ? report.reportingProgress === "Completed" : report.verificationStatus === "Approved";
}

function authoritativeQuantity(report = {}) {
  const quantity = Number(report.reportType === "parent" ? report.acceptedQuantity : report.quantityPlanted);
  return isAuthoritativelyVerified(report) && Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
}

// Stored monitoring method of the report's policy snapshot (flat, nested or matching both). A report without any
// snapshot keeps its existing eligibility; contradictory, pending, unknown or non-text values fail closed.
function permanentSamplePolicy(report = {}) {
  const policy = report.reportingPolicy;
  const notText = [policy?.monitoring, policy?.definition?.monitoring].some(value => value !== undefined && value !== null && typeof value !== "string");
  const resolution = notText ? { method: "UNSPECIFIED", conflict: false } : monitoringPolicyResolution(report);
  const pending = !resolution.conflict && policy?.policyStatus === "PENDING_MENRO_POLICY";
  const allowed = !policy || (!resolution.conflict && !pending && resolution.method === "PERMANENT_SAMPLE");
  return { allowed, code: allowed ? null : resolution.conflict ? "POLICY_CONFLICT" : "NOT_PERMANENT_SAMPLE_MONITORING",
    method: pending ? "PENDING_MENRO_POLICY" : resolution.method };
}

// The verified-report rule (verifiedReportFirstVisit.js) widens these stored methods only. A conflict, an unreadable
// value or an unrecognized method still needs a correction of the source record.
const WIDENED_METHODS = new Set(["STAFF_SPOT_CHECK", "PENDING_MENRO_POLICY", "NONE"]);
function firstVisitPolicy(report = {}, { verifiedReportRule = false } = {}) {
  const stored = permanentSamplePolicy(report);
  return !stored.allowed && verifiedReportRule === true && stored.code !== "POLICY_CONFLICT" && WIDENED_METHODS.has(stored.method)
    ? { allowed: true, code: null, method: stored.method } : stored;
}

// Audit copy of the stored decision, kept on the cohort. The report's own snapshot is never rewritten.
function originalPolicyRecord(report = {}) {
  const policy = report.reportingPolicy;
  return { hasSnapshot: Boolean(policy), monitoring: policy?.monitoring ?? null, definitionMonitoring: policy?.definition?.monitoring ?? null,
    policyStatus: policy?.policyStatus ?? null, policyVersion: policy?.policyVersion ?? null };
}

module.exports = { firstVisitPolicy, originalPolicyRecord, cohortIdFor, documentReference, normalizedSpecies, isAuthoritativelyVerified, authoritativeQuantity, permanentSamplePolicy };
