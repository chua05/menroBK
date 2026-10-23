const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const http = require("node:http"), https = require("node:https");
const sharp = require("sharp");
const { resolveEvidenceStorageConfig } = require("../../src/config/evidenceStorage");
if (!resolveEvidenceStorageConfig().storageEmulator) throw Error("Explicit demo emulator configuration required.");
const originalRequest = http.request;
let guardedCreates = 0;
http.request = function (input, ...args) {
  const host = typeof input === "string" ? new URL(input).hostname : input.hostname || input.host;
  const port = typeof input === "string" ? new URL(input).port : input.port;
  if (host !== "127.0.0.1" || !["8080", "9199"].includes(String(port))) throw Error("Non-emulator HTTP blocked.");
  const url = typeof input === "string" || input instanceof URL
    ? new URL(input) : new URL(input.path || "/", `http://${host}:${port}`);
  if (url.pathname.startsWith("/upload/storage/v1/")) {
    assert.equal(url.searchParams.get("ifGenerationMatch"), "0", "SDK must transmit the create-only precondition");
    assert.equal(url.searchParams.get("uploadType"), "multipart", "trace actual nonresumable SDK transport");
    guardedCreates++;
  }
  return originalRequest.call(this, input, ...args);
};
https.request = () => { throw Error("Cloud HTTPS blocked."); };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["http://127.0.0.1:9199", "http://127.0.0.1:8080"].includes(url.origin)) throw Error("Non-emulator fetch blocked.");
  return originalFetch(input, init);
};
const { app, db, getStorageBucket } = require("../../src/config/firebase");
const { deleteApp } = require("firebase-admin/app");
const { Timestamp } = require("firebase-admin/firestore");
const { createFirebaseEvidenceStorage } = require("../../src/services/firebaseEvidenceStorage.service");
const bucket = getStorageBucket();
const created = new Set();
const sha = value => createHash("sha256").update(value).digest("hex");

async function fixture(faults = {}, type = "monitoring-official") {
  const recordId = `phase2-${randomUUID()}`, actorId = `actor-${randomUUID()}`;
  const wrappedDb = { projectId: db.projectId, collection: (...a) => db.collection(...a), async runTransaction(fn, options) {
    let finalWrite = false;
    const result = await db.runTransaction(tx => fn({ get: ref => tx.get(ref),
      set: (ref, value) => tx.set(ref, value),
      create(ref, value) { if (faults.reserve) throw Error("injected Firestore reserve failure"); tx.create(ref, value); },
      update(ref, value) {
        if (value.status === "UPLOADED") { finalWrite = true; if (faults.finish) throw Error("injected Firestore finish failure"); }
        tx.update(ref, value);
      } }), options);
    if (finalWrite && faults.ack) throw Error("injected lost commit acknowledgement");
    return result;
  } };
  const wrappedBucket = { name: bucket.name, storage: bucket.storage, file(name, options) {
    const object = bucket.file(name, options);
    return { getMetadata: (...args) => object.getMetadata(...args),
      createReadStream: (...args) => object.createReadStream(...args), async save(bytes, opts) {
        if (faults.save === "unavailable") throw Object.assign(Error("injected unavailable"), { code: 503 });
        if (faults.save === "timeout") throw Object.assign(Error("injected timeout"), { code: "ETIMEDOUT" });
        await object.save(bytes, opts);
        if (faults.save === "lost-response") throw Object.assign(Error("injected response loss"), { code: "ETIMEDOUT" });
      } };
  } };
  const adapter = createFirebaseEvidenceStorage({ db: wrappedDb, getBucket: () => wrappedBucket, log() {} });
  const context = adapter.serverContext({ actor: { uid: actorId }, evidenceType: type, recordId,
    verification: { latitude: 12.671, longitude: 123.94, capturedAt: "2026-10-20T00:00:00Z", gpsValid: true } });
  const buffer = await sharp({ create: { width: 13, height: 13, channels: 3, background: "green" } })
    .jpeg().withExif({ IFD0: { Artist: "synthetic-test" }, IFD2: { DateTimeOriginal: "2026:10:20 08:00:00" } }).toBuffer();
  const input = { buffer, contentType: "image/jpeg", sha256: sha(buffer) };
  return { ...adapter, context, input, recordId, actorId, faults, async reserveOne() {
    const { intentId } = await adapter.reserve(context, input); created.add(intentId); return intentId;
  }, doc: id => db.collection("evidenceUploadIntents").doc(id) };
}
test.after(async () => {
  // Ownership audit ONLY. This emulator does not enforce generation preconditions;
  // therefore do not risk unconditional deletion, even for our synthetic objects.
  // No objects are exported; the harness stops its own in-memory Storage emulator.
  for (const id of created) {
    const intent = (await db.collection("evidenceUploadIntents").doc(id).get()).data();
    if (!intent || intent.status === "LINKED" || intent.retainedAsRevision) continue;
    const object = bucket.file(intent.objectName);
    let metadata;
    try { [metadata] = await object.getMetadata(); } catch (error) { if (Number(error.code) === 404) continue; throw error; }
    assert.equal(metadata.metadata?.uploadIntentId, id);
    assert.equal(metadata.metadata.actorScope, sha(intent.actorId));
    assert.equal(metadata.metadata.recordScope, sha(intent.recordId));
  }
  await deleteApp(app);
});

