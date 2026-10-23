function integer(env, name, fallback, maximum) {
  const value = env[name] === undefined ? String(fallback) : env[name];
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`Invalid ${name}: expected a bounded positive whole number.`);
  }
  return Number(value);
}
function resolveEvidenceUploadQuotaConfig(env = process.env) {
  return Object.freeze({
    fileLimit: integer(env, "EVIDENCE_DAILY_FILE_LIMIT", 50, 1_000_000),
    byteLimit: integer(env, "EVIDENCE_DAILY_BYTE_LIMIT", 200 * 1024 * 1024, 1024 ** 4),
    alertBytes: integer(env, "EVIDENCE_GLOBAL_DAILY_ALERT_BYTES", 1024 ** 3, 1024 ** 4),
  });
}
function manilaDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid quota date.");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = type => parts.find(item => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
module.exports = { resolveEvidenceUploadQuotaConfig, manilaDay };
