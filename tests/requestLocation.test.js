const test = require("node:test");
const assert = require("node:assert/strict");
const { requestLocationErrors } = require("../src/utils/requestLocation.util");
const base = { addressProvince: "Sorsogon", addressMunicipality: "Bulan", addressBarangay: "Bical", siteBarangay: "Bical" };
test("barangay membership is scoped to the selected province and municipality", () => {
  assert.deepEqual(requestLocationErrors(base), {});
  for (const value of ["123", 123, "Not a barangay", "Barangay 1", "B!ical", ""]) assert.ok(requestLocationErrors({ ...base, addressBarangay: value }).addressBarangay);
  assert.ok(requestLocationErrors({ ...base, addressMunicipality: "Bulusan" }).addressBarangay);
  assert.ok(requestLocationErrors({ ...base, addressProvince: "Albay" }).addressMunicipality);
});
test("legacy Bulan zones and supported Other parents normalize without accepting arbitrary text", () => {
  assert.deepEqual(requestLocationErrors({ ...base, addressBarangay: "Zone 8" }), {});
  assert.deepEqual(requestLocationErrors({ ...base, addressProvince: "Other", addressProvinceOther: "Sorsogon", addressMunicipality: "Other", addressMunicipalityOther: "Bulan" }), {});
  assert.ok(requestLocationErrors({ ...base, siteBarangay: "free text" }).siteBarangay);
});
