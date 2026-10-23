// Private demo-only migration ledger. Never registered as an HTTP API.
const { randomUUID } = require('node:crypto');
const { canonical, sha } = require('../utils/historicalEvidenceClassification.util');
const COLLECTION = 'historicalEvidenceMigrations';
function createMigrationLedger({ db, guard, now = Date.now }) {
  const records = db.collection(COLLECTION);
  async function reserve(plan) {
    guard();
    if (!/^[a-f0-9]{64}$/.test(plan.id) || Buffer.byteLength(canonical(plan)) > 262144) throw Error('INVALID_MIGRATION_PLAN');
    const ref = records.doc(plan.id), token = randomUUID(), fingerprint = sha(canonical(plan));
    const row = await db.runTransaction(async tx => {
      const doc = await tx.get(ref), saved = doc.data();
      if (saved) {
        if (saved.fingerprint !== fingerprint || saved.schemaVersion !== 1) throw Error('MIGRATION_CONFLICT');
        if (!['RESERVED', 'UPLOADING', 'UPLOADED', 'RECONCILIATION_REQUIRED', 'LINKED', 'VERIFIED'].includes(saved.status) ||
            !Number.isInteger(saved.attempts) || saved.attempts < 0 || !Number.isFinite(saved.leaseUntil) || !Array.isArray(saved.audit)) throw Error('MIGRATION_LEDGER_INVALID');
        if (['LINKED', 'VERIFIED'].includes(saved.status)) return saved;
        if (saved.leaseUntil > now()) throw Error('MIGRATION_IN_PROGRESS');
        if (saved.attempts >= 3) throw Error('MIGRATION_RECONCILIATION_REQUIRED');
        const next = { ...saved, status: 'RESERVED', token, leaseUntil: now() + 180000, attempts: saved.attempts + 1, updatedAt: now() };
        tx.set(ref, next); return next;
      }
      const next = { schemaVersion: 1, plan, fingerprint, namespace: plan.namespace, intentId: randomUUID(),
        status: 'RESERVED', token, leaseUntil: now() + 180000, attempts: 1, createdAt: now(), updatedAt: now(),
        retentionPolicy: 'retain-no-ttl-v1', audit: [{ action: 'RESERVED', at: now() }] };
      tx.create(ref, next); return next;
    }, { maxAttempts: 5 });
    return { ref, row, token };
  }
  function fence(saved, operation) {
    if (!saved || saved.token !== operation.token || saved.leaseUntil <= now() || ['LINKED', 'VERIFIED'].includes(saved.status)) throw Error('MIGRATION_STALE_LEASE');
  }
  async function transition(operation, status, extra = {}) {
    guard();
    await db.runTransaction(async tx => {
      const saved = (await tx.get(operation.ref)).data(); fence(saved, operation);
      tx.update(operation.ref, { ...extra, status, updatedAt: now(),
        audit: [...saved.audit, { action: status, at: now() }] });
    }, { maxAttempts: 5 });
  }
  async function fail(operation, admissionPaused = false) {
    try { guard(); await db.runTransaction(async tx => {
      const saved = (await tx.get(operation.ref)).data();
      if (saved?.token === operation.token && !['LINKED', 'VERIFIED'].includes(saved.status)) tx.update(operation.ref,
        { status: 'RECONCILIATION_REQUIRED', leaseUntil: 0, attempts: saved.attempts - (admissionPaused ? 1 : 0),
          updatedAt: now(), audit: [...saved.audit, { action: admissionPaused ? 'QUOTA_PAUSED' : 'RECONCILIATION_REQUIRED', at: now() }] });
    }); } catch { /* Retain durable lease and handles; no deletion or success claim. */ }
  }
  return { reserve, fence, transition, fail, records, now };
}
module.exports = { createMigrationLedger, COLLECTION };
