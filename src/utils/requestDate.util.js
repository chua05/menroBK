function dateOnlyInManila(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isValidDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateOnlyValue(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function validatePreferredReleaseDate(value, today = dateOnlyInManila()) {
  if (!isValidDateOnly(value)) return "Invalid preferred release date.";
  return dateOnlyValue(value) < dateOnlyValue(today)
    ? "Preferred release date cannot be in the past. Please select today or a future date."
    : "";
}

function validateProposedEventDate(value, today = dateOnlyInManila()) {
  if (!isValidDateOnly(value)) return "Invalid proposed event date.";
  return Number(value.slice(0, 4)) < Number(today.slice(0, 4))
    ? "Proposed event date cannot be from a past year. Please select a date within the current year or a future year."
    : "";
}

function validatePlantingSchedule({ proposedDate, startTime, endTime, isGroup, expectedParticipants }, now = new Date()) {
  const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!proposedDate) return { field: "activityDate", message: isGroup
    ? "Please select an event date." : "Please select a planned planting date." };
  if (!isValidDateOnly(proposedDate)) return { field: "activityDate", message: isGroup
    ? "Please select a valid event date." : "Please select a valid planned planting date." };
  if (dateOnlyValue(proposedDate) < dateOnlyValue(dateOnlyInManila(now))) return { field: "activityDate", message: isGroup
    ? "The event date cannot be in the past." : "The planting date cannot be in the past." };
  if (!startTime || !timePattern.test(startTime)) return { field: "startTime", message: isGroup
    ? "Please select a valid event start time." : "Please select a valid planned start time." };
  const start = new Date(`${proposedDate}T${startTime}:00+08:00`);
  if (Number.isNaN(start.getTime()) || start.getTime() <= now.getTime()) {
    return { field: "startTime", message: isGroup
      ? "The event start time must be in the future." : "The planned start time must be in the future." };
  }
  if (isGroup) {
    if (!endTime || !timePattern.test(endTime)) {
      return { field: "endTime", message: "Please select a valid event end time." };
    }
    if (endTime <= startTime) {
      return { field: "endTime", message: "Event end time must be later than the start time." };
    }
  }
  if (!Number.isInteger(Number(expectedParticipants)) || Number(expectedParticipants) <= 0) {
    return { field: "participants", message: isGroup
      ? "Please enter a valid number of participants." : "Please enter a valid number of planters." };
  }
  return null;
}

module.exports = { dateOnlyInManila, isValidDateOnly, validatePreferredReleaseDate,
  validateProposedEventDate, validatePlantingSchedule };