test("real upload preserves original EXIF/image bytes, private metadata and persisted generation", async () => {
  const f = await fixture(), id = await f.reserveOne(), reference = await f.upload(f.context, id, f.input);
  const [metadata] = await bucket.file(reference.objectName).getMetadata();
  const [bytes] = await bucket.file(reference.objectName, { generation: reference.generation }).download();
  assert.deepEqual(bytes, f.input.buffer); assert.equal(sha(bytes), reference.sha256);
  assert.equal(reference.generation, String(metadata.generation)); assert.equal(reference.contentType, "image/jpeg");
  assert.equal(metadata.metadata.firebaseStorageDownloadTokens, undefined);
  assert.equal(metadata.acl?.some(entry => ["allUsers", "allAuthenticatedUsers"].includes(entry.entity)) || false, false);
  assert.equal((await f.doc(id).get()).data().status, "UPLOADED"); assert.equal(reference.url, undefined);
  assert.ok(guardedCreates > 0, "real HTTP request was checked before sending to emulator");
  const response = await fetch(`http://127.0.0.1:9199/v0/b/${bucket.name}/o/${encodeURIComponent(reference.objectName)}?alt=media`);
  assert.ok([401, 403].includes(response.status), "deny-all rules must reject unauthenticated access");
});
test("actual emulator create-only precondition rejects overwrite (required capability)", async t => {
  const f = await fixture(), id = await f.reserveOne(), first = await f.upload(f.context, id, f.input);
  const [metadata] = await bucket.file(first.objectName).getMetadata();
  try {
    await assert.rejects(() => bucket.file(first.objectName).save(Buffer.from("must-not-overwrite"),
    { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: {
      contentType: metadata.contentType, cacheControl: metadata.cacheControl, metadata: metadata.metadata,
    } }), error => Number(error.code) === 412);
    const [preserved] = await bucket.file(first.objectName).download();
    assert.deepEqual(preserved, f.input.buffer, "service must preserve original evidence after collision");
  } finally {
    const [after] = await bucket.file(first.objectName).getMetadata();
    const [bytes] = await bucket.file(first.objectName).download();
    t.diagnostic(JSON.stringify({ transport: "multipart", ifGenerationMatch: 0,
      generationChanged: String(after.generation) !== first.generation,
      originalBytesIntact: bytes.equals(f.input.buffer) }));
  }
});
test("idempotent adapter retries return the same generation and one object", async () => {
  const f = await fixture(), id = await f.reserveOne(), first = await f.upload(f.context, id, f.input);
  assert.deepEqual(await f.upload(f.context, id, f.input), first);
  const [objects] = await bucket.getFiles({ prefix: `evidence/v1/monitoring-official/${f.recordId}/`, autoPaginate: false, maxResults: 5 });
  assert.equal(objects.length, 1);
});
test("concurrent real transactions and same-intent uploads retain one immutable object", async () => {
  const f = await fixture(), id = await f.reserveOne();
  const results = await Promise.allSettled([f.upload(f.context, id, f.input), f.upload(f.context, id, f.input)]);
  assert.ok(results.some(result => result.status === "fulfilled"));
  assert.equal((await f.doc(id).get()).data().status, "UPLOADED");
  const [objects] = await bucket.getFiles({ prefix: `evidence/v1/monitoring-official/${f.recordId}/`, autoPaginate: false, maxResults: 5 });
  assert.equal(objects.length, 1);
  const [bytes] = await objects[0].download();
  assert.deepEqual(bytes, f.input.buffer);
});

