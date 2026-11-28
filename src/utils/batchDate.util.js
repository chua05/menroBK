// Batch received dates are shown and snapshotted as Manila YYYY-MM-DD text; legacy Timestamp/Date values are converted.
const batchDateText = (value) => {
  if (typeof value === "string") return value.trim();
  const date = typeof value?.toDate === "function" ? value.toDate() : value instanceof Date ? value : null;
  return date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
    : "";
};

module.exports = { batchDateText };
