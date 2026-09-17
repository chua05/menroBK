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
