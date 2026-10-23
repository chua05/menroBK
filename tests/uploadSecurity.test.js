const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const express = require("express");

const {
  uploadConcurrencyGuard,
  uploadContributionEvidence,
} = require("../src/middleware/upload.middleware");

async function withUploadServer(callback) {
  const app = express();
  app.post("/upload", uploadConcurrencyGuard, uploadContributionEvidence, (req, res) => {
    res.status(200).json({ success: true, files: req.files.length });
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}/upload`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("upload parser rejects malformed bodies, oversized indexes, file counts, and file sizes", async () => {
  await withUploadServer(async (url) => {
    const malformed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=broken" },
      body: "--broken\r\nContent-Disposition: form-data; name=\"field\"\r\n\r\nvalue",
    });
    assert.equal(malformed.status, 400);

    const indexed = new FormData();
    indexed.append("metadata[999999999]", "value");
    const indexedResponse = await fetch(url, { method: "POST", body: indexed });
    assert.equal(indexedResponse.status, 400);

    const tooMany = new FormData();
    for (let index = 0; index < 11; index += 1) {
      tooMany.append("photos", new Blob([Buffer.from([0xff, 0xd8, 0xff])], {
        type: "image/jpeg",
      }), `photo-${index}.jpg`);
    }
    const tooManyResponse = await fetch(url, { method: "POST", body: tooMany });
    assert.equal(tooManyResponse.status, 400);

    const oversized = new FormData();
    oversized.append("photos", new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)], {
      type: "image/jpeg",
    }), "oversized.jpg");
    const oversizedResponse = await fetch(url, { method: "POST", body: oversized });
    assert.equal(oversizedResponse.status, 400);
  });
});

test("an aborted multipart upload releases its concurrency slot", async () => {
  await withUploadServer(async (url) => {
    const target = new URL(url);
    await new Promise((resolve) => {
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=abort-test",
          "content-length": 1024 * 1024,
        },
      });
      request.on("error", resolve);
      request.write("--abort-test\r\nContent-Disposition: form-data; name=\"photos\"; filename=\"x.jpg\"\r\n");
      request.destroy();
      setTimeout(resolve, 25);
    });

    const valid = new FormData();
    valid.append("photos", new Blob([Buffer.from([0xff, 0xd8, 0xff])], {
      type: "image/jpeg",
    }), "valid.jpg");
    const response = await fetch(url, { method: "POST", body: valid });
    assert.equal(response.status, 200);
  });
});

test("upload concurrency guard rejects the fourth active upload and releases slots", () => {
  const responses = [];
  const nextCalls = [];
  for (let index = 0; index < 4; index += 1) {
    const response = new EventEmitter();
    response.status = (status) => {
      response.statusCode = status;
      return response;
    };
    response.json = (body) => {
      response.body = body;
      return response;
    };
    responses.push(response);
    uploadConcurrencyGuard({}, response, () => nextCalls.push(index));
  }

  assert.deepEqual(nextCalls, [0, 1, 2]);
  assert.equal(responses[3].statusCode, 503);
  responses.slice(0, 3).forEach((response) => response.emit("finish"));
});
