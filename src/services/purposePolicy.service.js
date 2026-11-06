const { dateOnlyInManila } = require("../utils/earlyMonitoring.util");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { contract, canonicalPurpose, classifyRequest } = require("../utils/requestClassification.util");
const REPORTING = ["REQUIRED", "OPTIONAL", "NOT_REQUIRED", "CONDITIONAL"];
const MONITORING = ["NONE", "STAFF_SPOT_CHECK", "PERMANENT_SAMPLE"];
const fail = (status, message, fieldErrors) => Object.assign(new Error(message), { status, code: "PURPOSE_POLICY_INVALID", fieldErrors });
const currentRef = () => db.collection("purposePolicies").doc("current");
function initialPolicy() {
  return { version: 0, effectiveDate: null, updatedBy: null, initialTemplate: true,
    sampling: { percentage: 10, minimum: null, firstVisitDelayWeeks: null, intervalMonths: 12, speciesAllocationProcedure: null, physicalSelectionProcedure: null },
    purposes: contract.purposes.map((purpose, index) => ({ purpose,
      reporting: ["NOT_REQUIRED", "CONDITIONAL", "REQUIRED", "REQUIRED", "REQUIRED", "OPTIONAL", "CONDITIONAL"][index],
      monitoring: ["STAFF_SPOT_CHECK", "NONE", "PERMANENT_SAMPLE", "PERMANENT_SAMPLE", "PERMANENT_SAMPLE", "NONE", "NONE"][index],
      quantityThreshold: null, organizationCondition: null })) };
}
function validatePolicy(input) {
  if (!input || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
      typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw fail(400, "A policy version and audit reason are required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate || "") || (!Number.isFinite(new Date(`${input.effectiveDate}T00:00:00Z`).getTime()) || new Date(`${input.effectiveDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.effectiveDate)) throw fail(400, "A valid effective date is required.");
  const sampling = input.sampling;
  if (!sampling || !Number.isFinite(sampling.percentage) || sampling.percentage <= 0 || sampling.percentage > 100 ||
      !Number.isSafeInteger(sampling.intervalMonths) || sampling.intervalMonths < 1 || sampling.intervalMonths > 120) throw fail(400, "Enter a sampling percentage in (0,100] and an interval of 1–120 months.");
  for (const key of ["minimum", "firstVisitDelayWeeks"]) if (sampling[key] !== null && (!Number.isSafeInteger(sampling[key]) || sampling[key] < (key === "minimum" ? 1 : 0) || sampling[key] > 10000)) throw fail(400, `Invalid ${key}. Leave unapproved policy values pending.`);
  for (const key of ["speciesAllocationProcedure", "physicalSelectionProcedure"]) if (sampling[key] !== null && (typeof sampling[key] !== "string" || !sampling[key].trim() || sampling[key].length > 2000)) throw fail(400, `Invalid ${key}.`);
  if (!Array.isArray(input.purposes) || input.purposes.length !== contract.purposes.length || new Set(input.purposes.map(row => row.purpose)).size !== contract.purposes.length) throw fail(400, "Configure each supported purpose exactly once.");
  const purposes = input.purposes.map(row => {
    if (!contract.purposes.includes(row.purpose) || !REPORTING.includes(row.reporting) || !MONITORING.includes(row.monitoring) ||
        row.quantityThreshold !== null && (!Number.isSafeInteger(row.quantityThreshold) || row.quantityThreshold < 1)) throw fail(400, "Invalid purpose reporting/monitoring policy.");
    const condition = row.organizationCondition;
    if (condition !== null && (!condition || !REPORTING.filter(value => value !== "CONDITIONAL").includes(condition.reporting) || !MONITORING.includes(condition.monitoring) || typeof condition.reason !== "string" || !condition.reason.trim() || condition.reason.length > 1000)) throw fail(400, "An organization condition requires an explicit decision and reason.");
    return { purpose: row.purpose, reporting: row.reporting, monitoring: row.monitoring, quantityThreshold: row.quantityThreshold,
      organizationCondition: condition ? { reporting: condition.reporting, monitoring: condition.monitoring, reason: condition.reason.trim() } : null };
  });
  return { purposes, sampling: Object.fromEntries(["percentage", "minimum", "firstVisitDelayWeeks", "intervalMonths", "speciesAllocationProcedure", "physicalSelectionProcedure"].map(key => [key, sampling[key]])), effectiveDate: input.effectiveDate };
}
async function currentPolicy() {
  const snapshot = await currentRef().get();
  const policy = snapshot.exists ? snapshot.data() : initialPolicy();
  if (!policy.effectiveDate || policy.effectiveDate <= dateOnlyInManila()) return policy;
  // A future version is stored but cannot silently apply before its effective date.
  return policy.previousEffective || initialPolicy();
}
async function readSettings(user) {
  if (!user?.uid || user.role !== "admin") throw fail(user?.uid ? 403 : 401, "Admin access is required.");
  const snapshot = await currentRef().get(); return snapshot.exists ? snapshot.data() : initialPolicy();
}
async function saveSettings(user, input) {
  if (!user?.uid || user.role !== "admin") throw fail(user?.uid ? 403 : 401, "Admin access is required.");
  const values = validatePolicy(input);
  let saved;
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(currentRef()); const prior = snapshot.exists ? snapshot.data() : initialPolicy();
    if (prior.version !== input.expectedVersion) throw fail(409, "Policy changed. Refresh before saving.");
    const now = Timestamp.now();
    const active = prior.effectiveDate && prior.effectiveDate > dateOnlyInManila() ? prior.previousEffective || initialPolicy() : prior;
    const { previousEffective, ...activeSnapshot } = active;
    saved = { ...values, version: prior.version + 1, updatedBy: user.uid, updatedAt: now, reason: input.reason.trim(), previousEffective: activeSnapshot };
    transaction.create(db.collection("purposePolicyVersions").doc(String(saved.version)), { ...values, version: saved.version, updatedBy: user.uid, updatedAt: now, reason: saved.reason });
    transaction.set(currentRef(), saved);
  });
  return saved;
}
function candidateFor(request, settings) {
  const purpose = canonicalPurpose(request.purpose, request.workflow);
  const definition = settings.purposes.find(row => row.purpose === purpose);
  return { purpose, policyVersion: settings.version, definition, sampling: settings.sampling,
    requesterType: classifyRequest(request.workflow) || request.requestType || "UNRESOLVED", originalPurpose: request.purpose };
}
function validateDecision(decision) {
  if (!decision || !REPORTING.includes(decision.reporting) || decision.reporting === "CONDITIONAL" || !MONITORING.includes(decision.monitoring) ||
      typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 1000) throw fail(400, "Select reporting/monitoring requirements and record a policy decision reason.", { policyReason: "A policy decision with a reason is required." });
  return { reporting: decision.reporting, monitoring: decision.monitoring, reason: decision.reason.trim() };
}
async function approvalSnapshot(transaction, request, actorId, decision) {
  if (!request.purposePolicyManaged) return null;
  const doc = await transaction.get(currentRef());
  let settings = doc.exists ? doc.data() : initialPolicy();
  if (settings.effectiveDate && settings.effectiveDate > dateOnlyInManila()) settings = settings.previousEffective || initialPolicy();
  const candidate = candidateFor(request, settings);
  if (decision?.expectedPolicyVersion !== undefined && decision.expectedPolicyVersion !== settings.version) throw fail(409, "The effective policy changed. Refresh before approval.");
  let definition = candidate.definition;
  const organization = candidate.requesterType === "organization";
  const organizationUnresolved = organization && !definition.organizationCondition;
  if (organization && definition.organizationCondition) definition = { ...definition, ...definition.organizationCondition };
  const unresolved = candidate.purpose === "Other" || definition.reporting === "CONDITIONAL" && definition.quantityThreshold === null || organizationUnresolved;
  const override = decision ? validateDecision(decision) : null;
  if (unresolved && !override) throw fail(409, "An explicit Admin reporting/monitoring policy decision is required before approval.", { policyReason: "Resolve the pending purpose/organization policy." });
  return { ...candidate, definition: { ...definition, ...(override ? { reporting: override.reporting, monitoring: override.monitoring } : {}) },
    staffProposal: request.staffPolicyProposal || null, override, approvedBy: actorId, approvedAt: Timestamp.now(), source: "ADMIN_APPROVED_PURPOSE_POLICY" };
}
function releasePolicy(snapshot, releasedQuantity) {
  if (!snapshot) return null;
  const definition = snapshot.definition;
  let reporting = definition.reporting;
  if (reporting === "CONDITIONAL") reporting = definition.quantityThreshold === null ? "PENDING_POLICY" : releasedQuantity > definition.quantityThreshold ? "REQUIRED" : "OPTIONAL";
  return { ...snapshot, reporting, releasedQuantity, monitoring: definition.monitoring,
    reportingStatus: reporting === "NOT_REQUIRED" ? "Released – No Report Required" : reporting === "REQUIRED" ? "Awaiting Planting Confirmation" : reporting === "OPTIONAL" ? "Released – Optional Planting Confirmation" : "Reporting Policy Pending",
    reportingOverdueApplicable: reporting === "REQUIRED", requesterMonitoringTasks: false };
}
function samplingReadiness(confirmed, sampling = {}, plantingDate, now = new Date()) {
  if (!Number.isSafeInteger(confirmed) || confirmed < 0) throw fail(400, "Confirmed planted quantity must be a nonnegative whole number.");
  const baseTarget = Math.ceil(confirmed * Number(sampling.percentage ?? 10) / 100);
  const target = confirmed === 0 ? 0 : sampling.minimum == null ? null : Math.min(confirmed, Math.max(sampling.minimum, baseTarget));
  const pending = [];
  if (target === null) pending.push("MINIMUM_SAMPLE_POLICY_PENDING");
  if (!sampling.speciesAllocationProcedure) pending.push("SPECIES_ALLOCATION_PROCEDURE_PENDING");
  if (!sampling.physicalSelectionProcedure) pending.push("PHYSICAL_SELECTION_PROCEDURE_PENDING");
  if (sampling.firstVisitDelayWeeks == null) pending.push("FIRST_VISIT_DELAY_PENDING");
  const date = typeof plantingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(plantingDate) ? new Date(`${plantingDate}T00:00:00Z`) : null;
  const due = date && Number.isFinite(date.getTime()) && sampling.firstVisitDelayWeeks != null ? new Date(date.getTime() + sampling.firstVisitDelayWeeks * 7 * 86400000).toISOString().slice(0, 10) : null;
  return { confirmedPlanted: confirmed, percentage: sampling.percentage ?? 10, baseTarget, target, pending, firstVisitDueDate: due,
    status: pending.length || !due ? "POLICY_PENDING" : due <= dateOnlyInManila(now) ? "Pending First Visit" : "Scheduled First Visit",
    intervalMonths: sampling.intervalMonths ?? 12, automaticCreationEnabled: false };
}
module.exports = { REPORTING, MONITORING, initialPolicy, validatePolicy, currentPolicy, readSettings, saveSettings, candidateFor, validateDecision, approvalSnapshot, releasePolicy, samplingReadiness };
