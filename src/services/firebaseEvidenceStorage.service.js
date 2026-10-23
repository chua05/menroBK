// Internal private evidence infrastructure. Never call with req.body or expose directly via a route.
const { randomUUID, createHash } = require("node:crypto");
const { PassThrough } = require("node:stream");
const { Timestamp } = require("firebase-admin/firestore");
const { resolveEvidenceStorageConfig } = require("../config/evidenceStorage");
const { evidenceObjectName, matchesEvidenceObject } = require('../config/developmentGcs');
const { validateImageBuffer, generateImageHash } = require("../utils/imageVerification.util");
const { createEvidenceUploadQuota, EvidenceQuotaError } = require("./evidenceUploadQuota.service");

const TYPES = new Set(["planting-report", "planting-contribution", "monitoring-early", "monitoring-official"]);
const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const MAX_BYTES = 10 * 1024 * 1024;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const COLLECTION = "evidenceUploadIntents";
const hash = value => createHash("sha256").update(value).digest("hex");
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !value.includes("..");
const intentIdValid = value => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

class EvidenceStorageError extends Error {
  constructor(code) {
    super(`Private evidence operation failed (${code}).`);
    this.code = code;
  }
}
const failure = code => new EvidenceStorageError(code);
function onlyKeys(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every(key => keys.includes(key));
}
function guard() {
  const config = resolveEvidenceStorageConfig();
  if (!config.storageEmulator && !((config.gcsDevelopment || config.gcsProduction) && config.cloudWorkflow)) throw failure("EMULATOR_REQUIRED");
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure("STORAGE_TIMEOUT")), 20_000);
  })]); } finally { clearTimeout(timer); }
}

