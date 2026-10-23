// Internal evidence quota infrastructure. NEVER construct actors from req.body.
const { createHash } = require("node:crypto");
const { Timestamp, FieldPath } = require("firebase-admin/firestore");
const { resolveEvidenceStorageConfig } = require("../config/evidenceStorage");
const { resolveEvidenceUploadQuotaConfig, manilaDay } = require("../config/evidenceUploadQuota");
const sha = value => createHash("sha256").update(value).digest("hex");
const idValid = id => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const dayValid = day => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
const fields = ["reservedFiles", "reservedBytes", "finalizedFiles", "finalizedBytes",
  "uploadAttempts", "uploadRetries", "failedUploads", "outstandingReconciliations"];
class EvidenceQuotaError extends Error {
  constructor(code) { super(`Private evidence quota operation failed (${code}).`); this.code = code; }
}
const fail = code => { throw new EvidenceQuotaError(code); };
function guard() {
  const config = resolveEvidenceStorageConfig();
  if (!config.storageEmulator && !((config.gcsDevelopment || config.gcsProduction) && config.cloudWorkflow)) fail("QUOTA_EMULATOR_REQUIRED");
}
function createEvidenceUploadQuota({ db, clock = () => new Date(), env = process.env } = {}) {
  guard();
  db ||= require("../config/firebase").db;
  const storage = resolveEvidenceStorageConfig();
  const expectedProject = storage.gcsProduction?.projectId || "demo-menro-phase2";
  if (db.projectId !== expectedProject) fail("QUOTA_EMULATOR_REQUIRED");
  const config = resolveEvidenceUploadQuotaConfig(env), actors = new WeakSet();
  const reservations = db.collection("evidenceQuotaReservations");
  const counters = db.collection("evidenceQuotaDays");
  const intents = db.collection("evidenceUploadIntents");
  const audit = db.collection("evidenceQuotaAudit");
  function serverActor(input) {
    guard();
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).length !== 1) fail("INVALID_QUOTA_ACTOR");
    const kind = Object.hasOwn(input, "migrationScope") ? "migration" : Object.hasOwn(input, "uid") ? "user" : "guest";
    const identity = kind === "migration" ? input.migrationScope : kind === "user" ? input.uid : input.guestParticipantId;
    if (kind === "migration" && (process.env.MENRO_HISTORICAL_MIGRATION !== "true" || identity !== "historical-evidence-v1")) fail("INVALID_QUOTA_ACTOR");
    if (typeof identity !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(identity) || identity.includes("..")) fail("INVALID_QUOTA_ACTOR");
    const actor = Object.freeze({ key: sha(JSON.stringify(["v1", kind, identity])), kind });
    actors.add(actor); return actor;
  }
  function trusted(actor) { guard(); if (!actors.has(actor) || actor.kind === "migration" && process.env.MENRO_HISTORICAL_MIGRATION !== "true") fail("INVALID_QUOTA_ACTOR"); }
  function refs(actor, request) {
    trusted(actor);
    if (!idValid(request?.intentId) || !dayValid(request.day) ||
        !Number.isSafeInteger(request.fileCount) || request.fileCount < 1 || request.fileCount > 10 ||
        !Number.isSafeInteger(request.byteCount) || request.byteCount < 1 || request.byteCount > request.fileCount * 10 * 1024 * 1024) {
      fail("INVALID_QUOTA_RESERVATION");
    }
    return { reservation: reservations.doc(request.intentId), counter: counters.doc(`${request.day}_${actor.key}`) };
  }
  function consistent(row, actor, request) {
    if (row.actorKey !== actor.key || row.day !== request.day || row.uploadIntentId !== request.intentId ||
        row.expectedFiles !== request.fileCount || row.expectedBytes !== request.byteCount) fail("QUOTA_RESERVATION_CONFLICT");
  }
  function validCounter(data) {
    if (fields.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0)) fail("QUOTA_COUNTER_INTEGRITY");
    return data;
  }
  function validReservation(row) {
    if (!idValid(row.reservationId) || row.uploadIntentId !== row.reservationId || !dayValid(row.day) ||
        !/^[a-f0-9]{64}$/.test(row.actorKey) || !["RESERVED", "FINALIZED", "RELEASED", "RECONCILIATION_REQUIRED"].includes(row.state) ||
        !Number.isSafeInteger(row.version) || row.version < 1 ||
        ["expectedFiles", "expectedBytes", "actualFiles", "actualBytes", "attemptCount"].some(key => !Number.isSafeInteger(row[key]) || row[key] < 0) ||
        row.expectedFiles < 1 || row.expectedBytes < 1) fail("QUOTA_RESERVATION_INTEGRITY");
    return row;
  }
  function write(tx, ref, counterRef, row, data, action) {
    validCounter(data);
    const now = Timestamp.fromDate(new Date(clock()));
    row = { ...row, version: (row.version || 0) + 1, updatedAt: now };
    tx.set(ref, row);
    tx.set(counterRef, { ...data, updatedAt: now });
    tx.create(audit.doc(`${row.reservationId}_${row.version}`), {
      reservationId: row.reservationId, action, version: row.version, state: row.state,
      day: row.day, actorKey: row.actorKey, at: now,
    });
    return row;
  }
  async function transaction(fn) {
    guard();
    try { return await db.runTransaction(fn, { maxAttempts: 5 }); }
    catch (error) { if (error instanceof EvidenceQuotaError) throw error; fail("QUOTA_STORE_UNAVAILABLE"); }
  }
  // Caller must perform any additional intent reads BEFORE calling this method.
  async function reserveInTransaction(tx, actor, request) {
    const ref = refs(actor, request), doc = await tx.get(ref.reservation);
    if (doc.exists) {
      const row = validReservation(doc.data()); consistent(row, actor, request);
      if (row.state === "RELEASED") fail("QUOTA_RESERVATION_RELEASED");
      return row;
    }
    if (request.day !== manilaDay(clock())) fail("INVALID_QUOTA_RESERVATION");
    const snapshot = await tx.get(ref.counter);
    const current = snapshot.exists ? validCounter(snapshot.data()) :
      { day: request.day, actorKey: actor.key, ...Object.fromEntries(fields.map(key => [key, 0])) };
    const limits = actor.kind === "migration" ? { fileLimit: 50, byteLimit: 200 * 1024 * 1024 } : config;
    if (current.reservedFiles + current.finalizedFiles + request.fileCount > limits.fileLimit ||
        current.reservedBytes + current.finalizedBytes + request.byteCount > limits.byteLimit) fail("EVIDENCE_DAILY_QUOTA_EXCEEDED");
    const row = { reservationId: request.intentId, uploadIntentId: request.intentId, actorKey: actor.key,
      actorKind: actor.kind, day: request.day, expectedFiles: request.fileCount, expectedBytes: request.byteCount,
      actualFiles: 0, actualBytes: 0, state: "RESERVED", reconciliationRequired: false,
      attemptCount: 0, lastAttempt: null, lastFailureAttempt: null, generation: null,
      createdAt: Timestamp.fromDate(new Date(clock())) };
    return write(tx, ref.reservation, ref.counter, row, { ...current,
      reservedFiles: current.reservedFiles + request.fileCount,
      reservedBytes: current.reservedBytes + request.byteCount }, "RESERVED");
  }
  async function load(tx, actor, id) {
    trusted(actor); if (!idValid(id)) fail("INVALID_QUOTA_RESERVATION");
    const ref = reservations.doc(id), doc = await tx.get(ref);
    if (!doc.exists) fail("QUOTA_RESERVATION_NOT_FOUND");
    const row = validReservation(doc.data());
    if (row.actorKey !== actor.key) fail("QUOTA_RESERVATION_CONFLICT");
    const counterRef = counters.doc(`${row.day}_${actor.key}`), counter = await tx.get(counterRef);
    if (!counter.exists) fail("QUOTA_COUNTER_INTEGRITY");
    if (counter.data().actorKey !== row.actorKey || counter.data().day !== row.day) fail("QUOTA_COUNTER_INTEGRITY");
    return { ref, row, counterRef, data: validCounter(counter.data()) };
  }
  async function beginInTransaction(tx, actor, id, attempt) {
    if (!idValid(attempt)) fail("INVALID_QUOTA_RESERVATION");
    const { ref, row, counterRef, data } = await load(tx, actor, id);
    if (row.state === "RELEASED") fail("QUOTA_RESERVATION_RELEASED");
    if (row.state === "FINALIZED" || row.lastAttempt === attempt) return;
    return write(tx, ref, counterRef, { ...row, lastAttempt: attempt, attemptCount: row.attemptCount + 1 },
      { ...data, uploadAttempts: data.uploadAttempts + 1,
        uploadRetries: data.uploadRetries + (row.attemptCount ? 1 : 0) }, "ATTEMPT");
  }
  // Called ONLY after adapter verifies actual object bytes/generation outside the transaction.
  async function finalizeInTransaction(tx, actor, id, verified) {
    const { ref, row, counterRef, data } = await load(tx, actor, id);
    if (row.state === "RELEASED") fail("QUOTA_RESERVATION_RELEASED");
    if (verified?.uploadIntentId !== id || typeof verified.generation !== "string" || !/^\d+$/.test(verified.generation) ||
        row.expectedFiles !== 1 || verified.sizeBytes !== row.expectedBytes) fail("QUOTA_FINALIZATION_CONFLICT");
    if (row.state === "FINALIZED") {
      if (row.generation !== verified.generation || row.actualBytes !== verified.sizeBytes) fail("QUOTA_FINALIZATION_CONFLICT");
      if (!row.reconciliationRequired) return row;
      return write(tx, ref, counterRef, { ...row, reconciliationRequired: false, lastFailure: null },
        { ...data, outstandingReconciliations: data.outstandingReconciliations - 1 }, "RECONCILED");
    }
    return write(tx, ref, counterRef, { ...row, state: "FINALIZED", actualFiles: 1, actualBytes: verified.sizeBytes,
      generation: verified.generation, objectCreatedAt: verified.uploadedAt || null,
      observedStorageDay: verified.uploadedAt && Number.isFinite(Date.parse(verified.uploadedAt)) ? manilaDay(verified.uploadedAt) : null,
      finalizedAt: Timestamp.fromDate(new Date(clock())), reconciliationRequired: false, lastFailure: null },
      { ...data, reservedFiles: data.reservedFiles - row.expectedFiles, reservedBytes: data.reservedBytes - row.expectedBytes,
        finalizedFiles: data.finalizedFiles + 1, finalizedBytes: data.finalizedBytes + verified.sizeBytes,
        outstandingReconciliations: data.outstandingReconciliations - (row.reconciliationRequired ? 1 : 0) }, "FINALIZED");
  }
  async function uncertainInTransaction(tx, actor, id, attempt) {
    const { ref, row, counterRef, data } = await load(tx, actor, id);
    if (row.state === "RELEASED" || row.lastFailureAttempt === attempt) return;
    return write(tx, ref, counterRef, { ...row, state: row.state === "FINALIZED" ? "FINALIZED" : "RECONCILIATION_REQUIRED",
      reconciliationRequired: true, lastFailure: "UPLOAD_OUTCOME_REQUIRES_VERIFICATION", lastFailureAttempt: attempt },
      { ...data, failedUploads: data.failedUploads + 1,
        outstandingReconciliations: data.outstandingReconciliations + (row.reconciliationRequired ? 0 : 1) }, "RECONCILIATION_REQUIRED");
  }
  async function releaseUnused(actor, id) {
    return transaction(async tx => {
      const { ref, row, counterRef, data } = await load(tx, actor, id);
      const intentRef = intents.doc(id), intentDoc = await tx.get(intentRef), intent = intentDoc.data();
      if (row.state === "RELEASED") return row;
      // No age-based release. No release once any upload could have been attempted.
      if (row.state !== "RESERVED" || row.attemptCount !== 0 || row.reconciliationRequired ||
          (intent && (intent.quotaActorKey !== actor.key || intent.status !== "RESERVED" ||
          intent.attemptCount !== 0 || intent.generation || intent.reference || intent.leaseOwner))) fail("QUOTA_RELEASE_UNSAFE");
      const result = write(tx, ref, counterRef, { ...row, state: "RELEASED", releasedAt: Timestamp.fromDate(new Date(clock())) },
        { ...data, reservedFiles: data.reservedFiles - row.expectedFiles, reservedBytes: data.reservedBytes - row.expectedBytes }, "RELEASED_UNUSED");
      if (intent) tx.update(intentRef, { status: "RELEASED", updatedAt: Timestamp.fromDate(new Date(clock())) });
      return result;
    });
  }
  async function reconciliationReport(actor, ids) {
    trusted(actor); if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !idValid(id))) fail("INVALID_QUOTA_RESERVATION");
    try {
      const result = [];
      for (const id of ids) {
        const row = await transaction(async tx => {
          const { row } = await load(tx, actor, id);
          const doc = await tx.get(intents.doc(id)), intent = doc.data();
          return { reservationId: id, state: row.state, reservedBytes: ["RESERVED", "RECONCILIATION_REQUIRED"].includes(row.state) ? row.expectedBytes : 0,
            stale: (row.state === "RESERVED" || row.reconciliationRequired) &&
              new Date(clock()).getTime() - row.updatedAt.toMillis() >= 15 * 60 * 1000,
            intentState: intent?.status || "MISSING", needsObjectVerification: row.attemptCount > 0,
            reconciliationRequired: row.reconciliationRequired, cleanupAllowed: false };
        });
        result.push(row);
      }
      return result;
    } catch (error) { if (error instanceof EvidenceQuotaError) throw error; fail("QUOTA_STORE_UNAVAILABLE"); }
  }
  // Event/actor-day ledgers avoid a single global write hotspot. Bounded, cursor-based reporting.
  async function dailyUsageReport(day, { after = null, limit = 100 } = {}) {
    guard();
    if (!dayValid(day) || !Number.isInteger(limit) || limit < 1 || limit > 500 ||
        (after !== null && !new RegExp(`^${day}_[a-f0-9]{64}$`).test(after))) fail("INVALID_QUOTA_REPORT");
    try {
      let query = counters.orderBy(FieldPath.documentId()).startAt(`${day}_`).endAt(`${day}_\uf8ff`);
      if (after) query = counters.orderBy(FieldPath.documentId()).startAfter(after).endAt(`${day}_\uf8ff`);
      const page = await query.limit(limit + 1).get(), docs = page.docs.slice(0, limit);
      const totals = Object.fromEntries(fields.map(key => [key, 0]));
      for (const doc of docs) {
        const row = validCounter(doc.data());
        for (const field of fields) { totals[field] += row[field]; if (!Number.isSafeInteger(totals[field])) fail("QUOTA_COUNTER_INTEGRITY"); }
      }
      const hasMore = page.docs.length > limit;
      return { day, totals, actorDays: docs.length, hasMore, nextCursor: hasMore ? docs.at(-1).id : null,
        alertThresholdBytes: config.alertBytes, pageCrossesThreshold: totals.finalizedBytes >= config.alertBytes,
        scope: "PAGE_ONLY_NOT_A_BILLING_LIMIT", completeDay: !after && !hasMore };
    } catch (error) { if (error instanceof EvidenceQuotaError) throw error; fail("QUOTA_STORE_UNAVAILABLE"); }
  }
  async function dailyUsageSummary(day, { maxPages = 10, pageSize = 100 } = {}) {
    guard();
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) fail("INVALID_QUOTA_REPORT");
    const totals = Object.fromEntries(fields.map(key => [key, 0]));
    let after = null, actorDays = 0, pages = 0, page;
    do {
      page = await dailyUsageReport(day, { after, limit: pageSize });
      for (const key of fields) {
        totals[key] += page.totals[key];
        if (!Number.isSafeInteger(totals[key])) fail("QUOTA_COUNTER_INTEGRITY");
      }
      actorDays += page.actorDays; pages++; after = page.nextCursor;
    } while (page.hasMore && pages < maxPages);
    return { day, totals, actorDays, pages, completeScan: !page.hasMore, nextCursor: after,
      alertThresholdBytes: config.alertBytes,
      alert: totals.finalizedBytes >= config.alertBytes ? "CROSSED" : page.hasMore ? "UNKNOWN_INCOMPLETE_SCAN" : "NOT_OBSERVED_IN_COMPLETE_SCAN",
      scope: "APPLICATION_USAGE_NOT_A_BILLING_LIMIT_OR_ATOMIC_SNAPSHOT" };
  }
  return { serverActor, today: () => manilaDay(clock()), reserveInTransaction, beginInTransaction,
    finalizeInTransaction, uncertainInTransaction, releaseUnused, reconciliationReport, dailyUsageReport, dailyUsageSummary,
    reserve: (actor, request) => transaction(tx => reserveInTransaction(tx, actor, request)) };
}
module.exports = { createEvidenceUploadQuota, EvidenceQuotaError };
