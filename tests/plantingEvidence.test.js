const assert = require("node:assert/strict");
const test = require("node:test");
const sharp = require("sharp");

const collections = new Map();
function table(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}
function collection(name) {
  return {
    doc(id) {
      return {
        id,
        name,
        async get() {
          const value = table(name).get(id);
          return { id, exists: value !== undefined, data: () => value };
        },
      };
    },
    where(field, operator, value) {
      return {
        limit() { return this; },
        async get() {
          const docs = [...table(name)].filter(([, item]) => operator === "array-contains"
            ? item[field]?.includes(value) : item[field] === value)
            .map(([id, item]) => ({ id, data: () => item }));
          return { docs, empty: docs.length === 0 };
        },
      };
    },
  };
}
const db = {
  collection,
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: (ref) => ref.get(),
      update(ref, value) { writes.push(["update", ref, value]); },
      create(ref, value) { writes.push(["create", ref, value]); },
    };
    await callback(transaction);
    for (const [operation, ref, value] of writes) {
      const target = table(ref.name);
      if (operation === "create" && target.has(ref.id)) throw new Error("Already exists");
      target.set(ref.id, operation === "update" ? { ...target.get(ref.id), ...value } : value);
    }
  },
};
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const storagePath = require.resolve("../src/services/fileStorage.service");
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true,
  exports: {
    async savePlantingPhoto({ participantId }) {
      return { filePath: `planting-reports/${participantId}/photo.png`, photoURL: "http://localhost:5000/uploads/photo.png" };
    },
    async deletePlantingPhoto() {},
  },
};
const { attachEvidence } = require("../src/services/plantingEvidence.service");
const { validatePlantingReport } = require("../src/utils/plantingVerification.util");
const { validateImageBuffer, isClearlyScreenshot } = require("../src/utils/imageVerification.util");
const { isPointInPolygon, isPointInGeoJsonFeatureCollection } = require("../src/utils/geo.util");
const jubanBarangayBoundaries = require("../src/data/juban-barangays.json");

test("GPS mismatches stay truthful findings and invalid image bytes remain rejected", async () => {
  const result = validatePlantingReport({
    submittedLatitude: 12, submittedLongitude: 123, plantingDate: "2026-09-17",
    metadata: { latitude: 0, longitude: 0, capturedAt: null },
  });
  assert.equal(result.gpsValid, false);
  assert.ok(result.suspiciousFlags.includes("GPS_MISMATCH"));
  await assert.rejects(validateImageBuffer(Buffer.from("not an image")), /not a valid image/);
});

test("screenshot detection requires a strong signal or combined weak signals", () => {
  assert.equal(isClearlyScreenshot({
    fileName: "Screenshot_20260922.png",
    metadata: { latitude: null, longitude: null, deviceMake: "", deviceModel: "", software: "" },
  }), true);
  assert.equal(isClearlyScreenshot({
    fileName: "original-photo.jpg",
    metadata: { latitude: null, longitude: null, deviceMake: "", deviceModel: "", software: "" },
  }), false);
  assert.equal(isClearlyScreenshot({
    fileName: "photo.jpg",
    metadata: { latitude: 12, longitude: 123, deviceMake: "", deviceModel: "", software: "Snipping Tool" },
  }), true);
});

test("photo coordinates are checked against the registered site polygon", () => {
  const polygon = [
    { lat: 12, lng: 123 },
    { lat: 12, lng: 124 },
    { lat: 13, lng: 124 },
    { lat: 13, lng: 123 },
  ];
  assert.equal(isPointInPolygon(12.5, 123.5, polygon), true);
  assert.equal(isPointInPolygon(14, 123.5, polygon), false);
});

test("municipality scope uses the Juban barangay polygons", () => {
  assert.equal(isPointInGeoJsonFeatureCollection(12.795, 124, jubanBarangayBoundaries), true);
  assert.equal(isPointInGeoJsonFeatureCollection(14, 123.5, jubanBarangayBoundaries), false);
});

test("evidence stays with its contributor and records real missing-metadata findings", async () => {
  table("events").set("event-1", { latitude: 12.1, longitude: 124.1 });
  table("plantingReports").set("event_event-1", { verificationStatus: "Draft" });
  table("plantingContributions").set("contribution-1", {
    eventId: "event-1", participantId: "guest-1", reportId: "event_event-1", quantity: 5,
  });
  const buffer = await sharp({ create: { width: 20, height: 20, channels: 3, background: "green" } })
    .png().toBuffer();
  const file = { buffer, mimetype: "image/png", originalname: "original.png" };
  await assert.rejects(attachEvidence("event-1", "guest-2", "contribution-1", [file], {
    plantingDate: "2026-09-17", latitude: 12.1, longitude: 124.1,
  }), /not found/);
  const result = await attachEvidence("event-1", "guest-1", "contribution-1", [file], {
    plantingDate: "2026-09-17", latitude: 12.1, longitude: 124.1,
  });
  assert.equal(result.photos.length, 1);
  assert.equal(result.automatedVerificationStatus, "Flagged");
  assert.ok(result.suspiciousFlags.includes("GPS_METADATA_MISSING"));
  assert.ok(result.suspiciousFlags.includes("TIMESTAMP_METADATA_MISSING"));
  assert.equal(result.participantId, "guest-1");
  assert.equal(table("plantingEvidenceHashes").size, 1);
  await assert.rejects(attachEvidence("event-1", "guest-1", "contribution-1", [file], {
    plantingDate: "2026-09-17", latitude: 12.1, longitude: 124.1,
  }), /Duplicate|unavailable/);
});
