const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");

const calls = [];
let cohortEnabled = true;
let uploadImplementation;

function reject(status, code, message = code) {
  return Object.assign(new Error(message), { status, code });
}

function mock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock("../src/middleware/auth.middleware", {
  verifyToken(req, res, next) {
    calls.push("auth");
    if (!req.get("x-test-role")) {
      return res.status(401).json({ success: false, code: "UNAUTHENTICATED" });
    }
    req.user = { uid: req.get("x-test-user") || "staff-1", role: req.get("x-test-role") };
    return next();
  },
});

mock("../src/middleware/role.middleware", {
  authorizeRoles: (...roles) => (req, res, next) => {
    calls.push("role");
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ success: false, code: "FORBIDDEN" });
    }
    return next();
  },
});

mock("../src/middleware/evidenceUploadMaintenance.middleware", {
  evidenceUploadMaintenanceGate(req, res, next) {
    calls.push("maintenance");
    if (req.body?.maintenanceBlocked) {
      return res.status(503).json({ success: false, code: "UPLOAD_MAINTENANCE" });
    }
    return next();
  },
});

mock("../src/middleware/upload.middleware", {
  uploadConcurrencyGuard(req, res, next) {
    calls.push("concurrency");
    if (req.body?.concurrencyBlocked) {
      return res.status(503).json({ success: false, code: "UPLOAD_CONCURRENCY" });
    }
    return next();
  },
  uploadContributionEvidence(req, res, next) {
    calls.push("parser");
    if (req.body?.invalidUpload) {
      return res.status(400).json({ success: false, code: "INVALID_UPLOAD" });
    }
    req.files = req.body?.files || [{ buffer: Buffer.from("test-image") }];
    return next();
  },
});

mock("../src/config/verifiedPlantingCohort", {
  resolveVerifiedPlantingCohortConfig: () => ({ enabled: cohortEnabled }),
});

mock("../src/services/sampleMonitoringEvidence.service", {
  upload: async request => {
    calls.push({ service: request });
    return uploadImplementation(request);
  },
});

const routes = require("../src/routes/sampleMonitoringVisit.routes");

async function withServer(callback) {
  const app = express();
  app.use(express.json());
  app.use("/api/verified-sample-monitoring", routes);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function reset() {
  calls.length = 0;
  cohortEnabled = true;
  uploadImplementation = async request => ({
    visitId: request.visitId,
    sampleId: request.sampleId,
  });
}

async function put(baseUrl, visitId = "visit-1", sampleId = "TREE-001", body = {}, headers = {}) {
  return fetch(`${baseUrl}/api/verified-sample-monitoring/visits/${visitId}/samples/${sampleId}/evidence`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-test-role": "staff",
      "x-test-user": "staff-1",
      "Idempotency-Key": "staff_upload_key_123",
      ...headers,
    },
    body: JSON.stringify({ assessmentRevision: 2, expectedVisitVersion: 4, ...body }),
  });
}

test("Staff upload reaches the bound per-tree evidence service through active upload guards", async () => {
  reset();
  await withServer(async baseUrl => {
    const response = await put(baseUrl, "visit-7", "TREE-007", {
      evidenceManifest: [{ captureSessionId: "capture-7" }],
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload.data, { visitId: "visit-7", sampleId: "TREE-007" });
    assert.deepEqual(calls.slice(0, 5), ["auth", "role", "maintenance", "concurrency", "parser"]);
    const request = calls.find(call => call.service)?.service;
    assert.deepEqual(request, {
      actorId: "staff-1",
      visitId: "visit-7",
      sampleId: "TREE-007",
      assessmentRevision: 2,
      expectedVisitVersion: 4,
      files: [{ buffer: Buffer.from("test-image") }],
      evidenceManifest: [{ captureSessionId: "capture-7" }],
      idempotencyKey: "staff_upload_key_123",
    });
  });
});

test("endpoint denies unauthenticated and Participant uploads before upload processing", async () => {
  reset();
  await withServer(async baseUrl => {
    const unauthenticated = await put(baseUrl, "visit-1", "TREE-001", {}, { "x-test-role": "" });
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(calls, ["auth"]);

    calls.length = 0;
    const participant = await put(baseUrl, "visit-1", "TREE-001", {}, { "x-test-role": "participant" });
    assert.equal(participant.status, 403);
    assert.deepEqual(calls, ["auth", "role"]);
  });
});

test("endpoint returns service authorization and binding rejections without private references", async () => {
  reset();
  await withServer(async baseUrl => {
    for (const error of [
      reject(403, "VISIT_NOT_OWNED"),
      reject(409, "SAMPLE_BINDING_MISMATCH"),
      reject(409, "STALE_VISIT_VERSION"),
      reject(409, "CAPTURE_SESSION_REPLAYED"),
    ]) {
      uploadImplementation = async () => {
        throw error;
      };
      const response = await put(baseUrl);
      const payload = await response.json();
      assert.equal(response.status, error.status);
      assert.equal(payload.code, error.code);
      assert.equal("data" in payload, false);
      assert.equal(JSON.stringify(payload).includes("privateEvidence"), false);
    }
  });
});

test("disabled gate and invalid upload payloads stop before evidence linkage", async () => {
  reset();
  await withServer(async baseUrl => {
    cohortEnabled = false;
    const disabled = await put(baseUrl);
    assert.equal(disabled.status, 409);
    assert.equal(calls.some(call => call.service), false);
    assert.deepEqual(calls.slice(0, 5), ["auth", "role", "maintenance", "concurrency", "parser"]);

    reset();
    const malformed = await put(baseUrl, "visit-1", "TREE-001", { invalidUpload: true });
    assert.equal(malformed.status, 400);
    assert.equal(calls.some(call => call.service), false);

    reset();
    const invalidManifest = await put(baseUrl, "visit-1", "TREE-001", { evidenceManifest: "{" });
    assert.equal(invalidManifest.status, 400);
    assert.equal(calls.some(call => call.service), false);
  });
});

test("maintenance and concurrency guards remain active before the evidence service", async () => {
  reset();
  await withServer(async baseUrl => {
    const maintenance = await put(baseUrl, "visit-1", "TREE-001", { maintenanceBlocked: true });
    assert.equal(maintenance.status, 503);
    assert.deepEqual(calls, ["auth", "role", "maintenance"]);

    reset();
    const concurrent = await put(baseUrl, "visit-1", "TREE-001", { concurrencyBlocked: true });
    assert.equal(concurrent.status, 503);
    assert.deepEqual(calls, ["auth", "role", "maintenance", "concurrency"]);
  });
});
