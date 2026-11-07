const test = require("node:test");
const assert = require("node:assert/strict");
const { _test: { validateWorkflow } } = require("../src/controller/seedlingRequest.controller");

const workflow = {
  sector: "Resident / Individual",
  effectiveRequestType: "individual",
  purpose: "Farm / Agricultural Planting",
  addressProvince: "Sorsogon", addressMunicipality: "Bulan", addressBarangay: "Zone VIII",
  street: "Purok 1", siteBarangay: "Zone VIII", areaChoice: "1 hectare",
  releaseMethod: "Pick-up", siteMode: "existing", existingSiteId: "site-1",
};
const validate = input => validateWorkflow(input, "Farm / Agricultural Planting");

test("seedling requests no longer require planting care information", () => {
  assert.doesNotThrow(() => validate(workflow));
});

test("requests with saved planting care information remain valid", () => {
  assert.doesNotThrow(() => validate({ ...workflow, caretaker: "Requester", carePlan: "Water weekly", monitoringFrequency: "Other" }));
});

test("other required request fields are still enforced", () => {
  assert.throws(() => validate({ ...workflow, releaseMethod: "" }));
});
