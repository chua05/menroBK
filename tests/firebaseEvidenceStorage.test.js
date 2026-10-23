const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const sharp = require("sharp");
const { createFirebaseEvidenceStorage } = require("../src/services/firebaseEvidenceStorage.service");
const { memoryFirestore } = require("./helpers/evidenceQuotaMemory");

const originalEnv = { ...process.env };
test.before(() => Object.assign(process.env, { MENRO_INTEGRATION_TEST: "true", NODE_ENV: "test",
  GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app",
  EVIDENCE_STORAGE_PROVIDER: "local" }));
test.after(() => { for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv); });

function harness() {
  const objects = new Map(), logs = [];
  const faults = {};
  let saves = 0, generation = 0;
  const memory = memoryFirestore({ beforeCommit(writes) {
    if (faults.reserve && writes.some(({ value }) => value.status === "RESERVED")) {
      throw Object.assign(Error("private SDK failure"), { code: "UNAVAILABLE" });
    }
    if (faults.finish && writes.some(({ value }) => value.status === "UPLOADED")) throw Error("private SDK failure");
  }, afterCommit(writes) {
    if (faults.ack && writes.some(({ value }) => value.status === "UPLOADED")) throw Error("lost acknowledgement");
  } });
  const { db } = memory, records = memory.records("evidenceUploadIntents");
  const bucket = { name: "demo-menro-phase2.firebasestorage.app", file(name) {
    return { async save(bytes, options) {
      assert.equal(memory.inTransaction(), false);
      assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
      saves++;
      if (objects.has(name)) throw Object.assign(Error("exists"), { code: 412 });
      if (faults.save === "unavailable") throw Object.assign(Error("secret SDK detail"), { code: 503 });
      if (faults.save === "timeout") throw Object.assign(Error("secret SDK detail"), { code: "ETIMEDOUT" });
      const metadata = { ...options.metadata, generation: String(++generation), size: String(bytes.length), timeCreated: "2026-10-20T00:00:00.000Z" };
      objects.set(name, { bytes: Buffer.from(bytes), metadata });
      if (faults.save === "lost-response") throw Object.assign(Error("secret SDK detail"), { code: "ETIMEDOUT" });
    }, async getMetadata() {
      assert.equal(memory.inTransaction(), false);
      if (!objects.has(name)) throw Object.assign(Error("missing"), { code: 404 });
      return [objects.get(name).metadata];
    }, createReadStream() { assert.equal(memory.inTransaction(), false); return Readable.from([objects.get(name).bytes]); } };
  } };
  const service = createFirebaseEvidenceStorage({ db, getBucket: () => bucket, log: event => logs.push(event) });
  const context = service.serverContext({ actor: { uid: "synthetic-actor" }, evidenceType: "monitoring-official",
    recordId: "synthetic-record", verification: { latitude: 12, longitude: 123, gpsValid: true, capturedAt: "2026-10-20" } });
  return { ...service, context, records, objects, faults, logs, memory, bucket, saves: () => saves };
}
async function image(format = "jpeg") {
  const buffer = await sharp({ create: { width: 12, height: 12, channels: 3, background: "green" } }).toFormat(format).toBuffer();
  return { buffer, contentType: `image/${format}` };
}
async function prepared(h) { const input = await image(); return { input, id: (await h.reserve(h.context, input)).intentId }; }

