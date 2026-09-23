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

function validatePreferredReleaseDate(value, today = dateOnlyInManila()) {
  if (!isValidDateOnly(value)) return "Invalid preferred release date.";
  return value < today
    ? "Preferred release date cannot be in the past. Please select today or a future date."
    : "";
}

function validateProposedEventDate(value, today = dateOnlyInManila()) {
  if (!isValidDateOnly(value)) return "Invalid proposed event date.";
  return Number(value.slice(0, 4)) < Number(today.slice(0, 4))
    ? "Proposed event date cannot be from a past year. Please select a date within the current year or a future year."
    : "";
}

module.exports = { dateOnlyInManila, isValidDateOnly, validatePreferredReleaseDate, validateProposedEventDate };
