const barangayGeoJson = require("../data/bulan-barangays.json");

const MUNICIPALITY = "Bulan";
const PROVINCE = "Sorsogon";
const BARANGAYS = Object.freeze(
  barangayGeoJson.features.map((feature) => feature.properties.brgy_name)
);
const BARANGAY_SET = new Set(BARANGAYS);

module.exports = {
  MUNICIPALITY,
  PROVINCE,
  BARANGAYS,
  BARANGAY_SET,
  barangayGeoJson,
};
