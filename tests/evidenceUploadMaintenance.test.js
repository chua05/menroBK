const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");

const {
  resolveEvidenceUploadMaintenance,
} = require("../src/config/evidenceUploadMaintenance");
const {
  EVIDENCE_UPLOAD_MAINTENANCE_MESSAGE,
  evidenceUploadMaintenanceGate,
} = require("../src/middleware/evidenceUploadMaintenance.middleware");
const {
  resolveEvidenceStorageConfig,
} = require("../src/config/evidenceStorage");

async function withServer(configure, callback) {
  const app = express();
  configure(app);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function withMaintenance(value, callback) {
  const previous = process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED;
  if (value === undefined) delete process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED;
  else process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED = value;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (previous === undefined) delete process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED;
      else process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED = previous;
    });
}

test("maintenance configuration defaults off and accepts only explicit booleans", () => {
  assert.equal(resolveEvidenceUploadMaintenance({}), false);
  assert.equal(resolveEvidenceUploadMaintenance({ EVIDENCE_UPLOAD_MAINTENANCE_ENABLED: "false" }), false);
  assert.equal(resolveEvidenceUploadMaintenance({ EVIDENCE_UPLOAD_MAINTENANCE_ENABLED: "true" }), true);
  for (const value of ["", "TRUE", "1", true, "secret-like-value"]) {
    assert.throws(() => resolveEvidenceUploadMaintenance({
      EVIDENCE_UPLOAD_MAINTENANCE_ENABLED: value,
    }), /must be either true or false/);
  }
});

test("enabled gate returns the consistent 503 before parsing or mutation", async () => {
  let parserCalls = 0;
  let mutationCalls = 0;
  await withMaintenance("true", () => withServer((app) => {
    app.post("/evidence", (req, res, next) => {
      req.user = { uid: "participant", role: "participant" };
      next();
    }, evidenceUploadMaintenanceGate, (req, res, next) => {
      parserCalls += 1;
      return express.raw({ type: "*/*" })(req, res, next);
    }, (req, res) => {
      mutationCalls += 1;
      res.sendStatus(204);
    });
  }, async (url) => {
    const response = await fetch(`${url}/evidence`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(1024),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      success: false,
      message: EVIDENCE_UPLOAD_MAINTENANCE_MESSAGE,
    });
    assert.equal(parserCalls, 0);
    assert.equal(mutationCalls, 0);
  }));
});

test("disabled gate preserves upload behavior", async () => {
  for (const value of [undefined, "false"]) {
    await withMaintenance(value, () => withServer((app) => {
      app.post("/evidence", evidenceUploadMaintenanceGate, express.raw({ type: "*/*" }), (req, res) => {
        res.status(200).json({ success: true, bytes: req.body.length });
      });
    }, async (url) => {
      const response = await fetch(`${url}/evidence`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from("unchanged"),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true, bytes: 9 });
    }));
  }
});

test("authorization runs before maintenance and retrieval remains available", async () => {
  await withMaintenance("true", () => withServer((app) => {
    const authorize = (req, res, next) => req.headers.authorization === "Bearer valid"
      ? next() : res.status(401).json({ success: false, message: "Unauthorized" });
    app.post("/evidence", authorize, evidenceUploadMaintenanceGate, (req, res) => res.sendStatus(204));
    app.get("/evidence", authorize, (req, res) => res.status(200).send(Buffer.from("cloud bytes")));
  }, async (url) => {
    const unauthorized = await fetch(`${url}/evidence`, { method: "POST" });
    assert.equal(unauthorized.status, 401);
    const maintained = await fetch(`${url}/evidence`, {
      method: "POST", headers: { authorization: "Bearer valid" },
    });
    assert.equal(maintained.status, 503);
    const retrieval = await fetch(`${url}/evidence`, {
      headers: { authorization: "Bearer valid" },
    });
    assert.equal(retrieval.status, 200);
    assert.deepEqual(Buffer.from(await retrieval.arrayBuffer()), Buffer.from("cloud bytes"));
  }));
});

test("production rollback keeps cloud reads while maintenance blocks local fallback writes", () => {
  const env = {
    NODE_ENV: "production",
    FIREBASE_PROJECT_ID: "menrosystem-ddfac",
    FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: "test-only-placeholder",
    FIREBASE_STORAGE_BUCKET: "menrosystem-ddfac.firebasestorage.app",
    MENRO_GCS_PRODUCTION: "true",
    EVIDENCE_STORAGE_PROVIDER: "local",
    EVIDENCE_CLOUD_WORKFLOW_ENABLED: "false",
    EVIDENCE_CLOUD_READ_ENABLED: "true",
    EVIDENCE_GCS_PRODUCTION_APPROVAL: "AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION",
    EVIDENCE_UPLOAD_MAINTENANCE_ENABLED: "true",
  };
  const storage = resolveEvidenceStorageConfig(env);
  assert.equal(storage.provider, "local");
  assert.equal(storage.cloudWorkflow, undefined);
  assert.equal(storage.cloudRead, true);
  assert.equal(resolveEvidenceUploadMaintenance(env), true);
});

test("all evidence-writing routes place maintenance before upload processing", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const sources = [
    ["plantingReport.routes.js", 1],
    ["event.routes.js", 1],
    ["guestEvent.routes.js", 1],
    ["monitoring.routes.js", 3],
  ];
  for (const [file, expected] of sources) {
    const source = fs.readFileSync(path.join(__dirname, "../src/routes", file), "utf8");
    const occurrences = source.match(/evidenceUploadMaintenanceGate/g) || [];
    assert.equal(occurrences.length - 1, expected, `${file} route coverage`);
  }
});
