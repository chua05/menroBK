const MANILA_OFFSET = "+08:00";
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const RELATIONSHIP_FIELDS = ["name", "type", "barangay", "plantingSiteId", "location",
  "date", "startTime", "endTime", "expectedParticipants"];

function parseManilaEventTime(dateValue, timeValue) {
  const date = String(dateValue || "").match(DATE_PATTERN);
  const time = String(timeValue || "").match(TIME_PATTERN);
  if (!date || !time) return null;
  const [, year, month, day] = date.map(Number);
  const [, hour, minute] = time.map(Number);
  if (hour > 23 || minute > 59) return null;
  const value = new Date(`${dateValue}T${timeValue}:00${MANILA_OFFSET}`);
  if (Number.isNaN(value.getTime())) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return value;
}

function eventScheduleStatus(event = {}, now = new Date()) {
  const start = parseManilaEventTime(event.date, event.startTime);
  if (!start) return { status: "Invalid Schedule", scheduleValid: false, reason: "A valid event date and start time are required." };
  const endTime = event.endTime || "23:59";
  let end = parseManilaEventTime(event.date, endTime);
  if (!end) return { status: "Invalid Schedule", scheduleValid: false, reason: "The event end time is invalid." };
  if (end < start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) throw new Error("A valid current time is required.");
  if (current > end) return { status: "Completed", scheduleValid: true, start, end };
  if (current >= start) return { status: "Ongoing", scheduleValid: true, start, end };
  return { status: "Upcoming", scheduleValid: true, start, end };
}

function presentEventStatus(event, now = new Date()) {
  const computed = eventScheduleStatus(event, now);
  return {
    ...event,
    persistedStatus: event.status || "",
    status: computed.status,
    scheduleValid: computed.scheduleValid,
    ...(computed.reason ? { scheduleStatusMessage: computed.reason } : {}),
  };
}

function protectedEventFieldsChanged(existing = {}, updates = {}) {
  return RELATIONSHIP_FIELDS.some((field) => updates[field] !== undefined &&
    String(updates[field] ?? "").trim() !== String(existing[field] ?? "").trim());
}

function assertEventUpdateAllowed(existing, updates, now = new Date()) {
  const changed = protectedEventFieldsChanged(existing, updates);
  if (!changed) return;
  if (existing.source === "seedling_request" && existing.sourceRequestId) {
    const error = new Error("Request-backed event details must be changed through the linked Seedling Request workflow.");
    error.code = "REQUEST_EVENT_RELATIONSHIP_LOCKED";
    throw error;
  }
  if (String(existing.recordStatus || "").toLowerCase() === "completed" ||
      eventScheduleStatus(existing, now).status === "Completed") {
    const error = new Error("Completed event schedule and relationship details cannot be changed.");
    error.code = "COMPLETED_EVENT_RELATIONSHIP_LOCKED";
    throw error;
  }
}

function hasLinkedEventRecords(event = {}, snapshots = []) {
  return Boolean(event.sourceRequestId) || snapshots.some((snapshot) => !snapshot.empty);
}

module.exports = { eventScheduleStatus, presentEventStatus, protectedEventFieldsChanged,
  assertEventUpdateAllowed, hasLinkedEventRecords };
