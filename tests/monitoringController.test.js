const assert = require("node:assert/strict");
const test = require("node:test");

let captured;
let screenshot = false;
const servicePath = require.resolve("../src/services/monitoring.service");
require.cache[servicePath] = {
  id: servicePath, filename: servicePath, loaded: true,
  exports: {
    createMonitoringRecord: async (data) => { captured = data; return { id: "monitor-1" }; },
    resubmitMonitoringObservation: async (data) => { captured = data; return { id: "monitor-1" }; },
  },
};
const imagePath = require.resolve("../src/utils/imageVerification.util");
require.cache[imagePath] = {
  id: imagePath, filename: imagePath, loaded: true,
  exports: {
    generateImageHash: () => "hash",
    validateImageBuffer: async () => ({ format: "jpeg" }),
    extractImageMetadata: async () => ({ latitude: 12.5, longitude: 123.8,
      capturedAt: "2026-10-10T08:00:00+08:00", captureOffset: "+08:00" }),
    isClearlyScreenshot: () => screenshot,
  },
};

const { addMonitoringRecord, resubmitMonitoring } = require("../src/controller/monitoring.controller");

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(overrides = {}) {
  return {
    user: { uid: "reporter-1", role: "participant" },
    file: { buffer: Buffer.from("image"), originalname: "field.jpg" },
    body: {
      plantingReportId: "report-1", totalMonitored: "25",
      healthyCount: "20", damagedCount: "3", deadCount: "2",
      maturityStatus: "Immature", monitoredDate: "2026-10-10", remarks: "Field check",
      ...overrides,
    },
  };
}

test("monitoring controller forwards partial coverage, actual date, and authenticated reporter", async () => {
  captured = null;
  const res = response();
  await addMonitoringRecord(request(), res);
  assert.equal(res.statusCode, 201);
  assert.equal(captured.totalMonitored, 25);
  assert.equal(captured.monitoredDate, "2026-10-10");
  assert.equal(captured.monitoredBy, "reporter-1");
  assert.deepEqual([captured.healthyCount, captured.damagedCount, captured.deadCount], [20, 3, 2]);
});

test("monitoring controller rejects condition counts that do not equal coverage", async () => {
  captured = null;
  const res = response();
  await addMonitoringRecord(request({ deadCount: "1" }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /must equal the total trees checked/i);
  assert.equal(captured, null);
});

test("resubmission controller rejects screenshot replacement evidence before persistence", async () => {
  captured = null;
  screenshot = true;
  const req = request();
  req.params = { monitoringId: "monitor-1", observationId: "OBS-1" };
  req.body.expectedVersion = "1";
  const res = response();
  try {
    await resubmitMonitoring(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /screenshot images are not accepted/i);
    assert.equal(captured, null);
  } finally {
    screenshot = false;
  }
});
