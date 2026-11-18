// Automatic Survival Monitoring lifecycle registration for Admin-verified Planting Reports.
//
// Every eligible verified report gets one persistent monitoring lifecycle (collection "monitoringRecords")
// with a sequential MON-YYYY-NNN number, before any monitoring assessment exists. Registration records
// tracking only: it never creates observations, visits, evidence, approvals or survival statistics, and it
// never changes the report's stored monitoring policy.
//
// Idempotency and numbering:
// - The lifecycle document ID is the existing deterministic lifecycleId(participant, report, event, site),
//   so a retry, repeated page load or concurrent verification resolves to the same document.
// - The MON number comes from the transactional "monitoringRecords_<year>" counter (reserve in the read
//   phase, commit in the write phase). A number is assigned only when the lifecycle has none; existing
//   numbers and history are never changed.
//
// Schedules: legacy reports (no purpose policy) keep the existing aggregate rule (start = planting + 14
// days, end = + 2 years). Purpose-policy reports (e.g. STAFF_SPOT_CHECK, PERMANENT_SAMPLE) have no approved
// lifecycle schedule here, so their dates stay empty and scheduleStatus is AWAITING_MONITORING_POLICY.
const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("../config/firebase");
const { commitRecordNumber, reserveRecordNumber } = require("../utils/recordNumber.util");

const AWAITING_MONITORING_POLICY = "AWAITING_MONITORING_POLICY";
const REGISTRATION_SOURCE = "PLANTING_REPORT_VERIFICATION";

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

function lifecycleDocument(id, reportId, report, number, now) {
  const monitoring = require("./monitoring.service");
  const method = monitoringMethodOf(report);
  const registration = {
    monitoringNumber: number,
    monitoringMethod: method,
    registrationSource: REGISTRATION_SOURCE,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  };
  if (method === "LEGACY") {
    // Same seed the first aggregate observation would create; throws when no valid planting date exists.
    return { ...monitoring.baseLifecycle(id, { ...report, id: reportId }), ...registration };
  }
  return {
    id,
    recordType: "monitoringLifecycle",
    plantingReportId: reportId,
    plantingReportNumber: report.reportNumber || "",
    participantId: report.participantId || "",
    participantName: report.participantName || "",
    eventId: report.eventId || "",
    eventName: report.eventName || "",
    siteId: report.siteId || "",
    siteName: report.siteName || report.plantingLocation || "",
    barangay: report.barangay || "",
    species: report.species || "",
    quantityPlanted: Number(report.acceptedQuantity ?? report.quantityPlanted ?? 0),
    authoritativePlantingDate: String(report.plantingDate || report.eventDate || "").slice(0, 10) || null,
    startMonitoringDate: null,
    nextMonitoringDate: null,
    monitoringEndDate: null,
    scheduleStatus: AWAITING_MONITORING_POLICY,
    history: [],
    archived: false,
    ...registration,
  };
}

/**
 * Read phase. Call before any transaction write. Returns null when the report is not eligible or its
 * lifecycle already carries a MON number. Never throws for ineligible or incomplete reports, so
 * registration can never block Planting Report verification.
 */
async function prepareLifecycleRegistrationInTransaction(transaction, { reportId, report, now = Timestamp.now() }) {
  if (typeof reportId !== "string" || !reportId || reportId.includes("/") || !eligible(report)) return null;
  const monitoring = require("./monitoring.service");
  const id = monitoring.lifecycleId(report.participantId || "", reportId, report.eventId || "", report.siteId || "");
  const ref = db.collection("monitoringRecords").doc(id);
  const existing = await transaction.get(ref);
  if (existing.exists) {
    const current = existing.data() || {};
    if (current.plantingReportId && current.plantingReportId !== reportId) throw new Error("Monitoring lifecycle relationship is inconsistent.");
    if (current.monitoringNumber) return null;
  }
  let candidate;
  try { candidate = existing.exists ? null : lifecycleDocument(id, reportId, report, "pending", now); }
  catch { return null; }
  const reservation = await reserveRecordNumber(transaction, { prefix: "MON", counterKey: "monitoringRecords", date: now.toDate() });
  return { ref, id, exists: existing.exists, candidate, reservation, now };
}

/** Write phase. Applies a prepared registration; returns the assigned MON number (or null). */
function commitLifecycleRegistration(transaction, plan) {
  if (!plan) return null;
  const number = commitRecordNumber(transaction, plan.reservation, plan.now);
  if (plan.exists) {
    // An existing lifecycle without a number (created before numbering) receives one; nothing else changes.
    transaction.update(plan.ref, { monitoringNumber: number, updatedAt: plan.now });
  } else {
    transaction.create(plan.ref, { ...plan.candidate, monitoringNumber: number });
  }
  return number;
}

async function registerMonitoringLifecycle({ reportId }) {
  return db.runTransaction(async (transaction) => {
    const reportDoc = await transaction.get(db.collection("plantingReports").doc(reportId));
    if (!reportDoc.exists) return { reportId, status: "REPORT_NOT_FOUND" };
    const plan = await prepareLifecycleRegistrationInTransaction(transaction, { reportId, report: reportDoc.data() });
    if (!plan) return { reportId, status: "NO_CHANGE" };
    const number = commitLifecycleRegistration(transaction, plan);
    return { reportId, status: plan.exists ? "NUMBER_ASSIGNED" : "REGISTERED", lifecycleId: plan.id, monitoringNumber: number };
  });
}

module.exports = {
  AWAITING_MONITORING_POLICY,
  REGISTRATION_SOURCE,
  commitLifecycleRegistration,
  eligible,
  monitoringMethodOf,
  monitoringPolicyResolution,
  prepareLifecycleRegistrationInTransaction,
  registerMonitoringLifecycle,
};