test("conflicting retry after successful upload preserves original bytes and generation", async () => {
  const f = await fixture(), id = await f.reserveOne(), first = await f.upload(f.context, id, f.input);
  const buffer = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } }).jpeg().toBuffer();
  await assert.rejects(() => f.upload(f.context, id, { buffer, contentType: "image/jpeg" }), { code: "INTENT_CONFLICT" });
  const [metadata] = await bucket.file(first.objectName).getMetadata();
  const [bytes] = await bucket.file(first.objectName).download();
  assert.equal(String(metadata.generation), first.generation);
  assert.deepEqual(bytes, f.input.buffer);
  assert.deepEqual(await f.upload(f.context, id, f.input), first);
});
test("conflicting content cannot reuse the same durable intent", async () => {
  const f = await fixture(), id = await f.reserveOne();
  const buffer = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } }).jpeg().toBuffer();
  await assert.rejects(() => f.upload(f.context, id, { buffer, contentType: "image/jpeg" }), { code: "INTENT_CONFLICT" });
  assert.equal((await f.doc(id).get()).data().status, "RESERVED");
});
test("reservation retries create a single durable operation", async () => {
  const f = await fixture(), id = await f.reserveOne();
  assert.equal((await f.reserve(f.context, f.input)).intentId, id);
  assert.equal((await f.doc(id).get()).data().status, "RESERVED");
});
test("Storage timeout/unavailability persist reconciliation state then retry safely", async () => {
  for (const save of ["timeout", "unavailable"]) {
    const f = await fixture({ save }), id = await f.reserveOne();
    await assert.rejects(() => f.upload(f.context, id, f.input));
    assert.equal((await f.doc(id).get()).data().status, "RECONCILIATION_REQUIRED");
    f.faults.save = null; await f.upload(f.context, id, f.input);
    assert.equal((await f.doc(id).get()).data().status, "UPLOADED");
  }
});
test("successful create with lost Storage response recovers persisted bytes", async () => {
  const f = await fixture({ save: "lost-response" }), id = await f.reserveOne();
  const reference = await f.upload(f.context, id, f.input);
  assert.equal((await f.doc(id).get()).data().generation, reference.generation);
});
test("Firestore reserve failure leaves no object; finalization failure recovers existing object", async () => {
  const rejected = await fixture({ reserve: true });
  await assert.rejects(() => rejected.reserveOne(), { code: "FIRESTORE_UNAVAILABLE" });
  const [none] = await bucket.getFiles({ prefix: `evidence/v1/monitoring-official/${rejected.recordId}/`, autoPaginate: false, maxResults: 1 });
  assert.equal(none.length, 0);
  const f = await fixture({ finish: true }), id = await f.reserveOne();
  await assert.rejects(() => f.upload(f.context, id, f.input), { code: "FIRESTORE_UNAVAILABLE" });
  f.faults.finish = false;
  const reference = await f.upload(f.context, id, f.input);
  assert.equal((await f.doc(id).get()).data().generation, reference.generation);
});
test("lost Firestore acknowledgement does not delete a successfully committed object", async () => {
  const f = await fixture({ ack: true }), id = await f.reserveOne();
  await f.upload(f.context, id, f.input); assert.equal((await f.doc(id).get()).data().status, "UPLOADED");
});
test("process interruption with expired lease recovers the existing generation", async () => {
  const f = await fixture(), id = await f.reserveOne(), reference = await f.upload(f.context, id, f.input);
  await f.doc(id).update({ status: "UPLOADING", generation: null, reference: null,
    leaseOwner: "synthetic-crashed-process", leaseUntil: Timestamp.fromMillis(1) });
  assert.equal((await f.upload(f.context, id, f.input)).generation, reference.generation);
});
test("real metadata mismatch cannot overwrite an existing object", async () => {
  const f = await fixture(), id = await f.reserveOne(), reference = await f.upload(f.context, id, f.input);
  const object = bucket.file(reference.objectName), [metadata] = await object.getMetadata();
  await object.setMetadata({ metadata: { ...metadata.metadata, sha256: "incorrect" } });
  await assert.rejects(() => f.upload(f.context, id, f.input), { code: "OBJECT_METADATA_MISMATCH" });
  assert.equal(String((await object.getMetadata())[0].generation), reference.generation);
});
test("actual stored bytes are hashed, not merely trusted custom checksum metadata", async () => {
  const f = await fixture(), id = await f.reserveOne(), intent = (await f.doc(id).get()).data();
  await bucket.file(intent.objectName).save(Buffer.alloc(f.input.buffer.length, 1), {
    resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: {
      contentType: intent.contentType, cacheControl: "private, no-store", metadata: {
        schemaVersion: "1", uploadIntentId: id, actorScope: sha(f.actorId), recordScope: sha(f.recordId),
        evidenceType: intent.evidenceType, sha256: intent.sha256,
      } } });
  await assert.rejects(() => f.upload(f.context, id, f.input), { code: "CHECKSUM_MISMATCH" });
});
test("dry-run protects committed synthetic linkage and retained evidence revisions", async () => {
  for (const revision of [false, true]) {
    const f = await fixture(), id = await f.reserveOne(), reference = await f.upload(f.context, id, f.input);
    const link = db.collection("evidenceStoragePhase2Fixtures").doc(f.recordId);
    await db.runTransaction(async tx => {
      await tx.get(f.doc(id)); tx.create(link, { reference, syntheticTestOnly: true });
      tx.update(f.doc(id), revision ? { retainedAsRevision: true } : { status: "LINKED", linkedRecordPath: link.path });
    });
    const [row] = await f.reconciliationReport(f.context, [id]);
    assert.equal(row.classification, "PROTECTED"); assert.equal(row.cleanupAllowed, false);
    assert.ok((await bucket.file(reference.objectName).getMetadata())[0].generation);
  }
});
