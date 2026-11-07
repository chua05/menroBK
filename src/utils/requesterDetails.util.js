// Mirrors menrofrontend/src/utils/requesterDetails.js.
const ORGANIZATION_KEY = "organizationName";
const DETAIL_FIELDS = Object.freeze({
  "Barangay Official": { key: "positionInBarangay", label: "Position in Barangay" },
  "Student (Individual)": { key: "schoolName", label: "School Name" },
  "School Organization Representative": { key: ORGANIZATION_KEY, label: "School / Organization Name" },
  "Private Sector / Business": { key: ORGANIZATION_KEY, label: "Business / Company Name" },
  "Civic Organization / NGO": { key: ORGANIZATION_KEY, label: "Organization Name" },
  "Government Agency": { key: ORGANIZATION_KEY, label: "Government Agency / Office Name" },
  "Other (please specify)": { key: "sectorOther", label: "Specify Requester Type" },
});

function requesterDetailField(workflow = {}) {
  if (workflow.sector === "School / Student") {
    return workflow.requestingAs === "group" ? { key: ORGANIZATION_KEY, label: "School / Organization Name" } : null;
  }
  return DETAIL_FIELDS[workflow.sector] || null;
}

module.exports = { ORGANIZATION_KEY, requesterDetailField };
