const EXACT_AREA_CHOICES = new Set(["Less than 1 hectare", "6–10 hectares", "More than 10 hectares", "Other / Exact Area"]);
const FIXED_AREAS = Object.freeze({ "1 hectare": 1, "2 hectares": 2, "3 hectares": 3, "4 hectares": 4, "5 hectares": 5 });
function plantingArea(areaChoice, exactArea, { optional = false } = {}) {
  const choice = typeof areaChoice === "string" ? areaChoice.trim() : "";
  if (!choice && optional) return { hectares: null, error: "", field: "areaChoice" };
  if (!choice) return { hectares: null, error: "Select the planting area.", field: "areaChoice" };
  if (Object.hasOwn(FIXED_AREAS, choice)) return { hectares: FIXED_AREAS[choice], error: "", field: "areaChoice" };
  if (!EXACT_AREA_CHOICES.has(choice)) return { hectares: null, error: "Select a valid planting area.", field: "areaChoice" };
  const text = typeof exactArea === "number" ? String(exactArea) : typeof exactArea === "string" ? exactArea.trim() : "";
  const value = Number(text);
  let error = (typeof exactArea !== "number" && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) || !Number.isFinite(value) || value <= 0
    ? "Enter a positive, finite planting area in hectares." : "";
  if (!error && choice === "Less than 1 hectare" && value >= 1) error = "Enter an area greater than 0 and less than 1 hectare.";
  if (!error && choice === "6–10 hectares" && (value < 6 || value > 10)) error = "Enter an area from 6 to 10 hectares.";
  if (!error && choice === "More than 10 hectares" && value <= 10) error = "Enter an area greater than 10 hectares.";
  return { hectares: error ? null : value, error, field: "exactArea" };
}
function normalizeRequestPlantingArea(workflow) {
  if (!workflow || !["existing", "proposed"].includes(workflow.siteMode)) return workflow;
  const clientWorkflow = { ...workflow };
  // Site registration and review metadata are owned by MENRO, never by a requester.
  for (const field of ["officialSiteId", "officialSiteNumber", "proposedSiteVerification", "siteVerification", "reviewedBy", "reviewedAt", "areaSource"]) delete clientWorkflow[field];
  // An existing site's registered area is authoritative; requester area input is ignored
  // and replaced from the site record by applyRegisteredSiteArea().
  if (workflow.siteMode === "existing") return { ...clientWorkflow, areaChoice: "", exactArea: "", areaHectares: null, plantingAreaHectares: null };
  const area = plantingArea(workflow.areaChoice, workflow.exactArea, { optional: workflow.siteMode === "proposed" });
  if (area.error) throw Object.assign(new Error(area.error), { status: 400, fieldErrors: { [area.field]: area.error } });
  return { ...clientWorkflow, areaHectares: area.hectares, ...(workflow.siteMode === "proposed" ? { siteReviewRequired: true } : {}), exactArea: EXACT_AREA_CHOICES.has(workflow.areaChoice) ? workflow.exactArea : "" };
}
function registeredSiteArea(site) {
  const hectares = Number(site?.areaHectares);
  return site?.areaHectares !== null && site?.areaHectares !== "" && Number.isFinite(hectares) && hectares > 0 ? hectares : null;
}
function applyRegisteredSiteArea(workflow, site) {
  if (!workflow || workflow.siteMode !== "existing" || !site) return workflow;
  const hectares = registeredSiteArea(site);
  return { ...workflow, areaHectares: hectares, plantingAreaHectares: hectares, areaSource: "registered-site" };
}
function verifiedProposedSite(values, staffId) {
  const area = plantingArea("Other / Exact Area", values?.areaHectares);
  const capacity = values?.maximumCapacity;
  const fieldErrors = {};
  if (area.error) fieldErrors.verifiedAreaHectares = area.error;
  if ((typeof capacity !== "string" && typeof capacity !== "number") || String(capacity).trim() === "" || !/^\d+$/.test(String(capacity)) || !Number.isSafeInteger(Number(capacity)) || Number(capacity) <= 0) fieldErrors.verifiedMaximumCapacity = "Enter the verified capacity as a positive whole number.";
  if (Object.keys(fieldErrors).length) throw Object.assign(new Error("Enter the Staff-verified proposed site area and capacity."), { status: 400, fieldErrors });
  if (!staffId) throw new Error("An authenticated Staff reviewer is required.");
  return { areaHectares: area.hectares, maximumCapacity: Number(capacity), reviewedBy: staffId };
}
module.exports = { plantingArea, EXACT_AREA_CHOICES, normalizeRequestPlantingArea, verifiedProposedSite, registeredSiteArea, applyRegisteredSiteArea };
