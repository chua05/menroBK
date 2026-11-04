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
module.exports = { availableForReporting, progressFor, wholeQuantity };
