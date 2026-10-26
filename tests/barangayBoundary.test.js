const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const { barangayGeoJson, BARANGAYS, loadBarangayGeoJson } = require("../src/config/municipality");
const activeBarangayGeoJson = require("../src/data/bulan-barangays.json");
const mpdoBarangayGeoJson = require("../src/data/bulan-barangays-mpdo-candidate.json");
const { isPointInGeoJsonFeatureCollection } = require("../src/utils/geo.util");
const { createBoundaryProvider, diagnoseBarangayPoint } = require("../src/config/boundaryProvider");

const square = (name, minX, minY, maxX, maxY) => ({
  type: "Feature",
  properties: { brgy_name: name },
  geometry: { type: "Polygon", coordinates: [[
    [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
  ]] },
});
const collection = (...features) => ({ type: "FeatureCollection", features });

test("boundary endpoint returns the same 63-feature dataset used by backend validation", () => {
  // Controller integration without Firebase initialization or any database access.
  const originalLoad = Module._load;
  let controller;
  try {
    Module._load = function (request, parent, isMain) {
      if (parent?.filename.endsWith("site.controller.js") && request === "../services/site.service") return {};
      return originalLoad.call(this, request, parent, isMain);
    };
    controller = require("../src/controller/site.controller");
  } finally {
    Module._load = originalLoad;
  }
  let status, body;
  const headers = {};
  controller.getBarangayBoundaries({}, {
    setHeader(name, value) { headers[name] = value; },
    status(value) { status = value; return this; },
    json(value) { body = value; },
  });
  assert.equal(status, 200);
  assert.equal(headers["Cache-Control"], "no-cache, must-revalidate");
  assert.equal(body, barangayGeoJson);
  assert.equal(body.features.length, 63);
  assert.deepEqual(body.metadata, {
    ...mpdoBarangayGeoJson.metadata,
    datasetId: "mpdo-bulan",
    datasetVersion: "brgy_bound_WGS84_Bulan",
    status: "selected_reference",
    featureCount: 63,
    municipalContainmentPolicy: "selected-or-current-compatibility-v1",
  });
  assert.deepEqual(body.features.map(feature => feature.properties.brgy_name), BARANGAYS);
});

test("GeoJSON longitude/latitude ordering and polygon holes are preserved", () => {
  const data = { type: "FeatureCollection", features: [{ type: "Feature", geometry: {
    type: "MultiPolygon", coordinates: [[[[123, 12], [124, 12], [124, 13], [123, 13], [123, 12]],
      [[123.2, 12.2], [123.8, 12.2], [123.8, 12.8], [123.2, 12.8], [123.2, 12.2]]]]
  } }] };
  const before = JSON.stringify(data);
  assert.equal(isPointInGeoJsonFeatureCollection(12.1, 123.1, data), true);
  assert.equal(isPointInGeoJsonFeatureCollection(12.5, 123.5, data), false);
  assert.equal(isPointInGeoJsonFeatureCollection(123.1, 12.1, data), false);
  assert.equal(JSON.stringify(data), before);
});

test("boundary diagnostics are deterministic for single, overlap, shared edge, gap, and holes", () => {
  const left = square("Left", 0, 0, 2, 2);
  const right = square("Right", 2, 0, 4, 2);
  const overlap = square("Overlap", 1, 1, 3, 3);
  assert.deepEqual(diagnoseBarangayPoint(0.5, 0.5, collection(left, right)), {
    status: "single", matches: ["Left"],
  });
  assert.deepEqual(diagnoseBarangayPoint(0.5, 2, collection(left, right)), {
    status: "ambiguous", matches: ["Left", "Right"],
  });
  assert.deepEqual(diagnoseBarangayPoint(1.5, 1.5, collection(left, overlap)), {
    status: "ambiguous", matches: ["Left", "Overlap"],
  });
  assert.deepEqual(diagnoseBarangayPoint(5, 5, collection(left)), {
    status: "gap", matches: [],
  });
  const withHole = structuredClone(left);
  withHole.geometry.coordinates.push([[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]);
  assert.equal(diagnoseBarangayPoint(1, 1, collection(withHole)).status, "gap");
  assert.equal(diagnoseBarangayPoint(0.5, 1, collection(withHole)).status, "single");
});

test("MPDO gap policy keeps barangay gap unassigned while preserving prior municipal eligibility", () => {
  const datasets = {
    current: { id: "current", version: "1", geoJson: collection(square("Old", 0, 0, 4, 4)) },
    "mpdo-candidate": { id: "mpdo", version: "2", geoJson: collection(square("New", 0, 0, 1, 1)) },
  };
  const provider = createBoundaryProvider(
    { NODE_ENV: "test", MENRO_TEST_BOUNDARY_SOURCE: "mpdo-candidate" }, datasets
  );
  assert.deepEqual(provider.diagnoseBarangayPoint(2, 2), { status: "gap", matches: [] });
  assert.deepEqual(provider.diagnoseMunicipalPoint(2, 2), {
    inside: true,
    basis: "current-compatibility",
    status: "gap",
    matches: [],
    compatibilityMatches: ["Old"],
  });
  assert.equal(provider.diagnoseMunicipalPoint(5, 5).inside, false);
  assert.equal(provider.geoJson.metadata.datasetId, "mpdo");
  assert.equal(provider.geoJson.metadata.datasetVersion, "2");
});

test("MPDO source preserves all MENRO names and official source names", () => {
  const candidate = loadBarangayGeoJson({ NODE_ENV: "test", MENRO_TEST_BOUNDARY_SOURCE: "mpdo-candidate" });
  assert.equal(candidate.metadata.status, "candidate_not_active");
  assert.equal(candidate.features.length, 63);
  assert.equal(new Set(candidate.features.map(feature => feature.properties.brgy_name)).size, 63);
  assert.equal(new Set(candidate.features.map(feature => feature.properties.mpdo_name)).size, 63);
  assert.deepEqual(
    candidate.features.map(feature => feature.properties.brgy_name).sort(),
    [...BARANGAYS].sort()
  );
  const aliases = new Map(candidate.features.map(feature => [feature.properties.mpdo_name, feature.properties.brgy_name]));
  assert.equal(aliases.get("N. Roque (Rizal)"), "N.Roque");
  assert.equal(aliases.get("G. Del Pilar (Tanga)"), "G.DelPilar");
  assert.equal(aliases.get("J.P. Laurel (Pon-od)"), "J.P.Laurel");
  assert.equal(aliases.get("Benigno S. Aquino (Imelda)"), "BenignoS.Aquino");
  for (const numeral of ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"]) {
    const match = [...aliases].find(([official]) => official.startsWith(`Zone ${numeral} Pob.`));
    assert.equal(match?.[1], `Zone${numeral}Poblacion`);
  }
});

test("MPDO test override is fail-closed outside the test environment", () => {
  assert.throws(
    () => loadBarangayGeoJson({ NODE_ENV: "production", MENRO_TEST_BOUNDARY_SOURCE: "mpdo-candidate" }),
    /restricted to NODE_ENV=test/
  );
  assert.throws(
    () => loadBarangayGeoJson({ NODE_ENV: "test", MENRO_TEST_BOUNDARY_SOURCE: "unexpected" }),
    /Unsupported MENRO_TEST_BOUNDARY_SOURCE/
  );
  assert.equal(loadBarangayGeoJson({ NODE_ENV: "production" }), mpdoBarangayGeoJson);
  assert.notEqual(loadBarangayGeoJson({ NODE_ENV: "production" }), activeBarangayGeoJson);
});

test("production provider selects MPDO without Firebase initialization or environment configuration", () => {
  const provider = createBoundaryProvider({ NODE_ENV: "production" });
  assert.equal(provider.dataset.id, "mpdo-bulan");
  assert.equal(provider.dataset.version, "brgy_bound_WGS84_Bulan");
  assert.equal(provider.geoJson.metadata.status, "selected_reference");
  assert.equal(provider.geoJson.metadata.featureCount, 63);
  assert.equal(provider.geoJson.metadata.municipalContainmentPolicy,
    "selected-or-current-compatibility-v1");
  assert.equal(provider.geoJson.features, mpdoBarangayGeoJson.features);
});
