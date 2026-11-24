const POLICY_VERSION = "permanent-sample-calendar-v1";
const MANILA_TIME_ZONE = "Asia/Manila";

function enabled(env = process.env) {
  const raw = String(env.PERMANENT_SAMPLE_SCHEDULE_ENABLED || "").trim().toLowerCase();
  if (!raw) return false;
  if (!["true", "false"].includes(raw)) {
    throw Object.assign(new Error("Permanent-sample schedule configuration is invalid."), {
      status: 503, code: "PERMANENT_SAMPLE_SCHEDULE_CONFIGURATION_INVALID",
    });
  }
  return raw === "true";
}

function resolvePermanentSampleSchedule(env = process.env) {
  return Object.freeze({
    enabled: enabled(env),
    policyVersion: POLICY_VERSION,
    firstVisitRule: "ANY_NONFUTURE_ELIGIBLE_DATE",
    secondVisitIntervalMonths: 1,
    laterVisitIntervalMonths: 3,
    timeZone: MANILA_TIME_ZONE,
  });
}

function dateOnlyInManila(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("A valid date is required.");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Calendar-month arithmetic retains the anchor day and clamps to month end.
function addCalendarMonths(value, months) {
  if (!validDateOnly(value) || !Number.isSafeInteger(months) || months < 0) {
    throw new Error("A valid date and nonnegative calendar-month interval are required.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const absolute = year * 12 + month - 1 + months;
  const targetYear = Math.floor(absolute / 12);
  const targetMonth = absolute % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0, 12)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function scheduleAfterApproval(visit) {
  const visitNumber = Number(visit?.visitNumber);
  const actualDate = String(visit?.dateMonitored || "");
  const plannedDueDate = String(visit?.scheduledDueDate || "");
  if (!Number.isSafeInteger(visitNumber) || visitNumber < 1 || !validDateOnly(actualDate) ||
      !validDateOnly(plannedDueDate)) throw new Error("Approved visit schedule data is incomplete.");
  return addCalendarMonths(visitNumber === 1 ? actualDate : plannedDueDate, visitNumber === 1 ? 1 : 3);
}

function scheduleStatus(openingDate, today = dateOnlyInManila()) {
  if (!validDateOnly(openingDate)) return "POLICY_PENDING";
  if (today < openingDate) return "SCHEDULED";
  if (today === openingDate) return "DUE";
  return "OVERDUE";
}

module.exports = {
  POLICY_VERSION, MANILA_TIME_ZONE, resolvePermanentSampleSchedule,
  dateOnlyInManila, validDateOnly, addCalendarMonths, scheduleAfterApproval, scheduleStatus,
};