// Injected clients are for isolated fault tests only; identity and project guards still apply.
function createFirebaseEvidenceStorage({ db, getBucket, clock, log = event => console.info("[evidence-upload]", event) } = {}) {
  guard();
  const firebase = (!db || !getBucket) ? require("../config/firebase") : null;
  db ||= firebase.db;
  getBucket ||= firebase.getStorageBucket;
  const initial = resolveEvidenceStorageConfig();
  const expectedProject = initial.gcsProduction?.projectId || "demo-menro-phase2";
  if (db.projectId !== expectedProject) throw failure("EMULATOR_REQUIRED");
  const intents = db.collection(COLLECTION);
  const contexts = new WeakSet();
  const quota = createEvidenceUploadQuota({ db, clock });
  const quotaActors = new WeakMap();

  async function bucket() {
    guard();
    let result;
    try { result = await getBucket(); } catch { throw failure("STORAGE_UNAVAILABLE"); }
    guard(); // Configuration may have been revoked during keyless authentication.
    const config = resolveEvidenceStorageConfig();
    if (result.name !== config.bucket) throw failure("EMULATOR_REQUIRED");
    if (result.storage && String(result.storage.apiEndpoint).replace(/\/$/, "") !==
        ((config.gcsDevelopment || config.gcsProduction) ? 'https://storage.googleapis.com' : "http://127.0.0.1:9199")) {
      throw failure("EMULATOR_REQUIRED");
    }
    return result;
  }
  function emit(intent, category, state) {
    try { log({ operation: "private_evidence_upload", intentId: intent.id,
      evidenceType: intent.evidenceType, category, state }); } catch { /* Logging cannot undo a durable result. */ }
  }
  // Call ONLY after existing authentication and record authorization on the server.
  // This capability is not an authentication replacement; JSON cannot forge it.
  function serverContext(input) {
    guard();
    if (!onlyKeys(input, ["actor", "evidenceType", "recordId", "verification"]) ||
        !onlyKeys(input.actor, ["uid", "guestParticipantId", "migrationScope"]) || Object.keys(input.actor).length !== 1 ||
        !identifier(input.actor.uid ?? input.actor.guestParticipantId ?? input.actor.migrationScope) || !identifier(input.recordId)) {
      throw failure("INVALID_UPLOAD_CONTEXT");
    }
    if (!TYPES.has(input.evidenceType)) throw failure("UNSUPPORTED_EVIDENCE_TYPE");
    let verification;
    try {
      // Server-validated capture/GPS findings stay private in Firestore, never object logs.
      const json = JSON.stringify(input.verification ?? {});
      if (Buffer.byteLength(json) > 16_384) throw new Error();
      verification = JSON.parse(json);
      if (!onlyKeys(verification, ["capturedAt", "captureTimestamp", "captureOffset", "latitude", "longitude",
        "gpsValid", "timestampValid", "siteGpsValid", "suspiciousFlags", "captureDateManila", "captureTimezoneSource"])) throw new Error();
      for (const key of ["latitude", "longitude"]) {
        if (key in verification && (!Number.isFinite(verification[key]) ||
          Math.abs(verification[key]) > (key === "latitude" ? 90 : 180))) throw new Error();
      }
    } catch { throw failure("INVALID_FILE_METADATA"); }
    const actor = quota.serverActor(input.actor);
    const value = Object.freeze({ intentId: randomUUID(), actorId: input.actor.uid ?? input.actor.guestParticipantId ?? input.actor.migrationScope,
      actorKind: actor.kind, evidenceType: input.evidenceType,
      recordId: input.recordId, verificationJson: JSON.stringify(Object.fromEntries(
        Object.keys(verification).sort().map(key => [key, verification[key]]))) });
    contexts.add(value);
    quotaActors.set(value, actor);
    return value;
  }
  function trusted(context) {
    guard();
    if (!contexts.has(context)) throw failure("INVALID_UPLOAD_CONTEXT");
  }
  async function image(input) {
    if (!onlyKeys(input, ["buffer", "contentType", "sha256"]) || !Buffer.isBuffer(input.buffer) ||
        !input.buffer.length || input.buffer.length > MAX_BYTES) throw failure("INVALID_FILE_METADATA");
    // Snapshot before awaiting: caller mutation cannot change bytes after hashing.
    const bytes = Buffer.from(input.buffer);
    let details;
    try { details = await validateImageBuffer(bytes); } catch { throw failure("INVALID_FILE_METADATA"); }
    const contentType = MIME[details.format];
    if (!contentType || input.contentType !== contentType) throw failure("INVALID_FILE_METADATA");
    const sha256 = generateImageHash(bytes);
    if (input.sha256 !== undefined && input.sha256 !== sha256) throw failure("CHECKSUM_MISMATCH");
    return { bytes, sha256, contentType, format: details.format, sizeBytes: bytes.length };
  }
  function matches(intent, context, file) {
    if (intent.actorId !== context.actorId || intent.recordId !== context.recordId ||
        (intent.actorKind || "user") !== context.actorKind ||
        intent.evidenceType !== context.evidenceType || intent.verificationJson !== context.verificationJson ||
        (file && (intent.sha256 !== file.sha256 || intent.sizeBytes !== file.sizeBytes ||
          intent.contentType !== file.contentType))) throw failure("INTENT_CONFLICT");
    const config = resolveEvidenceStorageConfig(), expected = `evidence/v1/${context.evidenceType}/${context.recordId}/${intent.id}`;
    if (!matchesEvidenceObject(config, intent.objectName, expected) || intent.bucket !== config.bucket) {
      throw failure("INTENT_CONFLICT");
    }
  }
  function refFor(id) {
    if (!intentIdValid(id)) throw failure("INVALID_UPLOAD_CONTEXT");
    return intents.doc(id);
  }
  async function transaction(fn) {
    guard();
    try { return await db.runTransaction(fn, { maxAttempts: 3 }); }
    catch (error) {
      if (error instanceof EvidenceStorageError) throw error;
      if (error instanceof EvidenceQuotaError) throw failure(error.code);
      throw failure("FIRESTORE_UNAVAILABLE");
    }
  }
  async function reserve(context, input, operationIntentId = context?.intentId) {
    trusted(context);
    const file = await image(input);
    // Optional ID is a trusted server-ledger handle, NEVER a browser idempotency key.
    const id = operationIntentId;
    refFor(id);
    const now = Timestamp.now();
    const intent = { id, actorId: context.actorId, actorKind: context.actorKind, evidenceType: context.evidenceType,
      recordId: context.recordId, verificationJson: context.verificationJson,
      bucket: (await bucket()).name, objectName: evidenceObjectName(resolveEvidenceStorageConfig(), `evidence/v1/${context.evidenceType}/${context.recordId}/${id}`),
      sha256: file.sha256, sizeBytes: file.sizeBytes, contentType: file.contentType, format: file.format,
      status: "RESERVED", attemptCount: 0, generation: null, createdAt: now, updatedAt: now,
      reconciliationRequired: false, lastFailure: null };
    await transaction(async tx => {
      const ref = refFor(id), existing = await tx.get(ref);
      if (existing.exists) {
        matches(existing.data(), context, file);
        if (existing.data().quotaVersion !== 1) throw failure("LEGACY_INTENT_REQUIRES_RECONCILIATION");
      }
      const actor = quotaActors.get(context), day = existing.data()?.quotaDay || quota.today();
      await quota.reserveInTransaction(tx, actor, { intentId: id, day, fileCount: 1, byteCount: file.sizeBytes });
      if (!existing.exists) tx.create(ref, { ...intent, quotaVersion: 1, quotaActorKey: actor.key, quotaDay: day });
    });
    emit(intent, "RESERVED", intent.status);
    return { intentId: id }; // Internal handle; not an API response.
  }
  function metadataFor(intent) {
    return { schemaVersion: "1", uploadIntentId: intent.id,
      actorScope: hash(["guest", "migration"].includes(intent.actorKind) ? `${intent.actorKind}:${intent.actorId}` : intent.actorId),
      evidenceType: intent.evidenceType, recordScope: hash(intent.recordId), sha256: intent.sha256 };
  }
  async function inspect(intent) {
    const selectedBucket = await bucket(), object = selectedBucket.file(intent.objectName);
    let metadata;
    try { [metadata] = await bounded(object.getMetadata()); }
    catch (error) { if (Number(error.code) === 404) return null; throw error; }
    if (!metadata.generation || String(metadata.size) !== String(intent.sizeBytes) ||
        metadata.contentType !== intent.contentType || metadata.cacheControl !== "private, no-store" ||
        Object.entries(metadataFor(intent)).some(([key, value]) => metadata.metadata?.[key] !== value) ||
        metadata.metadata?.firebaseStorageDownloadTokens ||
        metadata.acl?.some(acl => ["allUsers", "allAuthenticatedUsers"].includes(acl.entity))) {
      throw failure("OBJECT_METADATA_MISMATCH");
    }
    if (intent.generation && String(metadata.generation) !== String(intent.generation)) throw failure("OBJECT_COLLISION");
    const generation = String(metadata.generation);
    if (typeof metadata.generation !== "string" || !/^[1-9]\d{0,19}$/.test(generation) || BigInt(generation) > 18446744073709551615n) throw failure("OBJECT_METADATA_MISMATCH");
    let stream;
    if (BigInt(generation) > BigInt(Number.MAX_SAFE_INTEGER)) {
      // File({generation}) coerces to Number in SDK 8.4.0. Preserve uint64 strings.
      const sdk = object.requestStream({ method: "GET", uri: "", qs: { alt: "media", generation },
        maxRetries: 0, timeout: 20_000, headers: { "Accept-Encoding": "identity" } });
      stream = new PassThrough();
      sdk.on("error", error => stream.destroy(error));
      sdk.on("response", response => {
        if (response.statusCode !== 200 || String(response.headers["x-goog-generation"]) !== generation) stream.destroy(failure("OBJECT_COLLISION"));
      });
      sdk.pipe(stream); stream.once("close", () => sdk.destroy());
    } else stream = selectedBucket.file(intent.objectName, { generation }).createReadStream();
    const digest = createHash("sha256");
    let size = 0;
    const timer = setTimeout(() => stream.destroy(failure("STORAGE_TIMEOUT")), 20_000);
    try {
      for await (const bytes of stream) {
        size += bytes.length;
        if (size > intent.sizeBytes || size > MAX_BYTES) throw failure("CHECKSUM_MISMATCH");
        digest.update(bytes);
      }
      if (size !== intent.sizeBytes || digest.digest("hex") !== intent.sha256) throw failure("CHECKSUM_MISMATCH");
    } finally { clearTimeout(timer); stream.destroy(); }
    return { provider: "firebase", storageVersion: 1, bucket: intent.bucket, objectName: intent.objectName,
      generation: String(metadata.generation), contentType: intent.contentType, format: intent.format,
      sizeBytes: intent.sizeBytes, sha256: intent.sha256, uploadIntentId: intent.id,
      uploadedAt: metadata.timeCreated || null };
  }
  async function upload(context, id, input) {
    trusted(context);
    const file = await image(input);
    const ref = refFor(id), leaseOwner = randomUUID();
    const intent = await transaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw failure("INTENT_NOT_FOUND");
      const current = doc.data(); matches(current, context, file);
      if (current.quotaVersion !== 1 || current.quotaActorKey !== quotaActors.get(context).key) {
        throw failure("LEGACY_INTENT_REQUIRES_RECONCILIATION");
      }
      if (current.id !== id || !["RESERVED", "UPLOADING", "UPLOADED", "FAILED", "RECONCILIATION_REQUIRED", "LINKED"].includes(current.status)) {
        throw failure("INTENT_CONFLICT");
      }
      if (current.status === "LINKED" || current.retainedAsRevision) throw failure("EVIDENCE_PROTECTED");
      if (current.quotaDay !== quota.today() && current.attemptCount === 0 && !current.generation) {
        throw failure("QUOTA_RESERVATION_DAY_CLOSED");
      }
      if (current.leaseUntil?.toMillis() > Date.now()) throw failure("UPLOAD_IN_PROGRESS");
      await quota.beginInTransaction(tx, quotaActors.get(context), id, leaseOwner);
      const next = { ...current, status: "UPLOADING", leaseOwner,
        leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS),
        attemptCount: current.attemptCount + (!current.generation && current.attemptCount < MAX_ATTEMPTS ? 1 : 0), updatedAt: Timestamp.now() };
      tx.update(ref, next); return { ...next, mayWrite: current.attemptCount < MAX_ATTEMPTS };
    });
    let reference;
    try {
      reference = await inspect(intent);
      if (!reference) {
        if (intent.generation) throw failure("OBJECT_MISSING");
        // Old-day recovery may inspect/finalize an existing object, never create a new one.
        if (intent.quotaDay !== quota.today()) throw failure("QUOTA_RESERVATION_DAY_CLOSED");
        if (!intent.mayWrite) throw failure("RECONCILIATION_REQUIRED");
        let saveError;
        try {
          // NEVER inside a transaction. Safe on retries: no live generation may exist.
          const object = (await bucket()).file(intent.objectName);
          // SDK CRC failure must not silently delete evidence or defeat recovery.
          Object.defineProperty(object, 'delete', { value: async () => { throw failure('AUTOMATIC_DELETE_FORBIDDEN'); },
            writable: false, configurable: false });
          await bounded(object.save(file.bytes, {
            resumable: false, timeout: 15_000, validation: "crc32c",
            preconditionOpts: { ifGenerationMatch: 0 },
            metadata: { contentType: intent.contentType, cacheControl: "private, no-store",
              metadata: metadataFor(intent) },
          }));
        } catch (error) { saveError = error; }
        // Always reconcile the exact path, including timeout/412/response-loss outcomes.
        reference = await inspect(intent);
        if (!reference) {
          if (saveError?.code === "STORAGE_TIMEOUT" || saveError?.code === "ETIMEDOUT") throw failure("STORAGE_TIMEOUT");
          if (Number(saveError?.code) === 412) throw failure("OBJECT_COLLISION");
          throw failure("STORAGE_UNAVAILABLE");
        }
      }
      try {
        await transaction(async tx => {
          const doc = await tx.get(ref), current = doc.data();
          matches(current, context, file);
          if (current.leaseOwner !== leaseOwner || current.status !== "UPLOADING") throw failure("INTENT_CONFLICT");
          await quota.finalizeInTransaction(tx, quotaActors.get(context), id, reference);
          tx.update(ref, { status: "UPLOADED", reference, generation: reference.generation,
            uploadedAt: current.uploadedAt || Timestamp.now(), updatedAt: Timestamp.now(),
            leaseOwner: null, leaseUntil: null, reconciliationRequired: false, lastFailure: null });
        });
      } catch (error) {
        // A commit acknowledgement can be lost. Do not undo a committed success.
        const latest = await ref.get();
        if (latest.data()?.status !== "UPLOADED" || latest.data()?.generation !== reference.generation) throw error;
      }
      emit(intent, "UPLOADED", "UPLOADED");
      return reference;
    } catch (error) {
      const category = ["OBJECT_METADATA_MISMATCH", "OBJECT_COLLISION", "CHECKSUM_MISMATCH", "OBJECT_MISSING",
        "STORAGE_TIMEOUT", "FIRESTORE_UNAVAILABLE", "INTENT_CONFLICT", "STORAGE_UNAVAILABLE", "RECONCILIATION_REQUIRED",
        "QUOTA_RESERVATION_DAY_CLOSED"].includes(error.code)
        ? error.code : "UNCERTAIN_UPLOAD_OUTCOME";
      try {
        await transaction(async tx => {
          const doc = await tx.get(ref), current = doc.data();
          if (current?.leaseOwner === leaseOwner && current.status === "UPLOADING") {
            await quota.uncertainInTransaction(tx, quotaActors.get(context), id, leaseOwner);
            tx.update(ref, { status: "RECONCILIATION_REQUIRED", reconciliationRequired: true,
              lastFailure: category, updatedAt: Timestamp.now(), leaseOwner: null, leaseUntil: null });
          }
        });
      } catch { /* Durable UPLOADING intent remains recoverable after lease expiry. */ }
      emit(intent, category, "RECONCILIATION_REQUIRED");
      throw failure(category);
    }
  }
  async function reconciliationReport(context, ids) {
    trusted(context);
    if (!Array.isArray(ids) || ids.length > 100) throw failure("INVALID_UPLOAD_CONTEXT");
    const rows = [];
    for (const id of ids) {
      const ref = refFor(id);
      let doc;
      try { doc = await ref.get(); } catch { throw failure("FIRESTORE_UNAVAILABLE"); }
      if (!doc.exists) { rows.push({ intentId: id, classification: "INTENT_NOT_FOUND", cleanupAllowed: false }); continue; }
      const intent = doc.data(); matches(intent, context);
      let classification;
      if (intent.status === "LINKED" || intent.retainedAsRevision) classification = "PROTECTED";
      else if (intent.leaseUntil?.toMillis() > Date.now()) classification = "IN_PROGRESS";
      else {
        try { classification = await inspect(intent) ? "UNLINKED_CANDIDATE_REQUIRES_REFERENCE_AUDIT" : "INCOMPLETE_NO_OBJECT"; }
        catch { classification = "RECONCILIATION_REQUIRED"; }
      }
      rows.push({ intentId: id, status: intent.status, classification, cleanupAllowed: false });
      emit(intent, "DRY_RUN", classification);
    }
    return rows; // No state mutation or deletion. LINKED requires future real business transactions.
  }
  return { serverContext, reserve, upload, reconciliationReport,
    async releaseUnused(context, id) {
      trusted(context);
      try {
        const doc = await refFor(id).get();
        if (!doc.exists) throw failure("INTENT_NOT_FOUND");
        matches(doc.data(), context);
        return await quota.releaseUnused(quotaActors.get(context), id);
      } catch (error) {
        if (error instanceof EvidenceStorageError) throw error;
        if (error instanceof EvidenceQuotaError) throw failure(error.code);
        throw failure("FIRESTORE_UNAVAILABLE");
      }
    },
    quotaReconciliationReport(context, ids) { trusted(context); return quota.reconciliationReport(quotaActors.get(context), ids); },
    // Private operational reporting only. Never serialize these directly through a public API.
    quotaUsageReport: (...args) => quota.dailyUsageReport(...args),
    quotaUsageSummary: (...args) => quota.dailyUsageSummary(...args) };
}

module.exports = { createFirebaseEvidenceStorage };
