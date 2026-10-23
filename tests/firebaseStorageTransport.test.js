// SDK wire contract against a loopback HTTP STUB, NOT a Firebase/GCS acceptance test.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const { Storage, CRC32C } = require("@google-cloud/storage");
const { saveWithoutAutomaticCleanup } = require("../src/services/nonproductionStorageAcceptance.service");

test("SDK sends multipart create-only query and propagates server 412 without replacing original bytes (HTTP stub only)", async t => {
  const originalHttp = http.request, originalHttps = https.request;
  const requests = [], objects = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      assert.equal(req.method, "POST");
      assert.equal(url.pathname, "/upload/storage/v1/b/demo-menro-phase2.firebasestorage.app/o");
      assert.equal(url.searchParams.get("uploadType"), "multipart");
      assert.equal(url.searchParams.get("ifGenerationMatch"), "0");
      assert.equal(req.headers.authorization, undefined);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert.ok(size < 32768, "bounded synthetic multipart request");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const boundary = /boundary="?([^";]+)/.exec(req.headers["content-type"])[1];
      const separator = Buffer.from("\r\n\r\n");
      const metadataStart = body.indexOf(separator) + separator.length;
      const metadataEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), metadataStart);
      const metadata = JSON.parse(body.subarray(metadataStart, metadataEnd).toString());
      metadata.name = url.searchParams.get("name") || metadata.name;
      assert.equal(metadata.name, "synthetic-transport-only");
      const dataStart = body.indexOf(separator, metadataEnd) + separator.length;
      const dataEnd = body.lastIndexOf(Buffer.from(`\r\n--${boundary}`));
      assert.ok(metadataEnd > metadataStart && dataEnd > dataStart);
      const bytes = Buffer.from(body.subarray(dataStart, dataEnd));
      requests.push({ name: metadata.name, precondition: url.searchParams.get("ifGenerationMatch") });
      res.setHeader("content-type", "application/json");
      // Deliberate STUB behavior. This proves SDK error handling, NOT GCS enforcement.
      if (objects.has(metadata.name)) {
        res.writeHead(412);
        res.end(JSON.stringify({ error: { code: 412, message: "Synthetic precondition failure",
          errors: [{ reason: "conditionNotMet", message: "Synthetic precondition failure" }] } }));
        return;
      }
      const crc = new CRC32C(); crc.update(bytes);
      const saved = { ...metadata, bucket: "demo-menro-phase2.firebasestorage.app",
        generation: "1", size: String(bytes.length), crc32c: crc.toString() };
      objects.set(metadata.name, { bytes, metadata: saved });
      res.end(JSON.stringify(saved));
    } catch (error) {
      res.writeHead(400); res.end(JSON.stringify({ error: { code: 400, message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  http.request = function (input, ...args) {
    const url = typeof input === "string" || input instanceof URL ? new URL(input) : null;
    assert.equal(url ? url.hostname : input.hostname || input.host, "127.0.0.1", "external HTTP prohibited");
    assert.equal(String(url ? url.port : input.port), String(port), "only this stub allowed");
    return originalHttp.call(this, input, ...args);
  };
  https.request = () => { throw Error("Cloud HTTPS prohibited in transport test"); };
  t.after(async () => {
    http.request = originalHttp; https.request = originalHttps;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const storage = new Storage({ projectId: "demo-menro-phase2", apiEndpoint: `http://127.0.0.1:${port}`,
    useAuthWithCustomEndpoint: false, retryOptions: { autoRetry: false } });
  // Never discover ADC, credential files or the metadata service, even if SDK internals change.
  storage.authClient.getCredentials = async () => { throw Error("Credential discovery prohibited"); };
  const file = storage.bucket("demo-menro-phase2.firebasestorage.app").file("synthetic-transport-only");
  const options = { resumable: false, validation: "crc32c", timeout: 5000,
    preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: "image/jpeg", cacheControl: "private, no-store" } };
  const original = Buffer.from("synthetic-original-not-real-evidence");
  await file.save(original, options);
  assert.deepEqual(objects.get(file.name).bytes, original);
  await assert.rejects(() => file.save(Buffer.from("synthetic-collision"), options), error => Number(error.code) === 412);
  const concurrent = await Promise.allSettled([file.save(original, options), file.save(Buffer.from("other"), options)]);
  assert.ok(concurrent.every(result => result.status === "rejected" && Number(result.reason.code) === 412));
  assert.equal(requests.length, 4, "412 is not silently retried or treated as success");
  assert.deepEqual(objects.get(file.name).bytes, original);
  assert.equal(objects.get(file.name).metadata.generation, "1");
  assert.equal(objects.size, 1);
});

test("acceptance CRC mismatch fails and preserves stub bytes without an SDK DELETE (loopback only)", async t => {
  const originalHttp = http.request, originalHttps = https.request;
  const requests = []; let saved;
  const server = http.createServer(async (req, res) => {
    requests.push(req.method);
    if (req.method !== "POST") { res.writeHead(400); res.end("Unexpected method"); return; }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; assert.ok(size < 32768); chunks.push(chunk); }
    saved = Buffer.concat(chunks);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: "synthetic-acceptance-crc-stub-only", bucket: "demo-menro-phase2.firebasestorage.app",
      generation: "1", size: "9", crc32c: "AAAAAA==" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  http.request = function(input, ...args) {
    const url = typeof input === "string" || input instanceof URL ? new URL(input) : null;
    assert.equal(url ? url.hostname : input.hostname || input.host, "127.0.0.1");
    assert.equal(String(url ? url.port : input.port), String(port));
    return originalHttp.call(this, input, ...args);
  };
  https.request = () => { throw Error("Cloud HTTPS prohibited in transport test"); };
  t.after(async () => { http.request = originalHttp; https.request = originalHttps;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const storage = new Storage({ projectId: "demo-menro-phase2", apiEndpoint: `http://127.0.0.1:${port}`,
    useAuthWithCustomEndpoint: false, retryOptions: { autoRetry: false, maxRetries: 0 } });
  storage.authClient.getCredentials = async () => { throw Error("Credential discovery prohibited"); };
  const file = storage.bucket("demo-menro-phase2.firebasestorage.app").file("synthetic-acceptance-crc-stub-only");
  const bytes = Buffer.from("synthetic"), crc = new CRC32C(); crc.update(bytes);
  assert.notEqual(crc.toString(), "AAAAAA==");
  await assert.rejects(saveWithoutAutomaticCleanup(file, bytes, { validation: "crc32c", resumable: false,
    timeout: 5000, preconditionOpts: { ifGenerationMatch: 0 } }), e => e.code === "FILE_NO_UPLOAD_DELETE");
  assert.deepEqual(requests, ["POST"]); assert.ok(saved.includes(bytes));
  assert.equal(Object.hasOwn(storage.bucket("demo-menro-phase2.firebasestorage.app").file("other-unmodified-handle"), "delete"), false);
});
