const dataset = require("../data/request-location-options.json");
const bulan = require("../data/bulan-barangays.json").features.map(row => row.properties.brgy_name || row.properties.NAME_3);
const clean = value => typeof value === "string" ? value.trim() : "";
const key = value => clean(value).normalize("NFC").toLocaleLowerCase().replace(/\s+/g, " ");
function barangayKey(value, isBulan) {
  if (!isBulan) return key(value);
  const zones = { "1": "i", "2": "ii", "3": "iii", "4": "iv", "5": "v", "6": "vi", "7": "vii", "8": "viii" };
  return key(value).replace(/[.\s-]+/g, "").replace(/poblacion$/, "").replace(/^zone([1-8])$/, (_, n) => `zone${zones[n]}`);
}
function requestLocationErrors(workflow = {}) {
  const errors = {};
  const provinceName = workflow.addressProvince === "Other" ? workflow.addressProvinceOther : workflow.addressProvince;
  const municipalityName = workflow.addressMunicipality === "Other" ? workflow.addressMunicipalityOther : workflow.addressMunicipality;
  const province = dataset.provinces.find(row => key(row.name) === key(provinceName));
  if (!province) errors.addressProvince = "Select a province from the supported location list.";
  const municipality = province?.municipalities.find(row => key(row.name) === key(municipalityName));
  if (!municipality) errors.addressMunicipality = "Select a municipality belonging to the selected province.";
  const isBulan = key(provinceName) === "sorsogon" && key(municipalityName) === "bulan";
  const choices = isBulan ? bulan : municipality?.barangays || [];
  if (!clean(workflow.addressBarangay) || !choices.some(name => barangayKey(name, isBulan) === barangayKey(workflow.addressBarangay, isBulan))) {
    errors.addressBarangay = "Select a barangay belonging to the selected municipality.";
  }
  if (!bulan.some(name => barangayKey(name, true) === barangayKey(workflow.siteBarangay, true))) errors.siteBarangay = "Select a registered Bulan planting-site barangay.";
  return errors;
}
module.exports = { requestLocationErrors };