for (const format of ["jpeg", "png", "webp"]) test(`preserves original ${format} bytes, metadata, real generation and private reference`, async () => {
  const h = harness(), input = await image(format), { intentId } = await h.reserve(h.context, input);
  const reference = await h.upload(h.context, intentId, input), stored = h.objects.get(reference.objectName);
  assert.deepEqual(stored.bytes, input.buffer);
  assert.equal(reference.generation, stored.metadata.generation);
  assert.equal(reference.contentType, input.contentType);
  assert.equal(h.records.get(intentId).status, "UPLOADED");
  assert.equal(h.records.get(intentId).verificationJson.includes('"latitude":12'), true);
  assert.equal(stored.metadata.metadata.firebaseStorageDownloadTokens, undefined);
  assert.equal(reference.url, undefined); assert.equal(stored.metadata.acl, undefined);
  const daily = [...h.memory.records("evidenceQuotaDays").values()][0];
  assert.equal(daily.reservedFiles, 0); assert.equal(daily.finalizedFiles, 1);
  assert.equal(daily.finalizedBytes, input.buffer.length);
});
test("repeated upload is idempotent and verifies existing bytes without rewriting", async () => {
  const h = harness(), { id, input } = await prepared(h);
  assert.deepEqual(await h.upload(h.context, id, input), await h.upload(h.context, id, input));
  assert.equal(h.saves(), 1); assert.equal(h.objects.size, 1);
});
test("different-content retry after success preserves original bytes, metadata and generation", async () => {
  const h = harness(), { id, input } = await prepared(h);
  const reference = await h.upload(h.context, id, input);
  const before = JSON.stringify(h.objects.get(reference.objectName).metadata);
  await assert.rejects(async () => h.upload(h.context, id, await image("png")), { code: "INTENT_CONFLICT" });
  assert.deepEqual(h.objects.get(reference.objectName).bytes, input.buffer);
  assert.equal(JSON.stringify(h.objects.get(reference.objectName).metadata), before);
  assert.deepEqual(await h.upload(h.context, id, input), reference);
  assert.equal(h.saves(), 1);
});
test("reservation retries on the same server operation return one durable intent", async () => {
  const h = harness(), input = await image();
  const [first, second] = await Promise.all([h.reserve(h.context, input), h.reserve(h.context, input)]);
  assert.equal(first.intentId, second.intentId); assert.equal(h.records.size, 1);
  await assert.rejects(async () => h.reserve(h.context, await image("png")), { code: "INTENT_CONFLICT" });
});
test("JSON contexts, ownership overrides, paths and unsupported types are rejected", async () => {
  const h = harness();
  await assert.rejects(() => h.reserve({ ...h.context }, awaitableInput()), { code: "INVALID_UPLOAD_CONTEXT" });
  function awaitableInput() { return { buffer: Buffer.from("not reached"), contentType: "image/jpeg" }; }
  for (const recordId of ["../other", "a/b", "a\\b", "name@example.org", "a..b", "personal name"]) {
    assert.throws(() => h.serverContext({ actor: { uid: "actor" }, recordId, evidenceType: "planting-report" }), { code: "INVALID_UPLOAD_CONTEXT" });
  }
  assert.throws(() => h.serverContext({ actor: { uid: "actor", role: "admin" }, recordId: "record", evidenceType: "planting-report" }), { code: "INVALID_UPLOAD_CONTEXT" });
  assert.throws(() => h.serverContext({ actor: { uid: "actor" }, recordId: "record", evidenceType: "arbitrary" }), { code: "UNSUPPORTED_EVIDENCE_TYPE" });
});
test("invalid bytes, forged type/hash and privileged upload options are rejected", async () => {
  const h = harness(), input = await image();
  for (const invalid of [{ ...input, contentType: "image/png" }, { ...input, buffer: Buffer.from("bad") },
    { ...input, bucket: "production" }, { ...input, objectName: "arbitrary/path" }]) {
    await assert.rejects(() => h.reserve(h.context, invalid), { code: "INVALID_FILE_METADATA" });
  }
  await assert.rejects(() => h.reserve(h.context, { ...input, sha256: "wrong" }), { code: "CHECKSUM_MISMATCH" });
});
test("conflicting retry bytes and actors cannot replace an intent", async () => {
  const h = harness(), { id } = await prepared(h);
  await assert.rejects(async () => h.upload(h.context, id, await image("png")), { code: "INTENT_CONFLICT" });
  const other = h.serverContext({ actor: { uid: "other" }, recordId: "synthetic-record", evidenceType: "monitoring-official" });
  await assert.rejects(async () => h.upload(other, id, await image()), { code: "INTENT_CONFLICT" });
  assert.equal(h.saves(), 0);
});
test("Storage failure and timeout are durable, safe to retry, and never delete", async () => {
  for (const mode of ["timeout", "unavailable"]) {
    const h = harness(), { id, input } = await prepared(h); h.faults.save = mode;
    await assert.rejects(() => h.upload(h.context, id, input), { code: mode === "timeout" ? "STORAGE_TIMEOUT" : "STORAGE_UNAVAILABLE" });
    assert.equal(h.records.get(id).status, "RECONCILIATION_REQUIRED");
    h.faults.save = null; await h.upload(h.context, id, input); assert.equal(h.objects.size, 1);
  }
});
test("lost Storage response recovers the existing object without another write", async () => {
  const h = harness(), { id, input } = await prepared(h); h.faults.save = "lost-response";
  await h.upload(h.context, id, input); assert.equal(h.saves(), 1);
});
test("Firestore reserve failure cannot upload an object", async () => {
  const h = harness(); h.faults.reserve = true;
  await assert.rejects(async () => h.reserve(h.context, await image()), error => {
    assert.equal(error.code, "FIRESTORE_UNAVAILABLE");
    assert.equal(error.message.includes("private SDK failure"), false);
    return true;
  });
  assert.equal(h.saves(), 0); assert.equal(h.objects.size, 0);
});
test("Firestore finish failure recovers after a restart-like retry without duplicate bytes", async () => {
  const h = harness(), { id, input } = await prepared(h); h.faults.finish = true;
  await assert.rejects(() => h.upload(h.context, id, input), { code: "FIRESTORE_UNAVAILABLE" });
  assert.equal(h.objects.size, 1); h.faults.finish = false;
  await h.upload(h.context, id, input); assert.equal(h.saves(), 1);
});
test("lost Firestore commit acknowledgement preserves committed UPLOADED state", async () => {
  const h = harness(), { id, input } = await prepared(h); h.faults.ack = true;
  await h.upload(h.context, id, input); assert.equal(h.records.get(id).status, "UPLOADED");
});
test("object metadata and checksum mismatches are not overwritten", async () => {
  for (const kind of ["metadata", "checksum", "public"]) {
    const h = harness(), { id, input } = await prepared(h), reference = await h.upload(h.context, id, input);
    const object = h.objects.get(reference.objectName);
    if (kind === "metadata") object.metadata.metadata.actorScope = "different-owner";
    if (kind === "public") object.metadata.metadata.firebaseStorageDownloadTokens = "forbidden";
    if (kind === "checksum") object.bytes = Buffer.alloc(input.buffer.length, 1);
    await assert.rejects(() => h.upload(h.context, id, input), { code: kind === "checksum" ? "CHECKSUM_MISMATCH" : "OBJECT_METADATA_MISMATCH" });
    assert.equal(h.saves(), 1); assert.equal(h.objects.size, 1);
  }
});
test("bounded failed attempts stop writes and preserve reconciliation information", async () => {
  const h = harness(), { id, input } = await prepared(h); h.faults.save = "timeout";
  for (let i = 0; i < 3; i++) await assert.rejects(() => h.upload(h.context, id, input));
  await assert.rejects(() => h.upload(h.context, id, input), { code: "RECONCILIATION_REQUIRED" });
  assert.equal(h.saves(), 3); assert.equal(h.records.get(id).attemptCount, 3);
});
test("concurrent same-intent uploads cannot overwrite or duplicate evidence", async () => {
  const h = harness(), { id, input } = await prepared(h);
  const results = await Promise.allSettled([h.upload(h.context, id, input), h.upload(h.context, id, input)]);
  assert.ok(results.some(result => result.status === "fulfilled")); assert.equal(h.objects.size, 1); assert.equal(h.saves(), 1);
});
test("dry-run is bounded, nonmutating and preserves linked/revision objects", async () => {
  const h = harness(), { id, input } = await prepared(h);
  assert.equal((await h.reconciliationReport(h.context, [id]))[0].classification, "INCOMPLETE_NO_OBJECT");
  await h.upload(h.context, id, input);
  assert.match((await h.reconciliationReport(h.context, [id]))[0].classification, /UNLINKED_CANDIDATE/);
  for (const value of [{ status: "LINKED" }, { status: "UPLOADED", retainedAsRevision: true }]) {
    Object.assign(h.records.get(id), value);
    const before = JSON.stringify([...h.records]);
    const [row] = await h.reconciliationReport(h.context, [id]);
    assert.equal(row.classification, "PROTECTED"); assert.equal(row.cleanupAllowed, false);
    assert.equal(JSON.stringify([...h.records]), before); assert.equal(h.objects.size, 1);
  }
  await assert.rejects(() => h.reconciliationReport(h.context, Array(101).fill(id)), { code: "INVALID_UPLOAD_CONTEXT" });
  assert.equal(JSON.stringify(h.logs).includes('"latitude"'), false);
  assert.equal(JSON.stringify(h.logs).includes('"longitude"'), false);
  assert.equal(JSON.stringify(h.logs).includes("evidence/v1"), false);
});
test("environment changes cannot turn an existing adapter into a cloud client", () => {
  const h = harness(), host = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  process.env.FIREBASE_STORAGE_EMULATOR_HOST = "public.example:9199";
  try { assert.throws(() => h.serverContext({}), /approved loopback Storage/); }
  finally { process.env.FIREBASE_STORAGE_EMULATOR_HOST = host; }
});

