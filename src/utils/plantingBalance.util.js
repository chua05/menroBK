function availableForReporting(event, item) {
  const key = item.inventoryId;
  return Math.max(0, Number(item.quantity || 0) - Number(event.recordedSeedlingsByInventory?.[key] || 0) -
    Number(event.pendingSeedlingsByInventory?.[key] || 0) - Number(event.leftoverSeedlingsByInventory?.[key] || 0));
}
function progressFor({ released, active, accepted, pending, leftovers = 0, acceptedLeftovers = 0, pendingLeftovers = 0 }) {
  if (released > 0 && accepted + acceptedLeftovers >= released && pending === 0 && pendingLeftovers === 0) return "Completed";
  if (released > 0 && active + leftovers >= released && pending + pendingLeftovers > 0) return "Fully Reported — Awaiting Review";
  return active + leftovers > 0 ? "Partial" : "Awaiting Submission";
}
function wholeQuantity(value) {
  return (typeof value === "number" || typeof value === "string" && /^\d+$/.test(value.trim())) &&
    String(value).trim() !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}
// Parent report states that still accept a participant report (the same states createPlantingReport accepts).
const REPORTABLE_PROGRESS = new Set(["Draft", "Pending", "Pending Review", "Awaiting Submission", "Partial", "Fully Reported — Awaiting Review"]);
// Nothing is left to report once every allocated type is planted, pending or declared left over. Returned and rejected reports
// give their quantities back, so their corrections stay possible.
function hasReportableBalance(event, parent) {
  if (parent && !REPORTABLE_PROGRESS.has(parent.reportingProgress || parent.verificationStatus)) return false;
  const items = Array.isArray(event?.seedlingItems) ? event.seedlingItems : [];
  if (!items.length) return true;
  return items.some((item) => Number(item.quantity || 0) - Number(event.recordedSeedlingsByInventory?.[item.inventoryId] || 0) -
    Number(event.pendingSeedlingsByInventory?.[item.inventoryId] || 0) - Number(event.leftoverSeedlingsByInventory?.[item.inventoryId] || 0) > 0);
}
module.exports = { hasReportableBalance, availableForReporting, progressFor, wholeQuantity };
