const test = require("node:test");
const assert = require("node:assert/strict");
const { _test: { validateWorkflow } } = require("../src/controller/seedlingRequest.controller");
const { isValidPhilippineContactNumber } = require("../src/utils/philippineContact.util");

const base = {
  requestContractVersion: 2, purpose: "Household / Backyard", eventName: "Fixture activity",
  addressProvince: "Sorsogon", addressMunicipality: "Bulan", addressBarangay: "Zone VIII",
  street: "Purok 1", siteBarangay: "Zone VIII", areaChoice: "1 hectare",
  releaseMethod: "Pick-up", siteMode: "existing", existingSiteId: "site-1",
};
const validate = input => validateWorkflow({ ...base, ...input }, "Household / Backyard");
const fieldErrors = input => { try { validate(input); return {}; } catch (error) { return error.fieldErrors || error.errors || { message: error.message }; } };

test("a resident needs no additional requester field", () => {
  assert.doesNotThrow(() => validate({ sector: "Resident / Individual" }));
});

for (const [sector, field, value] of [
  ["Barangay Official", "positionInBarangay", "Kagawad"],
  ["Student (Individual)", "schoolName", "Bulan National High School"],
  ["School Organization Representative", "organizationName", "Bulan NHS Eco Club"],
  ["Private Sector / Business", "organizationName", "Acme Inc."],
  ["Civic Organization / NGO", "organizationName", "Green Bulan"],
  ["Government Agency", "organizationName", "DENR Sorsogon"],
  ["Other (please specify)", "sectorOther", "Farmer Cooperative"],
]) test(`${sector} requires only ${field}`, () => {
  const classified = sector.startsWith("Other") ? { requestingAs: "individual" } : {};
  assert.throws(() => validate({ sector, ...classified }));
  assert.doesNotThrow(() => validate({ sector, ...classified, [field]: value }));
});

test("Barangay Official no longer requires an organization name", () => {
  assert.equal(fieldErrors({ sector: "Barangay Official", positionInBarangay: "Kagawad" }).organizationName, undefined);
});

test("a blank requester detail is rejected", () => {
  assert.throws(() => validate({ sector: "Barangay Official", positionInBarangay: "   " }));
});

test("requests from before this contract keep their older rules", () => {
  assert.doesNotThrow(() => validate({ requestContractVersion: 1, sector: "Barangay Official" }));
});

test("contact validation accepts Philippine mobile and landline numbers only", () => {
  for (const value of ["09171234567", "+639171234567", "0917 123 4567", "(02) 8888 1234", "(056) 211-1234", "+63562111234"]) assert.equal(isValidPhilippineContactNumber(value), true, value);
  for (const value of ["", "12345", "0917123456", "+19171234567"]) assert.equal(isValidPhilippineContactNumber(value), false, value);
});