test("quota and intent admission fail atomically and quota rejection performs no Storage write", async () => {
  const h = harness(); h.faults.reserve = true;
  await assert.rejects(async () => h.reserve(h.context, await image()));
  assert.equal(h.memory.records("evidenceQuotaDays").size, 0);
  assert.equal(h.memory.records("evidenceQuotaReservations").size, 0);
  assert.equal(h.records.size, 0); assert.equal(h.saves(), 0);
  h.faults.reserve = false;
  const input = await image(); await h.reserve(h.context, input);
  const daily = [...h.memory.records("evidenceQuotaDays").values()][0];
  daily.reservedFiles = 50;
  const other = h.serverContext({ actor: { uid: "synthetic-actor" }, recordId: "new-record", evidenceType: "monitoring-official" });
  await assert.rejects(() => h.reserve(other, input), { code: "EVIDENCE_DAILY_QUOTA_EXCEEDED" });
  assert.equal(h.records.size, 1); assert.equal(h.saves(), 0);
});
test("cancelled unused intent releases quota safely and cannot subsequently upload", async () => {
  const h = harness(), { id, input } = await prepared(h);
  await h.releaseUnused(h.context, id); await h.releaseUnused(h.context, id);
  const daily = [...h.memory.records("evidenceQuotaDays").values()][0];
  assert.equal(daily.reservedFiles, 0); assert.equal(daily.reservedBytes, 0);
  await assert.rejects(() => h.upload(h.context, id, input), { code: "INTENT_CONFLICT" });
  assert.equal(h.saves(), 0);
});
test("ambiguous failed save retains quota until verified recovery and counts only once", async () => {
  const h = harness(), { id, input } = await prepared(h); h.faults.save = "timeout";
  await assert.rejects(() => h.upload(h.context, id, input));
  const daily = () => [...h.memory.records("evidenceQuotaDays").values()][0];
  assert.equal(daily().reservedBytes, input.buffer.length);
  await assert.rejects(() => h.releaseUnused(h.context, id), { code: "QUOTA_RELEASE_UNSAFE" });
  assert.equal((await h.quotaReconciliationReport(h.context, [id]))[0].reconciliationRequired, true);
  h.faults.save = null; await h.upload(h.context, id, input); await h.upload(h.context, id, input);
  assert.equal(daily().reservedBytes, 0); assert.equal(daily().finalizedBytes, input.buffer.length);
  assert.equal(daily().finalizedFiles, 1); assert.equal(daily().uploadRetries, 1);
});
test("Storage success plus Firestore failure keeps quota reserved, restart recovers without duplicate charge", async () => {
  const h = harness(), { id, input } = await prepared(h); h.faults.finish = true;
  await assert.rejects(() => h.upload(h.context, id, input));
  assert.equal([...h.memory.records("evidenceQuotaDays").values()][0].reservedFiles, 1);
  h.faults.finish = false;
  const restarted = createFirebaseEvidenceStorage({ db: h.memory.db, getBucket: () => h.bucket, log() {} });
  const context = restarted.serverContext({ actor: { uid: "synthetic-actor" }, evidenceType: "monitoring-official",
    recordId: "synthetic-record", verification: { latitude: 12, longitude: 123, gpsValid: true, capturedAt: "2026-10-20" } });
  await restarted.upload(context, id, input);
  assert.equal(h.saves(), 1); assert.equal([...h.memory.records("evidenceQuotaDays").values()][0].finalizedFiles, 1);
});
test("new replacement counts new bytes but reuse of existing verified intent does not", async () => {
  const h = harness(), { id, input } = await prepared(h);
  const first = await h.upload(h.context, id, input);
  const context = h.serverContext({ actor: { uid: "synthetic-actor" }, evidenceType: "monitoring-official",
    recordId: "synthetic-record", verification: { latitude: 12, longitude: 123, gpsValid: true, capturedAt: "2026-10-20" } });
  assert.deepEqual(await h.upload(context, id, input), first);
  const replacement = await image("png"), next = await h.reserve(context, replacement);
  await h.upload(context, next.intentId, replacement);
  const daily = [...h.memory.records("evidenceQuotaDays").values()][0];
  assert.equal(daily.finalizedFiles, 2); assert.equal(daily.finalizedBytes, input.buffer.length + replacement.buffer.length);
  assert.deepEqual(h.objects.get(first.objectName).bytes, input.buffer);
});
test("validated guest actor has a separate persistent quota without a Firebase UID", async () => {
  const h = harness(), input = await image();
  const guest = h.serverContext({ actor: { guestParticipantId: "synthetic-actor" }, recordId: "record", evidenceType: "planting-contribution" });
  const { intentId } = await h.reserve(guest, input); await h.upload(guest, intentId, input);
  await h.reserve(h.context, input);
  assert.equal(h.memory.records("evidenceQuotaDays").size, 2);
  assert.equal(h.records.get(intentId).actorKind, "guest");
});
test("legacy Phase 2 intent is reported without silently inventing quota history", async () => {
  const h = harness(), { id, input } = await prepared(h);
  delete h.records.get(id).quotaVersion;
  const before = JSON.stringify([...h.memory.records("evidenceQuotaDays")]);
  await assert.rejects(() => h.upload(h.context, id, input), { code: "LEGACY_INTENT_REQUIRES_RECONCILIATION" });
  assert.equal((await h.reconciliationReport(h.context, [id]))[0].classification, "INCOMPLETE_NO_OBJECT");
  assert.equal(JSON.stringify([...h.memory.records("evidenceQuotaDays")]), before);
  assert.equal(h.saves(), 0);
});
test("unused prior-day reservations cannot create new objects; safely release and readmit today", async () => {
  const h = harness(); let date = new Date("2026-10-20T00:00:00Z");
  const adapter = createFirebaseEvidenceStorage({ db: h.memory.db, getBucket: () => h.bucket, clock: () => date, log() {} });
  const context = adapter.serverContext({ actor: { uid: "day-test" }, recordId: "record", evidenceType: "monitoring-official" });
  const input = await image(), { intentId } = await adapter.reserve(context, input);
  date = new Date("2026-10-21T00:00:00Z");
  await assert.rejects(() => adapter.upload(context, intentId, input), { code: "QUOTA_RESERVATION_DAY_CLOSED" });
  assert.equal(h.saves(), 0); assert.equal(h.records.get(intentId).attemptCount, 0);
  await adapter.releaseUnused(context, intentId);
  const next = adapter.serverContext({ actor: { uid: "day-test" }, recordId: "record", evidenceType: "monitoring-official" });
  const reservation = await adapter.reserve(next, input); await adapter.upload(next, reservation.intentId, input);
  assert.equal(h.records.get(reservation.intentId).quotaDay, "2026-10-21");
});
test("ambiguous prior-day retry cannot write absent object against yesterday's quota", async () => {
  const h = harness(); let date = new Date("2026-10-20T00:00:00Z");
  const adapter = createFirebaseEvidenceStorage({ db: h.memory.db, getBucket: () => h.bucket, clock: () => date, log() {} });
  const context = adapter.serverContext({ actor: { uid: "day-test" }, recordId: "record", evidenceType: "monitoring-official" });
  const input = await image(), { intentId } = await adapter.reserve(context, input);
  h.faults.save = "timeout"; await assert.rejects(() => adapter.upload(context, intentId, input));
  h.faults.save = null; date = new Date("2026-10-21T00:00:00Z");
  await assert.rejects(() => adapter.upload(context, intentId, input), { code: "QUOTA_RESERVATION_DAY_CLOSED" });
  assert.equal(h.saves(), 1); assert.equal(h.objects.size, 0);
  await assert.rejects(() => adapter.releaseUnused(context, intentId), { code: "QUOTA_RELEASE_UNSAFE" });
});
