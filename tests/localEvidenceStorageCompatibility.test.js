const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Module = require("node:module");
const sharp = require("sharp");
const { UPLOAD_ROOT } = require("../src/config/uploadRoot");
const { savePlantingPhoto } = require("../src/services/fileStorage.service");

test("local planting bytes/references and authorized retrieval remain unchanged without a Storage client", async () => {
  const participantId = `phase1-local-${randomUUID()}`;
  const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } }).jpeg().toBuffer();
  const previousUrl = process.env.BACKEND_URL;
  process.env.BACKEND_URL = "http://localhost:5000";
  let stored;
  const originalLoad = Module._load;
  const servicePath = require.resolve("../src/services/evidenceAccess.service");
  const previousService = require.cache[servicePath];
  delete require.cache[servicePath];
  try {
    Module._load = function (request, parent, isMain) {
      if (request === "firebase-admin/storage" || request === "@google-cloud/storage") {
        throw new Error("Local evidence must not initialize a cloud Storage client.");
      }
      if (parent?.filename === servicePath) {
        if (request === "./plantingReport.service") return {
          getPlantingReportById: async () => ({ participantId, photos: [stored] }),
        };
        if (request === "./monitoring.service") return {};
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const result = await savePlantingPhoto({ participantId,
      file: { buffer, originalname: "original.jpg", mimetype: "image/jpeg", size: buffer.length } });
    stored = { photoPath: result.filePath, photoURL: result.photoURL };
    assert.match(result.filePath, new RegExp(`^planting-reports/${participantId}/.+\\.jpg$`));
    assert.equal(result.photoURL, `http://localhost:5000/uploads/${result.filePath}`);
    const { plantingEvidenceForUser } = require(servicePath);
    const evidence = await plantingEvidenceForUser("test-report", "0", { uid: participantId, role: "participant" });
    assert.equal(evidence.contentType, "image/jpeg");
    assert.deepEqual(await fs.readFile(evidence.absolutePath), buffer);
    await assert.rejects(() => plantingEvidenceForUser("test-report", "0", { uid: "other", role: "participant" }),
      { code: "EVIDENCE_FORBIDDEN" });
  } finally {
    Module._load = originalLoad;
    delete require.cache[servicePath];
    if (previousService) require.cache[servicePath] = previousService;
    if (previousUrl === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = previousUrl;
    // Remove only this test's newly created UUID-named file and empty directory.
    if (stored) await fs.unlink(path.join(UPLOAD_ROOT, stored.photoPath));
    await fs.rmdir(path.join(UPLOAD_ROOT, "planting-reports", participantId)).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
});
