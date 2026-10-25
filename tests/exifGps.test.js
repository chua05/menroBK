const test = require("node:test");
const assert = require("node:assert/strict");
const { extractGpsCoordinates, rationalToNumber } = require("../src/utils/exifGps.util");

test("parses Samsung-style EXIF rational DMS exposed by exifr as numeric triplets", () => {
  const gps = extractGpsCoordinates({
    GPSLatitude: [12, 34, 56.7], GPSLongitude: [123, 45, 6.7],
    GPSLatitudeRef: "N", GPSLongitudeRef: "E",
    latitude: 12 + 34 / 60 + 56.7 / 3600,
    longitude: 123 + 45 / 60 + 6.7 / 3600,
  });
  assert.equal(gps.status, "valid");
  assert.ok(Number.isFinite(gps.latitude));
  assert.ok(Number.isFinite(gps.longitude));
});

test("parses scalar rational pairs without treating them as incomplete DMS", () => {
  const gps = extractGpsCoordinates({
    latitude: [1257, 100], longitude: [12387, 100],
    GPSLatitudeRef: "N", GPSLongitudeRef: "E",
  });
  assert.deepEqual(gps, { status: "valid", latitude: 12.57, longitude: 123.87 });
});

test("falls back from non-finite derived coordinates to valid raw DMS tags", () => {
  const gps = extractGpsCoordinates({
    latitude: NaN, longitude: NaN,
    GPSLatitude: [[12, 1], [34, 1], [12, 1]],
    GPSLongitude: [[123, 1], [57, 1], [54, 1]],
    GPSLatitudeRef: "N", GPSLongitudeRef: "E",
  });
  assert.equal(gps.status, "valid");
  assert.ok(Math.abs(gps.latitude - 12.57) < 1e-10);
  assert.ok(Math.abs(gps.longitude - 123.965) < 1e-10);
});

test("normalizes null-terminated byte direction references", () => {
  const gps = extractGpsCoordinates({
    GPSLatitude: [[12, 1], [30, 1], [0, 1]],
    GPSLongitude: [[123, 1], [30, 1], [0, 1]],
    GPSLatitudeRef: new Uint8Array([83, 0]),
    GPSLongitudeRef: new Uint8Array([87, 0]),
  });
  assert.deepEqual(gps, { status: "valid", latitude: -12.5, longitude: -123.5 });
});

test("continues rejecting missing, incomplete, and invalid coordinates", () => {
  assert.equal(extractGpsCoordinates({}).status, "missing");
  assert.equal(extractGpsCoordinates({ GPSLatitude: [[12, 1], [30, 1]] }).status, "unparseable");
  assert.equal(extractGpsCoordinates({ latitude: 91, longitude: 123 }).status, "invalid");
  assert.ok(Number.isNaN(rationalToNumber([1, 0])));
});
