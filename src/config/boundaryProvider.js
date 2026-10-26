const currentGeoJson = require("../data/bulan-barangays.json");
const mpdoGeoJson = require("../data/bulan-barangays-mpdo-candidate.json");
const {
  getContainingGeoJsonFeatures,
} = require("../utils/geo.util");

const DATASETS = Object.freeze({
  current: Object.freeze({
    id: "menro-current",
    version: "bulan-barangays-current",
    geoJson: currentGeoJson,
  }),
  "mpdo-candidate": Object.freeze({
    id: "mpdo-bulan",
    version: mpdoGeoJson.metadata?.sourceDataset || "brgy_bound_WGS84_Bulan",
    geoJson: mpdoGeoJson,
  }),
});

const MUNICIPAL_POLICY = "selected-or-current-compatibility-v1";

function selectBoundaryDataset(environment = process.env, datasets = DATASETS) {
  const requested = String(environment.MENRO_TEST_BOUNDARY_SOURCE || "").trim();
  // Production default selected by the approved MPDO activation. The old
  // dataset remains available only as the municipality compatibility and
  // code-rollback source; no production environment selector is introduced.
  if (!requested) return datasets["mpdo-candidate"];
  if (requested !== "mpdo-candidate") {
    throw new Error(`Unsupported MENRO_TEST_BOUNDARY_SOURCE: ${requested}`);
  }
  if (environment.NODE_ENV !== "test") {
    throw new Error("The MPDO candidate boundary override is restricted to NODE_ENV=test.");
  }
  return datasets[requested];
}

function featureName(feature) {
  return String(feature?.properties?.brgy_name || "");
}

function diagnoseBarangayPoint(latitude, longitude, geoJson) {
  const features = getContainingGeoJsonFeatures(latitude, longitude, geoJson);
  const matches = features.map(featureName).filter(Boolean);
  return {
    status: matches.length === 0 ? "gap" : matches.length === 1 ? "single" : "ambiguous",
    matches,
  };
}

function createBoundaryProvider(environment = process.env, datasets = DATASETS) {
  const selected = selectBoundaryDataset(environment, datasets);
  const selectedDiagnostic = (latitude, longitude) =>
    diagnoseBarangayPoint(latitude, longitude, selected.geoJson);

  return Object.freeze({
    dataset: selected,
    geoJson: Object.freeze({
      ...selected.geoJson,
      metadata: Object.freeze({
        ...(selected.geoJson.metadata || {}),
        datasetId: selected.id,
        datasetVersion: selected.version,
        status: selected.id === "mpdo-bulan" ? "selected_reference" : "rollback_reference",
        featureCount: selected.geoJson.features.length,
        municipalContainmentPolicy: MUNICIPAL_POLICY,
      }),
    }),
    diagnoseBarangayPoint: selectedDiagnostic,
    diagnoseMunicipalPoint(latitude, longitude) {
      const selectedResult = selectedDiagnostic(latitude, longitude);
      if (selectedResult.matches.length) {
        return { inside: true, basis: "selected", ...selectedResult };
      }

      // Temporary conservative compatibility envelope. This does not change or
      // repair MPDO geometry: an MPDO gap remains status=gap for barangay
      // assignment, while coordinates accepted by the previous dataset remain
      // eligible for municipality-level workflows.
      const currentResult = diagnoseBarangayPoint(latitude, longitude, datasets.current.geoJson);
      if (currentResult.matches.length) {
        return {
          inside: true,
          basis: "current-compatibility",
          status: "gap",
          matches: [],
          compatibilityMatches: currentResult.matches,
        };
      }
      return { inside: false, basis: "none", status: "outside", matches: [] };
    },
  });
}

module.exports = {
  DATASETS,
  MUNICIPAL_POLICY,
  createBoundaryProvider,
  diagnoseBarangayPoint,
  selectBoundaryDataset,
};
