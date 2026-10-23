const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const { fixture, sink, demoEnv, hash } = require("./helpers/evidenceRetrievalFixture");
const { createFirebaseEvidenceRetrieval } = require("../src/services/firebaseEvidenceRetrieval.service");
const originalEnv = { ...process.env };
test.before(() => Object.assign(process.env, demoEnv));
test.after(() => { for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv); });
test.beforeEach(t => {
  const native = fsp.mkdtemp, directories = [];
  fsp.mkdtemp = async (...args) => { const directory = await native(...args); directories.push(directory); return directory; };
  t.after(async () => {
    fsp.mkdtemp = native;
    for (const directory of directories) await assert.rejects(() => fsp.stat(directory), { code: "ENOENT" });
  });
});
for (const format of ["jpeg", "png", "webp"]) test(`verified private ${format} delivery preserves original bytes and safe headers`, async () => {
  const h = await fixture({ format }), response = sink();
  const result = await h.streamTo(h.token(), response.output);
  assert.deepEqual(response.data(), h.buffer);
  assert.deepEqual(response.headers, { "Content-Type": `image/${format}`, "Content-Length": String(h.buffer.length),
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  assert.equal(result.generation, h.reference.generation);
  assert.equal(h.stats.calls.length, 2);
  for (const call of h.stats.calls) {
    assert.equal(call.options.qs.generation, h.reference.generation);
    assert.equal(call.options.maxRetries, 0); assert.equal(call.options.headers["Accept-Encoding"], "identity");
  }
  assert.equal(JSON.stringify(response.headers).includes(h.reference.objectName), false);
  assert.equal(JSON.stringify(result).includes(h.reference.bucket), false);
});
test("malformed references and cross-context paths fail before any SDK read", async () => {
  const h = await fixture();
  for (const patch of [{ provider: "local" }, { storageVersion: 2 }, { bucket: "menrosystem-ddfac.firebasestorage.app" },
    { objectName: "../other" }, { objectName: "https://example.org/object" }, { objectName: `${h.reference.objectName}%2fother` },
    { generation: "0" }, { generation: 12 }, { generation: "01" }, { generation: "18446744073709551616" },
    { contentType: "image/svg+xml" }, { format: "tiff" }, { sha256: "bad" }, { sizeBytes: 0 }, { sizeBytes: 10 * 1024 * 1024 + 1 },
    { url: "https://example.org/private" }]) {
    assert.throws(() => h.serverResolvedEvidence({ ...h.context(), reference: { ...h.reference, ...patch } }), { code: "INVALID_EVIDENCE_REFERENCE" });
  }
  assert.throws(() => h.serverResolvedEvidence({ ...h.context(), recordId: "another-record" }), { code: "INVALID_EVIDENCE_REFERENCE" });
  assert.throws(() => h.serverResolvedEvidence({ ...h.context(), evidenceType: "arbitrary" }), { code: "INVALID_EVIDENCE_CONTEXT" });
  await assert.rejects(() => h.streamTo({ ...h.token() }, sink().output), { code: "INVALID_EVIDENCE_CONTEXT" });
  await assert.rejects(() => h.streamTo(h.reference, sink().output), { code: "INVALID_EVIDENCE_CONTEXT" });
  assert.equal(h.stats.calls.length, 0);
});
test("context snapshot cannot be changed by mutating the original reference", async () => {
  const h = await fixture(), token = h.token(), response = sink();
  h.reference.objectName = "unexpected";
  await h.streamTo(token, response.output); assert.deepEqual(response.data(), h.buffer);
});
test("large uint64 generation remains an exact string on every request", async () => {
  const h = await fixture(); h.reference.generation = "18446744073709551615"; h.metadata.generation = h.reference.generation;
  await h.streamTo(h.token(), sink().output);
  assert.ok(h.stats.calls.every(call => call.options.qs.generation === "18446744073709551615"));
});
test("metadata generation, type, size, privacy and context mismatches deliver zero bytes", async () => {
  for (const kind of ["generation", "size", "type", "record", "token", "acl", "encoding"]) {
    const h = await fixture(), response = sink();
    if (kind === "generation") h.metadata.generation = "1800000000000002";
    if (kind === "size") h.metadata.size = String(h.buffer.length + 1);
    if (kind === "type") h.metadata.contentType = "text/html";
    if (kind === "record") h.metadata.metadata.recordScope = hash("another");
    if (kind === "token") h.metadata.metadata.firebaseStorageDownloadTokens = "private-token";
    if (kind === "acl") h.metadata.acl = [{ entity: "allUsers" }];
    if (kind === "encoding") h.metadata.contentEncoding = "gzip";
    await assert.rejects(() => h.streamTo(h.token(), response.output));
    assert.equal(response.bytes(), 0); assert.equal(h.stats.calls.length, 1); assert.deepEqual(response.headers, {});
  }
});
test("missing, denied and unavailable requests return fixed errors without private details", async () => {
  for (const [status, code] of [[404, "EVIDENCE_NOT_FOUND"], [403, "EVIDENCE_STORAGE_FORBIDDEN"], [500, "EVIDENCE_STORAGE_UNAVAILABLE"]]) {
    const h = await fixture(), response = sink(); h.faults.metadataStatus = status;
    await assert.rejects(() => h.streamTo(h.token(), response.output), error => {
      assert.equal(error.code, code); assert.equal(error.message.includes(h.reference.objectName), false); return true;
    });
    assert.equal(response.bytes(), 0);
  }
});
test("wrong media headers, truncated/oversized bytes and checksum corruption fail before response", async () => {
  for (const kind of ["generation", "type", "length", "short", "long", "checksum", "partial"]) {
    const h = await fixture(), response = sink();
    if (kind === "generation") h.faults.responseGeneration = "123";
    if (kind === "type") h.faults.responseType = "text/html";
    if (kind === "length") h.faults.responseLength = "999";
    if (kind === "short") h.faults.bytes = h.buffer.subarray(0, h.buffer.length - 1);
    if (kind === "long") h.faults.bytes = Buffer.concat([h.buffer, Buffer.from("x")]);
    if (kind === "checksum") h.faults.bytes = Buffer.alloc(h.buffer.length, 1);
    if (kind === "partial") h.faults.mediaErrorAt = 1;
    await assert.rejects(() => h.streamTo(h.token(), response.output));
    assert.equal(response.bytes(), 0); assert.deepEqual(response.headers, {});
    assert.ok(h.stats.streams.every(stream => stream.destroyed));
  }
});
test("valid hash does not permit a forged image MIME signature", async () => {
  const h = await fixture({ buffer: Buffer.alloc(100, 1) }), response = sink();
  await assert.rejects(() => h.streamTo(h.token(), response.output), { code: "EVIDENCE_CONTENT_TYPE_MISMATCH" });
  assert.equal(response.bytes(), 0);
});
test("metadata and image timeouts cancel upstream and clean the private staging file", async () => {
  for (const kind of ["metadataHang", "mediaHang"]) {
    const h = await fixture({ timeoutMs: 30 }), response = sink(); h.faults[kind] = true;
    await assert.rejects(() => h.streamTo(h.token(), response.output), { code: "EVIDENCE_TIMEOUT" });
    assert.ok(h.stats.streams.every(stream => stream.destroyed)); assert.equal(response.bytes(), 0);
  }
});
test("client abort during upstream download cancels it before response delivery", async () => {
  const h = await fixture(), response = sink(), controller = new AbortController();
  h.faults.onMediaChunk = () => controller.abort(Error("untrusted abort detail"));
  await assert.rejects(() => h.streamTo(h.token(), response.output, { signal: controller.signal }), { code: "CLIENT_DISCONNECTED" });
  assert.ok(h.stats.streams.every(stream => stream.destroyed)); assert.equal(response.bytes(), 0);
});
test("large slow downstream uses bounded stream buffers and backpressure", async () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024, 1); bytes.set([255, 216, 255]); // synthetic stream, not decoder acceptance
  const h = await fixture({ buffer: bytes, timeoutMs: 5000 }), response = sink({ delay: 2, discard: true });
  await h.streamTo(h.token(), response.output);
  assert.equal(response.bytes(), bytes.length); assert.ok(response.peak() <= 128 * 1024);
  assert.ok(h.stats.peakSourceBytes <= 128 * 1024);
});
test("downstream failure after verification is safe but cannot retract already delivered bytes", async () => {
  const h = await fixture(), response = sink({ failAfter: 1 });
  await assert.rejects(() => h.streamTo(h.token(), response.output));
  assert.ok(response.bytes() > 0, "post-verification transport failure can occur after bytes were delivered");
  assert.equal(response.output.destroyed, true);
});
test("client disconnect while preparing cancels upstream, and concurrency slots are released", async () => {
  const h = await fixture({ maxConcurrent: 1 }), first = sink(); h.faults.metadataHang = true;
  const running = h.streamTo(h.token(), first.output);
  const expectation = assert.rejects(running, { code: "CLIENT_DISCONNECTED" });
  await assert.rejects(() => h.streamTo(h.token(), sink().output), { code: "EVIDENCE_RETRIEVAL_BUSY" });
  first.output.destroy(); await expectation;
  h.faults.metadataHang = false; await h.streamTo(h.token(), sink().output);
});
test("wrong bucket/endpoint and production are rejected; explicit read-only firebase provider is safe", async () => {
  const h = await fixture(); h.bucket.name = "menrosystem-ddfac.firebasestorage.app";
  await assert.rejects(() => h.streamTo(h.token(), sink().output), { code: "RETRIEVAL_EMULATOR_REQUIRED" });
  h.bucket.name = demoEnv.FIREBASE_STORAGE_BUCKET; h.bucket.storage.apiEndpoint = "https://storage.googleapis.com";
  await assert.rejects(() => h.streamTo(h.token(), sink().output), { code: "RETRIEVAL_EMULATOR_REQUIRED" });
  process.env.EVIDENCE_STORAGE_PROVIDER = "firebase";
  try { assert.doesNotThrow(() => createFirebaseEvidenceRetrieval({ getBucket: () => h.bucket })); }
  finally { process.env.EVIDENCE_STORAGE_PROVIDER = "local"; }
  process.env.NODE_ENV = "production";
  try { assert.throws(() => createFirebaseEvidenceRetrieval(), /disabled/); }
  finally { process.env.NODE_ENV = "test"; }
  assert.equal(h.stats.calls.length, 0);
});

test("read-only rollback preserves exact bytes while cloud workflow is disabled", async () => {
  process.env.EVIDENCE_CLOUD_WORKFLOW_ENABLED = "false";
  try {
    const h = await fixture(), response = sink();
    await h.streamTo(h.token(), response.output);
    assert.deepEqual(response.data(), h.buffer);
    assert.ok(h.stats.calls.every(call => call.options.qs.generation === h.reference.generation));
  } finally { delete process.env.EVIDENCE_CLOUD_WORKFLOW_ENABLED; }
});

test("disabling read capability revokes an already-created cached token before SDK access", async () => {
  const h = await fixture(), token = h.token();
  process.env.EVIDENCE_CLOUD_READ_ENABLED = "false";
  try {
    await assert.rejects(h.streamTo(token, sink().output), { code: "RETRIEVAL_EMULATOR_REQUIRED" });
    assert.throws(() => h.serverResolvedEvidence(h.context()), { code: "RETRIEVAL_EMULATOR_REQUIRED" });
    assert.equal(h.stats.calls.length, 0);
  } finally { process.env.EVIDENCE_CLOUD_READ_ENABLED = "true"; }
});
