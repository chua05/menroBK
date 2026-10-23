// Run only with firebase emulators:exec --only storage and the documented demo env.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const { resolveEvidenceStorageConfig } = require("../../src/config/evidenceStorage");

const config = resolveEvidenceStorageConfig();
if (!config.storageEmulator) throw new Error("This smoke test requires the explicit demo Storage emulator configuration.");

// Fail before transmitting any non-emulator HTTP request (including metadata/ADC).
const request = http.request;
http.request = function (input, ...args) {
  const hostname = typeof input === "string" ? new URL(input).hostname : input.hostname || input.host;
  const port = typeof input === "string" ? new URL(input).port : input.port;
  if (hostname !== "127.0.0.1" || String(port) !== "9199") throw new Error("Non-emulator HTTP blocked by Storage smoke test.");
  return request.call(this, input, ...args);
};
https.request = () => { throw new Error("Cloud HTTPS blocked by Storage smoke test."); };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== "http://127.0.0.1:9199") throw new Error("Non-emulator fetch blocked by Storage smoke test.");
  return originalFetch(input, init);
};

const { app, auth, db, getStorageBucket } = require("../../src/config/firebase");
const { deleteApp } = require("firebase-admin/app");

test("real Admin SDK shares the demo app and lists only synthetic emulator metadata", async () => {
  try {
    assert.equal(app.options.projectId, "demo-menro-phase2");
    assert.equal(typeof auth.verifyIdToken, "function");
    assert.equal(typeof db.collection("notifications").where("isRead", "==", false).count, "function");
    const bucket = getStorageBucket();
    assert.equal(bucket.name, "demo-menro-phase2.firebasestorage.app");
    const [files] = await bucket.getFiles({ autoPaginate: false, maxResults: 1 });
    assert.ok(Array.isArray(files));
    // No object uploads, downloads, deletion, fixture seeding, or shared-data cleanup.
  } finally {
    await deleteApp(app);
  }
});
