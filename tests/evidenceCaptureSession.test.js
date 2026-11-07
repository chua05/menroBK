const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const firebasePath = require.resolve("../src/config/firebase");
const municipalityPath = require.resolve("../src/config/municipality");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true,
  exports: { db: {} } };
require.cache[municipalityPath] = { id: municipalityPath, filename: municipalityPath, loaded: true,
  exports: { isPointWithinMunicipality: (lat, lng) => lat >= 12 && lat <= 14 && lng >= 123 && lng <= 125,
    barangayGeoJson: { type: "FeatureCollection", features: [{ type: "Feature",
    geometry: { type: "Polygon", coordinates: [[[123, 12], [125, 12], [125, 14], [123, 14], [123, 12]]] } }] } } };

const { SESSION_TTL_MS, MAX_ACCURACY_METERS, SITE_FALLBACK_METERS, _test } = require("../src/services/evidenceCaptureSession.service");

test("capture policy uses a five-minute lifetime and 50 metre accuracy", () => {
  assert.equal(SESSION_TTL_MS, 300000);
  assert.equal(MAX_ACCURACY_METERS, 50);
  assert.equal(SITE_FALLBACK_METERS, 50);
});

test("planting submission and contribution fallbacks stay aligned at 50 metres", () => {
  const serviceRoot = join(__dirname, "..", "src", "services");
  const reportService = readFileSync(join(serviceRoot, "plantingReport.service.js"), "utf8");
  const contributionService = readFileSync(join(serviceRoot, "plantingEvidence.service.js"), "utf8");
  assert.match(reportService, /const SITE_GPS_TOLERANCE_METERS\s*=\s*50/);
  assert.match(contributionService, /const SITE_GPS_TOLERANCE_METERS\s*=\s*50/);
});

test("capture bindings require workflow target identifiers", () => {
  assert.deepEqual(_test.parseBinding("planting-report", { siteId: "site-1", eventId: "event-1",
    distributionId: "dist-1" }), { workflow: "planting-report", siteId: "site-1",
    eventId: "event-1", distributionId: "dist-1" });
  assert.throws(() => _test.parseBinding("monitoring-resubmit", { siteId: "site-1",
    plantingReportId: "report-1" }), /observation and version/i);
  assert.deepEqual(_test.parseBinding("cohort-baseline", { cohortId: "cohort-1", siteId: "site-1",
    sampleId: "TREE-001", samplingPlanVersion: 2 }), { workflow: "cohort-baseline", cohortId: "cohort-1",
    siteId: "site-1", sampleId: "TREE-001", samplingPlanVersion: 2 });
  assert.throws(() => _test.parseBinding("cohort-baseline", { cohortId: "cohort-1", siteId: "site-1", sampleId: "TREE-001" }),
    /sampling-plan version/i);
});

test("sample-monitoring capture binding is versioned, permanent-sample scoped, and does not accept omissions", () => {
  const binding = _test.parseBinding("sample-monitoring", {
    cohortId: "VPC-1", siteId: "site-1", visitId: "VPMV-1", sampleId: "TREE-001",
    samplingPlanVersion: 2, baselineVersion: 3, visitVersion: 4, assessmentRevision: 5,
  });
  assert.deepEqual(binding, { workflow: "sample-monitoring", cohortId: "VPC-1", siteId: "site-1", visitId: "VPMV-1", sampleId: "TREE-001", samplingPlanVersion: 2, baselineVersion: 3, visitVersion: 4, assessmentRevision: 5 });
  assert.throws(() => _test.parseBinding("sample-monitoring", { cohortId: "VPC-1", siteId: "site-1", visitId: "VPMV-1", sampleId: "TREE-001", samplingPlanVersion: 2, baselineVersion: 3, visitVersion: 4 }), /required/);
});

test("legacy monitoring capture is Staff-only while requester planting capture remains owner-scoped", () => {
  for (const workflow of ["monitoring-early", "monitoring-official", "monitoring-resubmit"]) {
    assert.doesNotThrow(() => _test.assertCaptureRole(workflow, "staff"));
    assert.throws(() => _test.assertCaptureRole(workflow, "participant"), error => error.code === "CAPTURE_SESSION_FORBIDDEN");
    assert.throws(() => _test.assertCaptureRole(workflow, "staff", "participant"), error => error.code === "CAPTURE_SESSION_FORBIDDEN");
  }
  assert.doesNotThrow(() => _test.assertCaptureRole("planting-report", "participant"));
  assert.equal(_test.monitoringReportTargetAllowed({ siteId: "site-1", participantId: "owner" }, "site-1", "staff", "staff"), true);
  assert.equal(_test.monitoringReportTargetAllowed({ siteId: "site-1", participantId: "owner" }, "site-1", "owner", "participant"), true);
  assert.equal(_test.monitoringReportTargetAllowed({ siteId: "site-1", participantId: "owner" }, "site-1", "other", "participant"), false);
  assert.equal(_test.monitoringReportTargetAllowed({ siteId: "other-site", participantId: "owner" }, "site-1", "staff", "staff"), false);
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

test("missing or blank GPS accuracy is rejected instead of counting as zero", () => {
  const site = { latitude: 13, longitude: 124, coverageRadiusMeters: 100 };
  for (const accuracy of [undefined, null, "", "   ", "unknown", NaN, -1]) {
    assert.throws(() => _test.validateLocation(site, { latitude: 13, longitude: 124, accuracy }),
      error => error.code === "CAPTURE_LOCATION_INACCURATE", String(accuracy));
  }
  assert.equal(_test.validateLocation(site, { latitude: 13, longitude: 124, accuracy: "0" }).accuracyMeters, 0);
  assert.equal(_test.validateLocation(site, { latitude: 13, longitude: 124, accuracy: "50" }).accuracyMeters, 50);
});

test("GPS accuracy and 50 metre site fallback are enforced independently at their boundaries", () => {
  const site = { latitude: 13, longitude: 124 };
  const latitudeAt = meters => 13 + meters / 111195;
  for (const accuracy of [49, 50]) {
    assert.equal(_test.validateLocation(site, { latitude: 13, longitude: 124, accuracy }).accuracyMeters, accuracy);
  }
  assert.throws(() => _test.validateLocation(site, { latitude: 13, longitude: 124, accuracy: 51 }),
    error => error.code === "CAPTURE_LOCATION_INACCURATE");
  for (const distance of [20, 35, 50]) {
    assert.ok(_test.validateLocation(site, { latitude: latitudeAt(distance), longitude: 124, accuracy: 1 }).distanceMeters <= 50);
  }
  assert.throws(() => _test.validateLocation(site, { latitude: latitudeAt(60), longitude: 124, accuracy: 1 }),
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
