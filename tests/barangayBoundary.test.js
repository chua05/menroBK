const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const { barangayGeoJson, BARANGAYS } = require("../src/config/municipality");
const { isPointInGeoJsonFeatureCollection } = require("../src/utils/geo.util");

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
  controller.getBarangayBoundaries({}, { status(value) { status = value; return this; }, json(value) { body = value; } });
  assert.equal(status, 200);
  assert.equal(body, barangayGeoJson);
  assert.equal(body.features.length, 63);
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
