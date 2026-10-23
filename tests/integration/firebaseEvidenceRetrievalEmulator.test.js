// Real guarded SDK reads, synthetic UUID records only. No object deletion or fixture resets.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const http = require("node:http"), https = require("node:https");
const sharp = require("sharp");
const { resolveEvidenceStorageConfig } = require("../../src/config/evidenceStorage");
// CLI-only demo discovery metadata is validated before this test opts into reads.
if (process.env.FIREBASE_CONFIG) {
  const config = JSON.parse(process.env.FIREBASE_CONFIG);
  assert.equal(config.projectId, "demo-menro-phase2");
  assert.ok(Object.keys(config).every(key => ["projectId", "databaseURL", "storageBucket"].includes(key)));
  if (config.databaseURL) assert.equal(config.databaseURL, "https://demo-menro-phase2.firebaseio.com");
  if (config.storageBucket) assert.ok(["demo-menro-phase2.appspot.com", "demo-menro-phase2.firebasestorage.app"].includes(config.storageBucket));
  delete process.env.FIREBASE_CONFIG;
}
if (process.env.EVIDENCE_CLOUD_READ_ENABLED === undefined) process.env.EVIDENCE_CLOUD_READ_ENABLED = "true";
if (!resolveEvidenceStorageConfig().storageEmulator) throw Error("Explicit demo emulator configuration required");
let tracing = false;
const reads = [], nativeRequest = http.request;
http.request = function (input, ...args) {
  const url = typeof input === "string" || input instanceof URL ? new URL(input) :
    new URL(input.path || "/", `http://${input.hostname || input.host}:${input.port}`);
  if (url.hostname !== "127.0.0.1" || !["8080", "9199"].includes(url.port)) throw Error("Non-emulator HTTP blocked");
  const method = typeof input === "object" && !(input instanceof URL) ? input.method || "GET" : "GET";
  if (tracing && url.pathname.includes("/o/") && method === "GET") {
    assert.match(url.searchParams.get("generation") || "", /^[1-9]\d*$/, "every SDK read must pin a generation");
    reads.push({ generation: url.searchParams.get("generation"), media: url.searchParams.get("alt") === "media" });
  }
  return nativeRequest.call(this, input, ...args);
};
https.request = () => { throw Error("Cloud HTTPS blocked"); };
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["http://127.0.0.1:9199", "http://127.0.0.1:8080"].includes(url.origin)) throw Error("Non-emulator fetch blocked");
  return nativeFetch(input, init);
};
const { app, db, getStorageBucket } = require("../../src/config/firebase");
const { deleteApp } = require("firebase-admin/app");
const { createFirebaseEvidenceStorage } = require("../../src/services/firebaseEvidenceStorage.service");
const { createFirebaseEvidenceRetrieval } = require("../../src/services/firebaseEvidenceRetrieval.service");
const { createEvidenceRetrievalResolver } = require("../../src/services/evidenceRetrievalResolver.service");
const { sink } = require("../helpers/evidenceRetrievalFixture");
const bucket = getStorageBucket();
test.afterEach(() => { tracing = false; reads.length = 0; });
test.after(() => deleteApp(app));
async function fixture(format = "jpeg") {
  const recordId = `phase4-${randomUUID()}`, actor = { uid: `actor-${randomUUID()}` }, evidenceType = "monitoring-official";
  const upload = createFirebaseEvidenceStorage({ db, getBucket: () => bucket, log() {} });
  const context = upload.serverContext({ actor, evidenceType, recordId, verification: { latitude: 12.67, longitude: 123.94, gpsValid: true } });
  const buffer = await sharp({ create: { width: 13, height: 13, channels: 3, background: "green" } }).toFormat(format).toBuffer();
  const input = { buffer, contentType: `image/${format}` }, { intentId } = await upload.reserve(context, input);
  const reference = await upload.upload(context, intentId, input);
  const retrieval = createFirebaseEvidenceRetrieval({ getBucket: () => bucket, timeoutMs: 5000, log() {} });
  return { reference, buffer, retrieval, actor, recordId, evidenceType, intentId,
    context: () => ({ reference, recordId, evidenceType }),
    async ledger() {
      const intent = await db.collection("evidenceUploadIntents").doc(intentId).get();
      const quota = await db.collection("evidenceQuotaReservations").doc(intentId).get();
      const daily = await db.collection("evidenceQuotaDays").doc(`${intent.data().quotaDay}_${intent.data().quotaActorKey}`).get();
      return { intent: intent.data(), quota: quota.data(), daily: daily.data() };
    } };
}
for (const format of ["jpeg", "png", "webp"]) test(`real private ${format} retrieval preserves bytes/generation/headers without ledger writes`, async () => {
  const f = await fixture(format), before = await f.ledger(), response = sink(); tracing = true;
  const result = await f.retrieval.streamTo(f.retrieval.serverResolvedEvidence(f.context()), response.output);
  tracing = false;
  assert.deepEqual(response.data(), f.buffer); assert.equal(result.generation, f.reference.generation);
  assert.equal(response.headers["Content-Type"], `image/${format}`);
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(response.headers["Cache-Control"], "private, no-store");
  assert.equal(JSON.stringify(response.headers).includes(f.reference.objectName), false);
  assert.equal(reads.length, 2); assert.ok(reads.every(read => read.generation === f.reference.generation));
  assert.deepEqual(await f.ledger(), before);
});
test("missing cloud object fails safely without trying another object or a local file", async () => {
  const f = await fixture(), id = randomUUID(), response = sink();
  const reference = { ...f.reference, uploadIntentId: id, objectName: `evidence/v1/${f.evidenceType}/${f.recordId}/${id}` };
  tracing = true;
  await assert.rejects(() => f.retrieval.streamTo(f.retrieval.serverResolvedEvidence({ ...f.context(), reference }), response.output), { code: "EVIDENCE_NOT_FOUND" });
  assert.equal(response.bytes(), 0); assert.equal(reads.length, 1);
});
test("changed generation is never silently used, even when emulator ignores the requested generation", async () => {
  const f = await fixture(), [metadata] = await bucket.file(f.reference.objectName).getMetadata();
  // Deliberate mutation ONLY of this new synthetic object; the separate native precondition failure remains visible.
  await bucket.file(f.reference.objectName).save(Buffer.from("synthetic-overwrite"), { resumable: false,
    metadata: { contentType: metadata.contentType, cacheControl: metadata.cacheControl, metadata: metadata.metadata } });
  const response = sink(); tracing = true;
  await assert.rejects(() => f.retrieval.streamTo(f.retrieval.serverResolvedEvidence(f.context()), response.output),
    error => ["EVIDENCE_GENERATION_MISMATCH", "EVIDENCE_NOT_FOUND"].includes(error.code));
  assert.equal(response.bytes(), 0); assert.equal(reads.length, 1);
  assert.equal(reads[0].generation, f.reference.generation);
});
test("forged checksum metadata cannot substitute for hashing the actual original bytes", async () => {
  const f = await fixture(), object = bucket.file(f.reference.objectName), [metadata] = await object.getMetadata();
  await object.save(Buffer.alloc(f.buffer.length, 1), { resumable: false,
    metadata: { contentType: metadata.contentType, cacheControl: metadata.cacheControl, metadata: metadata.metadata } });
  const [latest] = await object.getMetadata(), reference = { ...f.reference, generation: String(latest.generation) };
  const response = sink(); tracing = true;
  await assert.rejects(() => f.retrieval.streamTo(f.retrieval.serverResolvedEvidence({ ...f.context(), reference }), response.output), { code: "EVIDENCE_CHECKSUM_MISMATCH" });
  assert.equal(response.bytes(), 0); assert.deepEqual(response.headers, {});
});
test("reference context and private metadata mismatches do not deliver evidence", async () => {
  const f = await fixture(), object = bucket.file(f.reference.objectName), [metadata] = await object.getMetadata();
  assert.throws(() => f.retrieval.serverResolvedEvidence({ ...f.context(), recordId: "different" }), { code: "INVALID_EVIDENCE_REFERENCE" });
  await object.setMetadata({ metadata: { ...metadata.metadata, recordScope: "wrong-record" } });
  const response = sink(); tracing = true;
  await assert.rejects(() => f.retrieval.streamTo(f.retrieval.serverResolvedEvidence(f.context()), response.output), { code: "EVIDENCE_METADATA_MISMATCH" });
  assert.equal(response.bytes(), 0);
});
test("large generation strings reach the actual SDK transport without Number rounding", async () => {
  const f = await fixture(), reference = { ...f.reference, generation: "18446744073709551615" }, response = sink();
  tracing = true;
  await assert.rejects(() => f.retrieval.streamTo(f.retrieval.serverResolvedEvidence({ ...f.context(), reference }), response.output));
  assert.equal(reads[0].generation, "18446744073709551615"); assert.equal(response.bytes(), 0);
});
test("business authorization denial precedes reads; anonymous access remains denied by emulator rules", async () => {
  const f = await fixture();
  const resolver = createEvidenceRetrievalResolver({ cloud: f.retrieval, async authorizeAndResolve(selector, user) {
    if (user.uid !== f.actor.uid) throw Object.assign(Error("private record"), { code: "EVIDENCE_FORBIDDEN" });
    return { provider: "firebase", ...f.context() };
  } });
  tracing = true;
  await assert.rejects(() => resolver.resolve({ kind: "monitoring", recordId: f.recordId, entryIndex: "0" }, { uid: "other", role: "participant" }), { code: "EVIDENCE_FORBIDDEN" });
  assert.equal(reads.length, 0); tracing = false;
  const response = await fetch(`http://127.0.0.1:9199/v0/b/${bucket.name}/o/${encodeURIComponent(f.reference.objectName)}?alt=media`);
  assert.ok([401, 403].includes(response.status));
});
test("abort during real SDK response cancels retrieval without quota or intent changes", async () => {
  const f = await fixture(), before = await f.ledger(), controller = new AbortController();
  const wrapped = { name: bucket.name, storage: bucket.storage, file(name) {
    const file = bucket.file(name), requestStream = file.requestStream.bind(file);
    file.requestStream = options => {
      const stream = requestStream(options);
      stream.once("response", () => controller.abort()); return stream;
    }; return file;
  } };
  const retrieval = createFirebaseEvidenceRetrieval({ getBucket: () => wrapped, log() {} }), response = sink();
  await assert.rejects(() => retrieval.streamTo(retrieval.serverResolvedEvidence(f.context()), response.output, { signal: controller.signal }), { code: "CLIENT_DISCONNECTED" });
  assert.equal(response.bytes(), 0); assert.deepEqual(await f.ledger(), before);
});
