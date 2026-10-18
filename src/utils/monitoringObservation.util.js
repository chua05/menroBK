const VALIDATED_STATUSES = new Set([
  "accepted",
  "approved",
  "reviewed",
  "validated",
  "verified",
]);

const EXCLUDED_STATUSES = new Set([
  "invalid",
  "pending",
  "pending review",
  "rejected",
]);

const PHASE_TWO_STATUSES = Object.freeze({
  PENDING: "Pending Review",
  RETURNED: "Returned for Rechecking",
  REVIEWED: "Reviewed",
  APPROVED: "Approved",
  REJECTED: "Rejected",
});

function normalizedStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function explicitObservationStatus(observation = {}) {
  return [
    observation.reviewStatus,
    observation.staffReviewStatus,
    observation.verificationStatus,
  ].map(normalizedStatus).find(Boolean) || "";
}

function lifecycleValidationStatus(record = {}) {
  return [
    record.reviewStatus,
    record.staffReviewStatus,
    record.verificationStatus,
  ].map(normalizedStatus).find(Boolean) || "";
}

function isValidatedMonitoringObservation(observation = {}, record = {}) {
  if (observation.observationType === "early") return false;
  if (Number(observation.workflowVersion) >= 2) {
    return observation.reviewStatus === PHASE_TWO_STATUSES.APPROVED &&
      observation.adminDecision === "Approve" &&
      Boolean(observation.adminDecidedBy) && Boolean(observation.adminDecidedAt);
  }
  const observationStatus = explicitObservationStatus(observation);
  if (observationStatus) {
    if (EXCLUDED_STATUSES.has(observationStatus)) return false;
    return VALIDATED_STATUSES.has(observationStatus);
  }

  // Older monitoring records stored the review decision only on the lifecycle.
  // Keep those records readable without allowing an explicit Pending or Rejected
  // observation to inherit a later lifecycle decision.
  return VALIDATED_STATUSES.has(lifecycleValidationStatus(record));
}

function monitoringApprovalBasis(observation = {}, record = {}) {
  if (!isValidatedMonitoringObservation(observation, record)) return null;
  return Number(observation.workflowVersion) >= 2
    ? "Admin Approved"
    : "Legacy Validated";
}

function validatedMonitoringHistory(record = {}) {
  const history = Array.isArray(record.history)
    ? record.history
    : (record.monitoredDate || record.monitoringDate || record.createdAt)
      ? [record]
      : [];

  return history.filter((observation) =>
    isValidatedMonitoringObservation(observation, record));
}

function isOfficialMonitoringObservation(observation = {}) {
  return observation.observationType !== "early";
}

function monitoringObservationTotal(observation = {}) {
  const explicit = Number(observation.totalMonitored ?? observation.totalChecked);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;

  const counts = [
    observation.healthyCount ?? observation.healthy,
    observation.damagedCount ?? observation.damaged,
    observation.deadCount ?? observation.dead,
  ].map(Number);
  if (counts.every((value) => Number.isInteger(value) && value >= 0)) {
    const total = counts.reduce((sum, value) => sum + value, 0);
    if (total > 0) return total;
  }
  return 0;
}

function isFullCohortObservation(observation = {}, record = {}) {
  if (typeof observation.isFullCohortAssessment === "boolean") {
    return observation.isFullCohortAssessment;
  }
  const total = monitoringObservationTotal(observation);
  const cohortQuantity = Number(
    observation.cohortQuantityAtObservation ?? record.quantityPlanted
  );
  return total > 0 && Number.isInteger(cohortQuantity) && cohortQuantity > 0 &&
    total === cohortQuantity;
}

function monitoringCoverageClassification(observation = {}, record = {}) {
  if (typeof observation.isFullCohortAssessment === "boolean") {
    return observation.isFullCohortAssessment ? "full" : "partial";
  }
  const total = monitoringObservationTotal(observation);
  const cohortQuantity = Number(
    observation.cohortQuantityAtObservation ?? record.quantityPlanted
  );
  if (!Number.isInteger(total) || total <= 0 ||
      !Number.isInteger(cohortQuantity) || cohortQuantity <= 0 || total > cohortQuantity) {
    return "unknown";
  }
  return total === cohortQuantity ? "full" : "partial";
}

function observationDate(observation = {}) {
  const value = String(observation.monitoredDate || observation.monitoringDate || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function shiftDate(value, mode) {
  const [year, month, day] = value.split("-").map(Number);
  const source = new Date(Date.UTC(year, month - 1, day, 12));
  if (mode === "first") source.setUTCDate(source.getUTCDate() + 35);
  else {
    const targetMonth = source.getUTCMonth() + 1;
    const targetYear = source.getUTCFullYear() + Math.floor(targetMonth / 12);
    const normalizedMonth = targetMonth % 12;
    const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0, 12)).getUTCDate();
    source.setUTCFullYear(targetYear, normalizedMonth, Math.min(day, lastDay));
  }
  return `${source.getUTCFullYear()}-${String(source.getUTCMonth() + 1).padStart(2, "0")}-${String(source.getUTCDate()).padStart(2, "0")}`;
}

function officialNextMonitoringDate(record = {}) {
  const approved = validatedMonitoringHistory(record)
    .filter((entry) => isFullCohortObservation(entry, record) && observationDate(entry))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => observationDate(a.entry).localeCompare(observationDate(b.entry)) || a.index - b.index);
  const latest = approved.at(-1)?.entry;
  if (!latest) return null;
  return shiftDate(observationDate(latest), approved.length === 1 ? "first" : "subsequent");
}

module.exports = {
  isValidatedMonitoringObservation,
  validatedMonitoringHistory,
  monitoringObservationTotal,
  isFullCohortObservation,
  monitoringCoverageClassification,
  monitoringApprovalBasis,
  isOfficialMonitoringObservation,
  officialNextMonitoringDate,
  PHASE_TWO_STATUSES,
};
