// Standalone READ source. No Admin initialization, dotenv, Storage, or business services.
const { COLLECTIONS, canonical, sha } = require('../utils/historicalEvidenceClassification.util');
function createMemorySource({ synthetic, collections, complete = false, verifiedCloud = [] }) {
  if (synthetic !== true || !collections || typeof collections !== 'object') throw Error('SYNTHETIC_SOURCE_REQUIRED');
  const serialized = JSON.stringify(collections);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024 || Object.keys(collections).some(k => !COLLECTIONS.includes(k))) throw Error('SOURCE_LIMIT');
  const snapshot = JSON.parse(serialized), digest = sha(canonical(snapshot));
  let total = 0;
  for (const c of COLLECTIONS) {
    const docs = snapshot[c] || {};
    if (Array.isArray(docs) || typeof docs !== 'object' || docs === null || Object.keys(docs).some(id => !/^[A-Za-z0-9_.-]{1,128}$/.test(id))) throw Error('INVALID_SOURCE');
    total += Object.keys(docs).length;
  }
  if (total > 10000 || !Array.isArray(verifiedCloud) || verifiedCloud.some(h => !/^[a-f0-9]{64}$/.test(h))) throw Error('SOURCE_LIMIT');
  return Object.freeze({ mode: 'synthetic-memory', projectId: null, identity: digest, complete: complete === true,
    verifiedCloud: Object.freeze([...verifiedCloud]), async readPage(collection, after, limit) {
      if (!COLLECTIONS.includes(collection)) throw Error('INVALID_COLLECTION');
      return Object.keys(snapshot[collection] || {}).sort().filter(id => !after || id > after).slice(0, limit)
        .map(id => ({ id, data: structuredClone(snapshot[collection][id]) }));
    }, async close() {} });
}
function emulatorGuard(env) {
  if (env.NODE_ENV !== 'test' || env.MENRO_INTEGRATION_TEST !== 'true' ||
      env.GCLOUD_PROJECT !== 'demo-menro-phase2' || env.FIREBASE_PROJECT_ID !== 'demo-menro-phase2' ||
      (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT !== 'demo-menro-phase2') ||
      env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' || env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099' ||
      ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_JSON']
        .some(k => env[k] !== undefined)) throw Error('SCANNER_EMULATOR_REQUIRED');
}
function createEmulatorSource({ env = process.env, namespace, complete = false } = {}) {
  emulatorGuard(env);
  if (!/^scan6b-[a-f0-9]{8}-[a-f0-9-]{27}-$/.test(namespace || '')) throw Error('SCANNER_NAMESPACE_REQUIRED');
  // Explicit host, project and inert credentials: no ADC or metadata discovery.
  const { Firestore, FieldPath } = require('@google-cloud/firestore');
  const db = new Firestore({ projectId: 'demo-menro-phase2', host: '127.0.0.1:8080', ssl: false,
    credentials: { client_email: 'scanner@example.invalid', private_key: 'unused-emulator-only' } });
  return Object.freeze({ mode: 'firestore-emulator', projectId: 'demo-menro-phase2',
    identity: sha(`demo-menro-phase2:127.0.0.1:8080:${namespace}`), complete: complete === true, verifiedCloud: [],
    async readPage(collection, after, limit) {
      emulatorGuard(env);
      if (!COLLECTIONS.includes(collection) || !Number.isInteger(limit) || limit < 1 || limit > 500 ||
          (after && !after.startsWith(namespace))) throw Error('INVALID_SOURCE_CURSOR');
      let query = db.collection(collection).orderBy(FieldPath.documentId()).where(FieldPath.documentId(), '>=', namespace)
        .where(FieldPath.documentId(), '<', `${namespace}\uf8ff`).limit(limit);
      if (after) query = query.startAfter(after);
      const result = await query.get();
      return result.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    }, async close() { await db.terminate(); } });
}
module.exports = { createMemorySource, createEmulatorSource, emulatorGuard };
