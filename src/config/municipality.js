const { createBoundaryProvider, selectBoundaryDataset } = require("./boundaryProvider");

function loadBarangayGeoJson(environment = process.env) {
  return selectBoundaryDataset(environment).geoJson;
}

const boundaryProvider = createBoundaryProvider();
const barangayGeoJson = boundaryProvider.geoJson;

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
  boundaryDataset: boundaryProvider.dataset,
  diagnoseBarangayPoint: boundaryProvider.diagnoseBarangayPoint,
  diagnoseMunicipalPoint: boundaryProvider.diagnoseMunicipalPoint,
  isPointWithinMunicipality: (latitude, longitude) =>
    boundaryProvider.diagnoseMunicipalPoint(latitude, longitude).inside,
  loadBarangayGeoJson,
};
