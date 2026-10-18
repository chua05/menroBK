const POLICY_VERSION = 1;
const MANILA_TIME_ZONE = "Asia/Manila";

function dateOnlyInManila(value = new Date()) {
  const date = value instanceof Date ? value : value?.toDate?.() || new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftCalendarDate(value, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function activationState(env = process.env) {
  const raw = String(env.EARLY_MONITORING_ACTIVATION_AT || "").trim();
  if (!raw) return { enabled: false, activationAt: null };
  const activationAt = new Date(raw);
  if (Number.isNaN(activationAt.getTime())) {
    throw new Error("EARLY_MONITORING_ACTIVATION_AT must be a valid ISO timestamp.");
  }
  return { enabled: true, activationAt };
}

function buildEarlyMonitoringPolicy({ originalSubmittedAt, verifiedAt, officialOpeningDate }, env = process.env) {
  const activation = activationState(env);
  const submitted = originalSubmittedAt?.toDate?.() || new Date(originalSubmittedAt);
  const verified = verifiedAt?.toDate?.() || new Date(verifiedAt);
  if (!activation.enabled || Number.isNaN(submitted.getTime()) || Number.isNaN(verified.getTime()) ||
      submitted < activation.activationAt || verified < activation.activationAt) return null;
  const submittedDate = dateOnlyInManila(submitted);
  const verifiedDate = dateOnlyInManila(verified);
  const openingDate = [shiftCalendarDate(submittedDate, 3), verifiedDate].sort().at(-1);
  const deadlineDate = shiftCalendarDate(openingDate, 6);
  return {
    enabled: true, policyVersion: POLICY_VERSION, originalSubmittedAt,
    verifiedAt, openingDate, deadlineDate, officialOpeningDate,
    applicable: Boolean(officialOpeningDate && openingDate < officialOpeningDate),
  };
}

function earlyScheduleStatus(policy, today = dateOnlyInManila()) {
  if (!policy?.enabled || !policy.applicable) return "Not Applicable";
  if (today >= policy.officialOpeningDate) return "Closed";
  if (today < policy.openingDate) return "Scheduled";
  if (today > policy.deadlineDate) return "Overdue";
  return shiftCalendarDate(today, 2) >= policy.deadlineDate ? "Due Soon" : "Available";
}

module.exports = { POLICY_VERSION, MANILA_TIME_ZONE, activationState, buildEarlyMonitoringPolicy,
  dateOnlyInManila, earlyScheduleStatus, shiftCalendarDate };
