const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { memoryFirestore } = require("./helpers/evidenceQuotaMemory");
const { resolveEvidenceStorageConfig } = require("../src/config/evidenceStorage");
const { createEvidenceWorkflow, runWorkflow, COLLECTION, canonical } = require("../src/services/evidenceWorkflow.service");
const original = { ...process.env };
const demo = { NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", GCLOUD_PROJECT: "demo-menro-phase2",
  GOOGLE_CLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app",
  EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true" };
function environment() {
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) delete process.env[key];
  Object.assign(process.env, demo);
}
test.beforeEach(environment);
test.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); });
function fixture(options = {}) {
  const memory = memoryFirestore(options);
  const service = createEvidenceWorkflow({ db: memory.db, storage: {} });
  const request = { actor: { uid: `actor-${randomUUID()}` }, workflow: "monitoring-resubmit", target: "MON-1:OBS-1",
    key: "retry-key-123", payload: { expectedVersion: 1, totalMonitored: 25, remarks: "corrected" }, files: [] };
  let creates = 0;
  const resolve = async link => (await memory.db.collection("business").doc(link.recordId).get()).data();
  async function perform(operation) {
    await memory.db.runTransaction(async tx => {
      const complete = await service.prepareLink(tx, operation);
      complete({ recordId: operation.targetId });
      tx.create(memory.db.collection("business").doc(operation.targetId), { id: operation.targetId });
    });
    creates++;
    return resolve({ recordId: operation.targetId });
  }
  return { ...memory, service, request, resolve, perform, creates: () => creates };
}
test("cloud gate is explicit, credential-free, demo-only and production-rejected", () => {
  assert.equal(resolveEvidenceStorageConfig(demo).cloudWorkflow, true);
  for (const change of [{ NODE_ENV: "production" }, { GCLOUD_PROJECT: "real-project" },
    { EVIDENCE_STORAGE_PROVIDER: "local" }, { FIREBASE_STORAGE_BUCKET: "menrosystem-ddfac.firebasestorage.app" },
    { FIREBASE_STORAGE_EMULATOR_HOST: "localhost:9199" }, { GOOGLE_APPLICATION_CREDENTIALS: "ignored-secret-file" },
    { FIREBASE_PRIVATE_KEY: "" }, { FIREBASE_CONFIG: "{}" }, { GOOGLE_CLOUD_PROJECT: "real-project" }]) {
    assert.throws(() => resolveEvidenceStorageConfig({ ...demo, ...change }));
  }
  assert.throws(() => resolveEvidenceStorageConfig({ ...demo, EVIDENCE_CLOUD_WORKFLOW_ENABLED: "false" }));
  assert.throws(() => resolveEvidenceStorageConfig({ ...demo, EVIDENCE_CLOUD_WORKFLOW_ENABLED: "TRUE" }));
  const { createCorsOptions } = require("../src/config/cors");
  assert.ok(createCorsOptions(demo).allowedHeaders.includes("Idempotency-Key"));
  assert.deepEqual(createCorsOptions({ NODE_ENV: "production" }).allowedHeaders, ["Authorization", "Content-Type"]);
});
test("default local mode ignores the header and does not instantiate a ledger", async () => {
  for (const key of Object.keys(demo)) delete process.env[key];
  let called = 0;
  assert.equal(await runWorkflow({ key: "invalid key" }, operation => { assert.equal(operation, null); called++; return 7; }), 7);
  assert.equal(called, 1);
});
test("same-key same-payload resolves one durable business operation, including after response interruption", async () => {
  const f = fixture(); const first = await f.service.run(f.request, f.perform, f.resolve);
  for (let i = 0; i < 3; i++) assert.deepEqual(await f.service.run(f.request, () => assert.fail("must not run twice"), f.resolve), first);
  assert.equal(f.creates(), 1); assert.equal(f.records(COLLECTION).size, 1);
});
test("same-key different payload conflicts before business processing", async () => {
  const f = fixture(); await f.service.run(f.request, f.perform, f.resolve);
  await assert.rejects(() => f.service.run({ ...f.request, payload: { ...f.request.payload, totalMonitored: 26 } },
    f.perform, f.resolve), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
});
test("actor, workflow and target isolate key namespaces", async () => {
  const f = fixture(); await f.service.run(f.request, f.perform, f.resolve);
  for (const change of [{ actor: { uid: "another-user" } }, { actor: { guestParticipantId: f.request.actor.uid } },
    { target: "MON-2:OBS-1" }, { workflow: "monitoring-early" }]) await f.service.run({ ...f.request, ...change }, f.perform, f.resolve);
  assert.equal(f.creates(), 5); assert.equal(f.records(COLLECTION).size, 5);
});
test("malformed, repeated, blank and oversized keys fail closed", async () => {
  const f = fixture();
  for (const key of ["", "short", " spaces-key", "\r\nunsafe", "x".repeat(129), ["valid-key-1", "valid-key-2"], "nonascii-ñ"]) {
    await assert.rejects(() => f.service.run({ ...f.request, key }, f.perform, f.resolve), { code: "INVALID_IDEMPOTENCY_KEY", status: 400 });
  }
  assert.equal(f.records(COLLECTION).size, 0);
});
test("no-key operations are independent, not fingerprint-deduplicated", async () => {
  const f = fixture(); const req = { ...f.request, key: undefined };
  assert.notDeepEqual(await f.service.run(req, f.perform, f.resolve), await f.service.run(req, f.perform, f.resolve));
  assert.equal(f.creates(), 2);
});
test("concurrent retry returns a safe 202 without executing another business mutation", async () => {
  const f = fixture(); let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; }); const barrier = new Promise(resolve => { unblock = resolve; });
  const first = f.service.run(f.request, async op => { entered(); await barrier; return f.perform(op); }, f.resolve);
  await started;
  await assert.rejects(() => f.service.run(f.request, f.perform, f.resolve), { code: "EVIDENCE_IN_PROGRESS", status: 202 });
  unblock(); await first; assert.equal(f.creates(), 1);
});
test("failed business transaction retains retry handles and rolls back completion", async () => {
  let fail = true;
  const f = fixture({ beforeCommit(writes) { if (fail && writes.some(w => w.ref.collection === "business")) throw Error("simulated outage"); } });
  await assert.rejects(() => f.service.run(f.request, f.perform, f.resolve), /simulated outage/);
  const saved = [...f.records(COLLECTION).values()][0]; assert.equal(saved.status, "RETRYABLE");
  assert.equal(f.records("business").size, 0);
  fail = false; const result = await f.service.run(f.request, f.perform, f.resolve);
  assert.equal(result.id, saved.targetId); assert.equal(f.records("business").size, 1);
});
test("lost business commit acknowledgement recovers confirmed linkage instead of mutating again", async () => {
  let failed = false;
  const f = fixture({ afterCommit(writes) { if (!failed && writes.some(w => w.ref.collection === "business")) { failed = true; throw Error("lost ack"); } } });
  const result = await f.service.run(f.request, f.perform, f.resolve);
  assert.ok(result.id); assert.equal(f.records("business").size, 1);
  assert.deepEqual(await f.service.run(f.request, f.perform, f.resolve), result);
});
test("retention has no TTL: even ancient completed keys cannot create a second record", async () => {
  const f = fixture(); const result = await f.service.run(f.request, f.perform, f.resolve);
  const entry = [...f.records(COLLECTION).values()][0]; entry.createdAt = 1; entry.updatedAt = 1;
  assert.equal(entry.retentionPolicy, "retain-no-ttl-v1"); assert.equal(entry.expiresAt, undefined);
  assert.deepEqual(await f.service.run(f.request, f.perform, f.resolve), result); assert.equal(f.creates(), 1);
});
test("canonical payload identity sorts object keys, preserves array order and rejects unsafe values", () => {
  assert.equal(canonical({ b: 1, a: "2" }), canonical({ a: "2", b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.throws(() => canonical({ x: NaN }));
});
test("lost reservation acknowledgement leaves a fenced recoverable operation and a safe response", async () => {
  let once = true;
  const f = fixture({ afterCommit(writes) { if (once && writes.some(w => w.ref.collection === COLLECTION)) { once = false; throw Error("private backend path"); } } });
  await assert.rejects(() => f.service.run(f.request, f.perform, f.resolve), { code: "EVIDENCE_RECONCILIATION_REQUIRED", status: 503 });
  assert.equal(f.records("business").size, 0);
  await assert.rejects(() => f.service.run(f.request, f.perform, f.resolve), { code: "EVIDENCE_IN_PROGRESS", status: 202 });
  const saved = [...f.records(COLLECTION).values()][0]; saved.leaseUntil = 0;
  await f.service.run(f.request, f.perform, f.resolve); assert.equal(f.records("business").size, 1);
});
test("expired workers cannot complete after a new execution takes ownership", async () => {
  const f = fixture(); let obsolete;
  await assert.rejects(() => f.service.run(f.request, op => { obsolete = op; throw Error("interruption"); }, f.resolve));
  await f.service.run(f.request, f.perform, f.resolve);
  await assert.rejects(() => f.perform(obsolete), { code: "EVIDENCE_IN_PROGRESS", status: 202 });
  assert.equal(f.records("business").size, 1);
});
