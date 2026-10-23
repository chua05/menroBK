const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createEvidenceUploadQuota } = require("../src/services/evidenceUploadQuota.service");
const { resolveEvidenceUploadQuotaConfig, manilaDay } = require("../src/config/evidenceUploadQuota");
const { memoryFirestore } = require("./helpers/evidenceQuotaMemory");
const originalEnv = { ...process.env };
test.before(() => Object.assign(process.env, { MENRO_INTEGRATION_TEST: "true", NODE_ENV: "test",
  GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app",
  EVIDENCE_STORAGE_PROVIDER: "local" }));
test.after(() => { for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv); });
function harness(env = {}, memory = memoryFirestore(), clock = () => new Date("2026-10-20T00:00:00Z")) {
  const quota = createEvidenceUploadQuota({ db: memory.db, env, clock });
  const actor = quota.serverActor({ uid: "synthetic-actor" });
  const request = (extra = {}) => ({ intentId: randomUUID(), day: quota.today(), fileCount: 1, byteCount: 10, ...extra });
  const counter = () => [...memory.records("evidenceQuotaDays").values()][0];
  return { quota, actor, request, memory, counter };
}
test("quota defaults, overrides and strict bounded integer validation", () => {
  assert.deepEqual(resolveEvidenceUploadQuotaConfig({}), { fileLimit: 50, byteLimit: 209715200, alertBytes: 1073741824 });
  assert.equal(resolveEvidenceUploadQuotaConfig({ EVIDENCE_DAILY_FILE_LIMIT: "5" }).fileLimit, 5);
  for (const name of ["EVIDENCE_DAILY_FILE_LIMIT", "EVIDENCE_DAILY_BYTE_LIMIT", "EVIDENCE_GLOBAL_DAILY_ALERT_BYTES"]) {
    for (const value of ["0", "-1", "", "1.2", " 5", "1e3", "Infinity", "9007199254740992"]) {
      assert.throws(() => resolveEvidenceUploadQuotaConfig({ [name]: value }), /bounded positive whole number/);
    }
  }
});
test("Manila day crosses at 16:00 UTC including month/year boundaries", () => {
  assert.equal(manilaDay("2026-10-19T15:59:59.999Z"), "2026-10-19");
  assert.equal(manilaDay("2026-10-19T16:00:00.000Z"), "2026-10-20");
  assert.equal(manilaDay("2026-12-31T16:00:00Z"), "2027-01-01");
  assert.throws(() => manilaDay("invalid"));
});
test("reserve exact file boundary, enforce file excess, persist across service restart", async () => {
  const h = harness({ EVIDENCE_DAILY_FILE_LIMIT: "2" });
  await h.quota.reserve(h.actor, h.request()); await h.quota.reserve(h.actor, h.request());
  assert.equal(h.counter().reservedFiles, 2);
  const restarted = harness({ EVIDENCE_DAILY_FILE_LIMIT: "2" }, h.memory);
  await assert.rejects(() => restarted.quota.reserve(restarted.actor, restarted.request()), { code: "EVIDENCE_DAILY_QUOTA_EXCEEDED" });
});
test("byte boundary and independent actors", async () => {
  const h = harness({ EVIDENCE_DAILY_BYTE_LIMIT: "10" });
  await h.quota.reserve(h.actor, h.request());
  await assert.rejects(() => h.quota.reserve(h.actor, h.request()), { code: "EVIDENCE_DAILY_QUOTA_EXCEEDED" });
  await h.quota.reserve(h.quota.serverActor({ uid: "other" }), h.request());
  assert.equal(h.memory.records("evidenceQuotaDays").size, 2);
});
test("parallel admissions cannot oversubscribe count or bytes", async () => {
  const h = harness({ EVIDENCE_DAILY_FILE_LIMIT: "3", EVIDENCE_DAILY_BYTE_LIMIT: "30" });
  const outcomes = await Promise.allSettled(Array.from({ length: 15 }, () => h.quota.reserve(h.actor, h.request())));
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 3);
  assert.equal(h.counter().reservedBytes, 30);
});
test("duplicate retries and transaction admission do not double-charge", async () => {
  const h = harness(), request = h.request();
  await Promise.all(Array.from({ length: 10 }, () => h.quota.reserve(h.actor, request)));
  assert.equal(h.counter().reservedFiles, 1);
  assert.equal(h.memory.records("evidenceQuotaAudit").size, 1);
});
test("conflicting retry actor, day, files and bytes rejected", async () => {
  const h = harness(), request = h.request(); await h.quota.reserve(h.actor, request);
  for (const patch of [{ day: "2026-10-21" }, { fileCount: 2 }, { byteCount: 11 }]) {
    await assert.rejects(() => h.quota.reserve(h.actor, { ...request, ...patch }), { code: "QUOTA_RESERVATION_CONFLICT" });
  }
  await assert.rejects(() => h.quota.reserve(h.quota.serverActor({ uid: "other" }), request), { code: "QUOTA_RESERVATION_CONFLICT" });
});
test("guest and registered actor keys cannot collide; JSON actors and extra role claims rejected", async () => {
  const h = harness(), guest = h.quota.serverActor({ guestParticipantId: "synthetic-actor" });
  assert.notEqual(guest.key, h.actor.key); assert.match(guest.key, /^[a-f0-9]{64}$/);
  for (const invalid of [{}, { uid: "a", role: "admin" }, { uid: "../other" }, { uid: "email@example.com" }, { uid: "a", guestParticipantId: "a" }]) {
    assert.throws(() => h.quota.serverActor(invalid), { code: "INVALID_QUOTA_ACTOR" });
  }
  await assert.rejects(() => h.quota.reserve({ ...h.actor }, h.request()), { code: "INVALID_QUOTA_ACTOR" });
});
test("invalid reservation metadata rejected before writes", async () => {
  const h = harness();
  for (const patch of [{ day: "2026-02-30" }, { day: "yesterday" }, { intentId: "../other" },
    { fileCount: 0 }, { fileCount: 1.5 }, { byteCount: -1 }, { byteCount: 10 * 1024 * 1024 + 1 }]) {
    await assert.rejects(() => h.quota.reserve(h.actor, h.request(patch)), { code: "INVALID_QUOTA_RESERVATION" });
  }
  assert.equal(h.memory.records("evidenceQuotaReservations").size, 0);
});
test("unused reservation release is idempotent and never produces negative counters", async () => {
  const h = harness(), request = h.request(); await h.quota.reserve(h.actor, request);
  await h.quota.releaseUnused(h.actor, request.intentId); await h.quota.releaseUnused(h.actor, request.intentId);
  assert.equal(h.counter().reservedFiles, 0); assert.equal(h.counter().reservedBytes, 0);
  await assert.rejects(() => h.quota.reserve(h.actor, request), { code: "QUOTA_RESERVATION_RELEASED" });
});
test("attempted, uncertain and finalized reservations cannot be released on age alone", async () => {
  const h = harness(), request = h.request(); await h.quota.reserve(h.actor, request);
  const attempt = randomUUID();
  await h.memory.db.runTransaction(tx => h.quota.beginInTransaction(tx, h.actor, request.intentId, attempt));
  await h.memory.db.runTransaction(tx => h.quota.uncertainInTransaction(tx, h.actor, request.intentId, attempt));
  await assert.rejects(() => h.quota.releaseUnused(h.actor, request.intentId), { code: "QUOTA_RELEASE_UNSAFE" });
  const before = JSON.stringify([...h.memory.records("evidenceQuotaReservations")]);
  const [row] = await h.quota.reconciliationReport(h.actor, [request.intentId]);
  assert.equal(row.cleanupAllowed, false); assert.equal(row.needsObjectVerification, true);
  assert.equal(JSON.stringify([...h.memory.records("evidenceQuotaReservations")]), before);
});
test("verified finalization, retries and uncertainty recovery move reserved to finalized exactly once", async () => {
  const h = harness(), request = h.request(); await h.quota.reserve(h.actor, request);
  const attempt = randomUUID(), verified = { uploadIntentId: request.intentId, sizeBytes: 10, generation: "123" };
  await h.memory.db.runTransaction(tx => h.quota.beginInTransaction(tx, h.actor, request.intentId, attempt));
  for (let i = 0; i < 2; i++) await h.memory.db.runTransaction(tx => h.quota.uncertainInTransaction(tx, h.actor, request.intentId, attempt));
  assert.equal(h.counter().failedUploads, 1); assert.equal(h.counter().outstandingReconciliations, 1);
  await h.memory.db.runTransaction(tx => h.quota.finalizeInTransaction(tx, h.actor, request.intentId, verified));
  await h.memory.db.runTransaction(tx => h.quota.finalizeInTransaction(tx, h.actor, request.intentId, verified));
  assert.equal(h.counter().reservedBytes, 0); assert.equal(h.counter().finalizedBytes, 10);
  assert.equal(h.counter().outstandingReconciliations, 0);
  await assert.rejects(() => h.quota.releaseUnused(h.actor, request.intentId), { code: "QUOTA_RELEASE_UNSAFE" });
  await assert.rejects(() => h.memory.db.runTransaction(tx => h.quota.finalizeInTransaction(tx, h.actor, request.intentId,
    { ...verified, generation: "124" })), { code: "QUOTA_FINALIZATION_CONFLICT" });
});
test("reservation failure rolls back counter, ledger and audit atomically with safe error", async () => {
  const memory = memoryFirestore({ beforeCommit() { throw Error("secret database detail"); } });
  const h = harness({}, memory);
  await assert.rejects(() => h.quota.reserve(h.actor, h.request()), error => {
    assert.equal(error.code, "QUOTA_STORE_UNAVAILABLE"); assert.equal(error.message.includes("secret"), false); return true;
  });
  assert.equal(memory.records("evidenceQuotaReservations").size, 0);
  assert.equal(memory.records("evidenceQuotaDays").size, 0);
});
test("production project and provider are blocked before any quota writes", () => {
  assert.throws(() => createEvidenceUploadQuota({ db: { projectId: "menrosystem-ddfac" } }), { code: "QUOTA_EMULATOR_REQUIRED" });
  const previous = process.env.EVIDENCE_STORAGE_PROVIDER; process.env.EVIDENCE_STORAGE_PROVIDER = "firebase";
  try { assert.throws(() => harness(), /unavailable/); } finally { process.env.EVIDENCE_STORAGE_PROVIDER = previous; }
});
test("new Manila day admits new operations but cannot move existing usage to another day", async () => {
  let instant = new Date("2026-10-19T15:59:59Z");
  const h = harness({ EVIDENCE_DAILY_FILE_LIMIT: "1" }, memoryFirestore(), () => instant);
  const first = h.request(); await h.quota.reserve(h.actor, first);
  instant = new Date("2026-10-19T16:00:00Z");
  await h.quota.reserve(h.actor, h.request());
  await h.quota.reserve(h.actor, first);
  assert.equal(h.memory.records("evidenceQuotaDays").size, 2);
  await assert.rejects(() => h.quota.reserve(h.actor, { ...first, day: h.quota.today() }), { code: "QUOTA_RESERVATION_CONFLICT" });
  await assert.rejects(() => h.quota.reserve(h.actor, h.request({ day: "2026-10-18" })), { code: "INVALID_QUOTA_RESERVATION" });
});
test("counter corruption fails closed instead of decrementing below zero", async () => {
  const h = harness(), request = h.request(); await h.quota.reserve(h.actor, request);
  h.counter().reservedFiles = 0;
  await assert.rejects(() => h.quota.releaseUnused(h.actor, request.intentId), { code: "QUOTA_COUNTER_INTEGRITY" });
  assert.equal(h.memory.records("evidenceQuotaReservations").get(request.intentId).state, "RESERVED");
});
test("recovery report is actor-scoped and bounded", async () => {
  const h = harness(), request = h.request(); await h.quota.reserve(h.actor, request);
  await assert.rejects(() => h.quota.reconciliationReport(h.quota.serverActor({ uid: "other" }), [request.intentId]), { code: "QUOTA_RESERVATION_CONFLICT" });
  await assert.rejects(() => h.quota.reconciliationReport(h.actor, Array(101).fill(request.intentId)), { code: "INVALID_QUOTA_RESERVATION" });
});
test("unchanged production upload limiter counts failed HTTP attempts and blocks attempt 21 per actor", async () => {
  const express = require("express");
  const saved = { ...process.env }, modulePath = require.resolve("../src/middleware/rateLimiter.middleware");
  const previousModule = require.cache[modulePath];
  let uploadLimiter;
  try {
    process.env.MENRO_INTEGRATION_TEST = "false";
    for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) delete process.env[key];
    delete require.cache[modulePath];
    ({ uploadLimiter } = require(modulePath));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    delete require.cache[modulePath]; if (previousModule) require.cache[modulePath] = previousModule;
  }
  const app = express();
  // Synthetic identity middleware only: this is a limiter test, NOT an Auth acceptance test.
  app.post("/synthetic", (req, res, next) => {
    req.user = { uid: req.headers["x-synthetic-actor"] === "other" ? "other" : "limited", role: "admin" }; next();
  }, uploadLimiter, (req, res) => res.status(400).json({ success: false }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/synthetic`;
    for (let attempt = 0; attempt < 20; attempt++) assert.equal((await fetch(url, { method: "POST" })).status, 400);
    assert.equal((await fetch(url, { method: "POST" })).status, 429);
    assert.equal((await fetch(url, { method: "POST", headers: { "x-synthetic-actor": "other" } })).status, 400);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
