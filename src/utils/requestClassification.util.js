const contract = require("../data/requestWorkflow.json");
function classifyRequest(workflow = {}) {
  if (contract.organizationSectors.includes(workflow.sector)) return "organization";
  if (["School / Student", "Other (please specify)"].includes(workflow.sector)) {
    if (["individual", "group"].includes(workflow.requestingAs)) return workflow.requestingAs === "group" ? "organization" : "individual";
    // Historical school records are ambiguous unless a type was explicitly recorded.
    return null;
  }
  return ["Resident / Individual", "Student (Individual)"].includes(workflow.sector) ? "individual" : null;
}
function canonicalPurpose(purpose, workflow = {}) {
  const selected = workflow.purpose || purpose;
  return contract.purposes.includes(selected) ? selected : contract.legacyPurposes[selected] || "Other";
}
module.exports = { contract, classifyRequest, canonicalPurpose };
