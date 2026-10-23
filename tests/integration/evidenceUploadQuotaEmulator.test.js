// Real Firestore/Storage SDK tests. UUID synthetic data only; no deletion or fixture reset.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const http = require("node:http"), https = require("node:https");
const sharp = require("sharp");
const { resolveEvidenceStorageConfig } = require("../../src/config/evidenceStorage");
if (!resolveEvidenceStorageConfig().storageEmulator) throw Error("Explicit demo emulator configuration required.");
const request = http.request;
http.request = function (input, ...args) {
  const url = typeof input === "string" || input instanceof URL ? new URL(input) : null;
  const host = url ? url.hostname : input.hostname || input.host, port = url ? url.port : input.port;
  if (host !== "127.0.0.1" || !["8080", "9199"].includes(String(port))) throw Error("Non-emulator HTTP blocked");
  return request.call(this, input, ...args);
};
https.request = () => { throw Error("Cloud HTTPS blocked"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["http://127.0.0.1:8080", "http://127.0.0.1:9199"].includes(url.origin)) throw Error("Non-emulator fetch blocked");
  return originalFetch(input, options);
};
const { app, db, getStorageBucket } = require("../../src/config/firebase");
const { deleteApp } = require("firebase-admin/app");
const { Timestamp } = require("firebase-admin/firestore");
const { createEvidenceUploadQuota } = require("../../src/services/evidenceUploadQuota.service");
const { createFirebaseEvidenceStorage } = require("../../src/services/firebaseEvidenceStorage.service");
const clock = () => new Date("2045-06-15T00:00:00Z");
const bucket = getStorageBucket();
test.after(() => deleteApp(app));
function fixture(env = {}, faults = {}) {
  const uid = `phase3-${randomUUID()}`, recordId = `phase3-${randomUUID()}`;
  const wrappedDb = { projectId: db.projectId, collection: (...args) => db.collection(...args), runTransaction(fn, options) {
    if (faults.down) return Promise.reject(Error("injected private database outage"));
    return db.runTransaction(tx => fn({ get: ref => tx.get(ref), set: (ref, value) => tx.set(ref, value),
      create(ref, value) {
        if (faults.reserve && ref.parent.id === "evidenceUploadIntents") throw Error("injected private reserve failure");
        tx.create(ref, value);
      }, update(ref, value) {
        if (faults.finishOutage && value.status === "UPLOADED") {
          faults.down = true; throw Error("injected private database outage");
        }
        if (faults.finish && value.status === "UPLOADED") throw Error("injected private finish failure");
        tx.update(ref, value);
      } }), options);
  } };
  const quota = createEvidenceUploadQuota({ db: wrappedDb, env, clock }), actor = quota.serverActor({ uid });
  const adapter = createFirebaseEvidenceStorage({ db: wrappedDb, getBucket: () => bucket, clock, log() {} });
  const context = () => adapter.serverContext({ actor: { uid }, evidenceType: "monitoring-official", recordId });
  const input = async (format = "jpeg") => ({ contentType: `image/${format}`,
    buffer: await sharp({ create: { width: 11, height: 11, channels: 3, background: "green" } }).toFormat(format).toBuffer() });
  return { uid, recordId, quota, actor, adapter, context, input, faults,
    request: (extra = {}) => ({ intentId: randomUUID(), day: quota.today(), fileCount: 1, byteCount: 10, ...extra }),
    async counter() { return (await db.collection("evidenceQuotaDays").doc(`${quota.today()}_${actor.key}`).get()).data(); },
    reservation: id => db.collection("evidenceQuotaReservations").doc(id) };
}
test("real contention cannot exceed exact daily count/byte boundaries", async () => {
  const f = fixture({ EVIDENCE_DAILY_FILE_LIMIT: "3", EVIDENCE_DAILY_BYTE_LIMIT: "30" });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => f.quota.reserve(f.actor, f.request())));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 3);
  assert.equal((await f.counter()).reservedFiles, 3); assert.equal((await f.counter()).reservedBytes, 30);
  assert.ok(results.filter(result => result.status === "rejected").every(result => result.reason.code === "EVIDENCE_DAILY_QUOTA_EXCEEDED"));
});
test("real duplicate reservation and restarted service share one persistent charge", async () => {
  const f = fixture(), operation = f.request();
  await Promise.all(Array.from({ length: 6 }, () => f.quota.reserve(f.actor, operation)));
  const restarted = createEvidenceUploadQuota({ db, clock });
  await restarted.reserve(restarted.serverActor({ uid: f.uid }), operation);
  assert.equal((await f.counter()).reservedFiles, 1);
  await assert.rejects(() => f.quota.reserve(f.actor, { ...operation, byteCount: 11 }), { code: "QUOTA_RESERVATION_CONFLICT" });
});
test("independent registered/guest quotas and definite no-upload cancellation release", async () => {
  const f = fixture(), guest = f.quota.serverActor({ guestParticipantId: f.uid });
  await f.quota.reserve(f.actor, f.request());
  await f.quota.reserve(guest, f.request());
  assert.notEqual(guest.key, f.actor.key);
  const context = f.context(), input = await f.input(), { intentId } = await f.adapter.reserve(context, input);
  await Promise.all([f.adapter.releaseUnused(context, intentId), f.adapter.releaseUnused(context, intentId)]);
  assert.equal((await f.reservation(intentId).get()).data().state, "RELEASED");
  assert.equal((await f.counter()).reservedFiles, 1); // standalone reservation remains
  await assert.rejects(() => f.adapter.upload(context, intentId, input), { code: "INTENT_CONFLICT" });
  const intent = (await db.collection("evidenceUploadIntents").doc(intentId).get()).data();
  await assert.rejects(() => bucket.file(intent.objectName).getMetadata(), error => Number(error.code) === 404);
});
test("concurrent upload, original-byte verification, retry and replacement accounting", async () => {
  const f = fixture(), context = f.context(), input = await f.input(), { intentId } = await f.adapter.reserve(context, input);
  const results = await Promise.allSettled([f.adapter.upload(context, intentId, input), f.adapter.upload(context, intentId, input)]);
  assert.ok(results.some(result => result.status === "fulfilled"));
  const first = await f.adapter.upload(context, intentId, input);
  assert.equal((await f.counter()).finalizedFiles, 1); assert.equal((await f.counter()).reservedBytes, 0);
  assert.equal((await f.counter()).finalizedBytes, input.buffer.length);
  const secondContext = f.context(), replacement = await f.input("png"), next = await f.adapter.reserve(secondContext, replacement);
  await f.adapter.upload(secondContext, next.intentId, replacement);
  const [bytes] = await bucket.file(first.objectName).download(); assert.deepEqual(bytes, input.buffer);
  assert.equal((await f.counter()).finalizedFiles, 2);
  assert.equal((await f.counter()).finalizedBytes, input.buffer.length + replacement.buffer.length);
  await assert.rejects(() => f.adapter.releaseUnused(context, intentId), { code: "QUOTA_RELEASE_UNSAFE" });
});
test("quota and intent reservation roll back together if intent write fails", async () => {
  const f = fixture({}, { reserve: true }), context = f.context();
  await assert.rejects(async () => f.adapter.reserve(context, await f.input()), { code: "FIRESTORE_UNAVAILABLE" });
  assert.equal(await f.counter(), undefined);
  assert.equal((await f.reservation(context.intentId).get()).exists, false);
  assert.equal((await db.collection("evidenceUploadIntents").doc(context.intentId).get()).exists, false);
});
test("object creation then Firestore failure retains quota; restart/retry finalizes exactly once", async () => {
  const f = fixture({}, { finish: true }), context = f.context(), input = await f.input();
  const { intentId } = await f.adapter.reserve(context, input);
  await assert.rejects(() => f.adapter.upload(context, intentId, input), { code: "FIRESTORE_UNAVAILABLE" });
  const intent = (await db.collection("evidenceUploadIntents").doc(intentId).get()).data();
  const [metadata] = await bucket.file(intent.objectName).getMetadata();
  assert.equal((await f.counter()).reservedBytes, input.buffer.length);
  assert.equal((await f.reservation(intentId).get()).data().state, "RECONCILIATION_REQUIRED");
  await assert.rejects(() => f.adapter.releaseUnused(context, intentId), { code: "QUOTA_RELEASE_UNSAFE" });
  const restarted = createFirebaseEvidenceStorage({ db, getBucket: () => bucket, clock, log() {} });
  const newContext = restarted.serverContext({ actor: { uid: f.uid }, recordId: f.recordId, evidenceType: "monitoring-official" });
  const reference = await restarted.upload(newContext, intentId, input);
  await restarted.upload(newContext, intentId, input);
  assert.equal(reference.generation, String(metadata.generation));
  assert.equal((await f.counter()).finalizedFiles, 1); assert.equal((await f.counter()).reservedBytes, 0);
  assert.equal((await f.counter()).outstandingReconciliations, 0);
});
test("stale quota dry run cross-checks intent without releasing linked or ambiguous evidence", async () => {
  const f = fixture(), context = f.context(), input = await f.input(), { intentId } = await f.adapter.reserve(context, input);
  const reference = await f.adapter.upload(context, intentId, input);
  await db.runTransaction(async tx => {
    const ref = db.collection("evidenceUploadIntents").doc(intentId); await tx.get(ref);
    tx.update(ref, { status: "LINKED", retainedAsRevision: true });
  });
  const late = createEvidenceUploadQuota({ db, clock: () => new Date("2045-06-16T00:00:00Z") });
  const before = (await f.reservation(intentId).get()).data();
  const [report] = await late.reconciliationReport(late.serverActor({ uid: f.uid }), [intentId]);
  assert.equal(report.stale, false); assert.equal(report.intentState, "LINKED"); assert.equal(report.cleanupAllowed, false);
  assert.deepEqual((await f.reservation(intentId).get()).data(), before);
  const [bytes] = await bucket.file(reference.objectName).download(); assert.deepEqual(bytes, input.buffer);
  const unusedContext = f.context(), unused = await f.adapter.reserve(unusedContext, input);
  const [stale] = await late.reconciliationReport(late.serverActor({ uid: f.uid }), [unused.intentId]);
  assert.equal(stale.stale, true); assert.equal(stale.cleanupAllowed, false);
  assert.equal((await f.reservation(unused.intentId).get()).data().state, "RESERVED");
});
test("crash-like outage leaves durable lease/quota; next-day recovery keeps the original admission day", async () => {
  const f = fixture({}, { finishOutage: true }), context = f.context(), input = await f.input();
  const { intentId } = await f.adapter.reserve(context, input);
  await assert.rejects(() => f.adapter.upload(context, intentId, input), { code: "FIRESTORE_UNAVAILABLE" });
  const intentRef = db.collection("evidenceUploadIntents").doc(intentId), intent = (await intentRef.get()).data();
  assert.equal(intent.status, "UPLOADING"); assert.equal((await f.counter()).reservedFiles, 1);
  assert.equal((await f.reservation(intentId).get()).data().state, "RESERVED");
  const [before] = await bucket.file(intent.objectName).getMetadata();
  // Only our UUID fixture: simulate passage of the crashed process's lease, never shared data.
  await intentRef.update({ leaseUntil: Timestamp.fromMillis(1) });
  const restarted = createFirebaseEvidenceStorage({ db, getBucket: () => bucket,
    clock: () => new Date("2045-06-16T00:00:00Z"), log() {} });
  const newContext = restarted.serverContext({ actor: { uid: f.uid }, recordId: f.recordId, evidenceType: "monitoring-official" });
  const reference = await restarted.upload(newContext, intentId, input);
  assert.equal(reference.generation, String(before.generation));
  assert.equal((await f.counter()).reservedFiles, 0); assert.equal((await f.counter()).finalizedFiles, 1);
  assert.equal((await db.collection("evidenceQuotaDays").doc(`2045-06-16_${f.actor.key}`).get()).exists, false);
});
test("a never-attempted previous-day reservation cannot bypass today's admission quota", async () => {
  const f = fixture(), context = f.context(), input = await f.input();
  const { intentId } = await f.adapter.reserve(context, input);
  const nextDay = createFirebaseEvidenceStorage({ db, getBucket: () => bucket,
    clock: () => new Date("2045-06-16T00:00:00Z"), log() {} });
  const trusted = nextDay.serverContext({ actor: { uid: f.uid }, recordId: f.recordId, evidenceType: "monitoring-official" });
  await assert.rejects(() => nextDay.upload(trusted, intentId, input), { code: "QUOTA_RESERVATION_DAY_CLOSED" });
  await nextDay.releaseUnused(trusted, intentId);
  assert.equal((await f.counter()).reservedBytes, 0);
  assert.equal((await f.reservation(intentId).get()).data().state, "RELEASED");
});
test("bounded global accounting reports threshold, pagination and budget exhaustion without global hot writes", async () => {
  const f = fixture({ EVIDENCE_GLOBAL_DAILY_ALERT_BYTES: "1" });
  const page = await f.quota.dailyUsageReport(f.quota.today(), { limit: 1 });
  assert.equal(page.actorDays, 1); assert.equal(page.hasMore, true); assert.ok(page.nextCursor);
  const next = await f.quota.dailyUsageReport(f.quota.today(), { limit: 1, after: page.nextCursor });
  assert.ok(next.actorDays > 0);
  const partial = await f.quota.dailyUsageSummary(f.quota.today(), { maxPages: 1, pageSize: 1 });
  assert.equal(partial.completeScan, false); assert.ok(partial.nextCursor);
  assert.ok(["CROSSED", "UNKNOWN_INCOMPLETE_SCAN"].includes(partial.alert));
  const summary = await f.quota.dailyUsageSummary(f.quota.today(), { maxPages: 20, pageSize: 500 });
  assert.equal(summary.completeScan, true); assert.equal(summary.alert, "CROSSED");
  assert.ok(summary.totals.finalizedBytes > 0);
});
