const assert = require("node:assert/strict");
const test = require("node:test");

const firebasePath = require.resolve("../src/config/firebase");
const municipalityPath = require.resolve("../src/config/municipality");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true,
  exports: { db: {} } };
require.cache[municipalityPath] = { id: municipalityPath, filename: municipalityPath, loaded: true,
  exports: { barangayGeoJson: { type: "FeatureCollection", features: [{ type: "Feature",
    geometry: { type: "Polygon", coordinates: [[[123, 12], [125, 12], [125, 14], [123, 14], [123, 12]]] } }] } } };

const { SESSION_TTL_MS, MAX_ACCURACY_METERS, SITE_FALLBACK_METERS, _test } = require("../src/services/evidenceCaptureSession.service");

test("capture policy uses a five-minute lifetime and 50 metre accuracy", () => {
  assert.equal(SESSION_TTL_MS, 300000);
  assert.equal(MAX_ACCURACY_METERS, 50);
  assert.equal(SITE_FALLBACK_METERS, 50);
});

test("capture bindings require workflow target identifiers", () => {
  assert.deepEqual(_test.parseBinding("planting-report", { siteId: "site-1", eventId: "event-1",
    distributionId: "dist-1" }), { workflow: "planting-report", siteId: "site-1",
    eventId: "event-1", distributionId: "dist-1" });
  assert.throws(() => _test.parseBinding("monitoring-resubmit", { siteId: "site-1",
    plantingReportId: "report-1" }), /observation and version/i);
});

test("location validation rejects inaccurate, outside-Bulan, and outside-site captures", () => {
  const site = { latitude: 13, longitude: 124, coverageRadiusMeters: 50 };
  assert.equal(_test.validateLocation(site, { latitude: 13, longitude: 124, accuracy: 49 }).accuracyMeters, 49);
  assert.equal(_test.validateLocation(site, { latitude: 13, longitude: 124, accuracy: 50 }).accuracyMeters, 50);
  assert.throws(() => _test.validateLocation(site, { latitude: 13, longitude: 124, accuracy: 51 }),
    error => error.code === "CAPTURE_LOCATION_INACCURATE");
  assert.throws(() => _test.validateLocation(site, { latitude: 10, longitude: 120, accuracy: 5 }),
    error => error.code === "CAPTURE_LOCATION_OUTSIDE_BULAN");
  assert.throws(() => _test.validateLocation(site, { latitude: 13.01, longitude: 124.01, accuracy: 5 }),
    error => error.code === "CAPTURE_LOCATION_OUTSIDE_SITE");
});

test("GPS accuracy and 50 metre site fallback are enforced independently at their boundaries", () => {
  const site = { latitude: 13, longitude: 124 };
  const latitudeAt = meters => 13 + meters / 111195;
  for (const accuracy of [49, 50]) {
    assert.equal(_test.validateLocation(site, { latitude: 13, longitude: 124, accuracy }).accuracyMeters, accuracy);
  }
  assert.throws(() => _test.validateLocation(site, { latitude: 13, longitude: 124, accuracy: 51 }),
    error => error.code === "CAPTURE_LOCATION_INACCURATE");
  for (const distance of [49, 50]) {
    assert.ok(_test.validateLocation(site, { latitude: latitudeAt(distance), longitude: 124, accuracy: 1 }).distanceMeters <= 50);
  }
  assert.throws(() => _test.validateLocation(site, { latitude: latitudeAt(51), longitude: 124, accuracy: 1 }),
    error => error.code === "CAPTURE_LOCATION_OUTSIDE_SITE");
});

test("validated camera locations report the authoritative boundary rule and distance", () => {
  const configured = _test.validateLocation({ latitude: 13, longitude: 124, coverageRadiusMeters: 75 },
    { latitude: 13, longitude: 124, accuracy: 10 });
  assert.equal(configured.boundaryRule, "configured-radius");
  assert.equal(configured.boundaryLimitMeters, 75);
  assert.equal(configured.distanceMeters, 0);

  const polygon = _test.validateLocation({ latitude: 13, longitude: 124,
    polygon: [{ lat: 12.9, lng: 123.9 }, { lat: 13.1, lng: 123.9 },
      { lat: 13.1, lng: 124.1 }, { lat: 12.9, lng: 124.1 }] },
  { latitude: 13, longitude: 124, accuracy: 10 });
  assert.equal(polygon.boundaryRule, "site-polygon");
  assert.equal(polygon.boundaryLimitMeters, null);

  const fallback = _test.validateLocation({ latitude: 13, longitude: 124 },
    { latitude: 13, longitude: 124, accuracy: 10 });
  assert.equal(fallback.boundaryRule, "50m-fallback");
  assert.equal(fallback.boundaryLimitMeters, 50);
});

test("nonce comparison is hash-bound and rejects altered values", () => {
  const hash = _test.sha256("one-use-nonce");
  assert.equal(_test.nonceMatches(hash, "one-use-nonce"), true);
  assert.equal(_test.nonceMatches(hash, "changed"), false);
});
