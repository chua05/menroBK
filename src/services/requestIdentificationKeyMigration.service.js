const crypto = require("node:crypto");
const { FieldPath } = require("firebase-admin/firestore");
const {
  IDENTIFICATION_COLLECTION,
  decryptIdNumber,
  encryptIdNumber,
  resolveEncryptionKeyring,
} = require("./requestIdentification.service");

const LEDGER_COLLECTION = "requestIdentificationKeyMigrations";
const ENVELOPE_FIELDS = [
  "encryptionVersion", "algorithm", "keyId", "ciphertext", "iv", "authTag",
];
const MIGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function migrationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function envelope(record) {
  return Object.fromEntries(ENVELOPE_FIELDS
    .filter((field) => record[field] !== undefined)
    .map((field) => [field, record[field]]));
}

function replaceEnvelope(record, replacement) {
  const result = { ...record };
  for (const field of ENVELOPE_FIELDS) delete result[field];
  return { ...result, ...replacement };
}

function digestEnvelope(value) {
  const ordered = ENVELOPE_FIELDS.map((field) => [field, value[field] ?? null]);
  return crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function ledgerId(migrationId, requestId) {
  return crypto.createHash("sha256").update(`${migrationId}\0${requestId}`).digest("hex");
}

function safeCode(error) {
  return /^[A-Z0-9_]+$/.test(error?.code || "")
    ? error.code
    : "IDENTIFICATION_MIGRATION_FAILED";
}

function createRequestIdentificationKeyMigration({ db, env = process.env, clock = () => new Date() }) {
  if (!db || typeof db.collection !== "function" || typeof db.runTransaction !== "function") {
    throw migrationError("IDENTIFICATION_MIGRATION_DATABASE_REQUIRED");
  }

  const keyring = resolveEncryptionKeyring(env);

  async function listPage(limit, cursor) {
    let query = db.collection(IDENTIFICATION_COLLECTION)
      .orderBy(FieldPath.documentId())
      .limit(limit);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    return snapshot.docs;
  }

  function inspectRecord(record) {
    decryptIdNumber(record, env);
    return record.keyId === keyring.active.id ? "ACTIVE" : "NEEDS_MIGRATION";
  }

  async function migrateOne(requestId, migrationId) {
    const recordRef = db.collection(IDENTIFICATION_COLLECTION).doc(requestId);
    const ledgerRef = db.collection(LEDGER_COLLECTION).doc(ledgerId(migrationId, requestId));
    return db.runTransaction(async (tx) => {
      const [recordDoc, ledgerDoc] = await Promise.all([tx.get(recordRef), tx.get(ledgerRef)]);
      if (!recordDoc.exists) return "MISSING";
      const current = recordDoc.data();
      const priorLedger = ledgerDoc.exists ? ledgerDoc.data() : null;
      const state = inspectRecord(current);
      if (state === "ACTIVE") {
        if (priorLedger?.status === "MIGRATED" &&
            priorLedger.afterDigest !== digestEnvelope(envelope(current))) return "CONFLICT";
        return priorLedger?.status === "MIGRATED" ? "ALREADY_MIGRATED" : "ALREADY_ACTIVE";
      }

      const plaintext = decryptIdNumber(current, env);
      const before = envelope(current);
      const after = encryptIdNumber(plaintext, env, current.requestId || requestId);
      const migrated = replaceEnvelope(current, after);
      const now = clock();
      tx.set(recordRef, { ...migrated, updatedAt: now,
        encryptionMigration: { id: migrationId, migratedAt: now, fromKeyId: current.keyId || null,
          toKeyId: keyring.active.id } });
      tx.set(ledgerRef, {
        schemaVersion: 1,
        migrationId,
        requestId,
        status: "MIGRATED",
        before,
        beforeDigest: digestEnvelope(before),
        afterDigest: digestEnvelope(after),
        activeKeyId: keyring.active.id,
        attempts: Number(priorLedger?.attempts || 0) + 1,
        createdAt: priorLedger?.createdAt || now,
        updatedAt: now,
      });
      return "MIGRATED";
    });
  }

  async function rollbackOne(requestId, migrationId) {
    const recordRef = db.collection(IDENTIFICATION_COLLECTION).doc(requestId);
    const ledgerRef = db.collection(LEDGER_COLLECTION).doc(ledgerId(migrationId, requestId));
    return db.runTransaction(async (tx) => {
      const [recordDoc, ledgerDoc] = await Promise.all([tx.get(recordRef), tx.get(ledgerRef)]);
      if (!recordDoc.exists || !ledgerDoc.exists) return "MISSING";
      const current = recordDoc.data();
      const saved = ledgerDoc.data();
      if (saved.status === "ROLLED_BACK") return "ALREADY_ROLLED_BACK";
      if (saved.status !== "MIGRATED" || saved.migrationId !== migrationId ||
          saved.afterDigest !== digestEnvelope(envelope(current)) ||
          saved.beforeDigest !== digestEnvelope(saved.before)) return "CONFLICT";
      decryptIdNumber({ ...saved.before, requestId: current.requestId || requestId }, env);
      const now = clock();
      const restored = replaceEnvelope(current, saved.before);
      delete restored.encryptionMigration;
      tx.set(recordRef, { ...restored, updatedAt: now });
      tx.set(ledgerRef, { ...saved, status: "ROLLED_BACK", rolledBackAt: now, updatedAt: now });
      return "ROLLED_BACK";
    });
  }

  async function reconcileOne(doc, migrationId) {
    const state = inspectRecord(doc.data());
    if (state !== "ACTIVE") return state;
    const ledgerDoc = await db.collection(LEDGER_COLLECTION)
      .doc(ledgerId(migrationId, doc.id)).get();
    if (!ledgerDoc.exists) return "ACTIVE_WITHOUT_LEDGER";
    const saved = ledgerDoc.data();
    if (saved.status === "MIGRATED" &&
        saved.afterDigest === digestEnvelope(envelope(doc.data())) &&
        saved.activeKeyId === keyring.active.id) return "VERIFIED";
    return "CONFLICT";
  }

  async function run({ mode = "dry-run", migrationId, limit = 50, cursor = "" }) {
    if (!MIGRATION_ID_PATTERN.test(migrationId || "")) throw migrationError("INVALID_IDENTIFICATION_MIGRATION_ID");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw migrationError("INVALID_IDENTIFICATION_MIGRATION_LIMIT");
    if (!['dry-run', 'execute', 'reconcile', 'rollback'].includes(mode)) throw migrationError("INVALID_IDENTIFICATION_MIGRATION_MODE");
    const docs = await listPage(limit, cursor);
    const counts = {};
    for (const doc of docs) {
      let status;
      try {
        if (mode === "execute") status = await migrateOne(doc.id, migrationId);
        else if (mode === "rollback") status = await rollbackOne(doc.id, migrationId);
        else if (mode === "reconcile") status = await reconcileOne(doc, migrationId);
        else status = inspectRecord(doc.data());
      } catch (error) {
        status = safeCode(error);
      }
      counts[status] = (counts[status] || 0) + 1;
    }
    return Object.freeze({
      mode,
      migrationId,
      processed: docs.length,
      counts: Object.freeze(counts),
      nextCursor: docs.length === limit ? docs.at(-1).id : null,
      complete: docs.length < limit,
      activeKeyId: keyring.active.id,
    });
  }

  return Object.freeze({ run });
}

module.exports = {
  LEDGER_COLLECTION,
  createRequestIdentificationKeyMigration,
  digestEnvelope,
  envelope,
  replaceEnvelope,
};
