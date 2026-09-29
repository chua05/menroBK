const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

let serviceError;
const originalLoad = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (parent?.filename?.endsWith("evidence.controller.js") &&
      request === "../services/evidenceAccess.service") {
    const fail = async () => { throw serviceError; };
    return {
      plantingEvidenceForUser: fail,
      monitoringEvidenceForUser: fail,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const controller = require("../src/controller/evidence.controller");
Module._load = originalLoad;

function response() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function request() {
  return {
    params: { reportId: "report", photoIndex: "0" },
    user: { uid: "participant", role: "participant" },
  };
}

test("unauthorized evidence returns HTTP 403 without exposing internal details", async () => {
  serviceError = Object.assign(new Error("sensitive internal detail"), {
    code: "EVIDENCE_FORBIDDEN",
  });
  const res = response();
  await controller.getPlantingEvidence(request(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.message, "Forbidden");
  assert.equal(JSON.stringify(res.body).includes("sensitive internal detail"), false);
});

test("missing evidence returns HTTP 404 with a truthful public message", async () => {
  serviceError = Object.assign(new Error("physical path"), {
    code: "EVIDENCE_NOT_FOUND",
  });
  const res = response();
  await controller.getPlantingEvidence(request(), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, "Photo is unavailable.");
});
