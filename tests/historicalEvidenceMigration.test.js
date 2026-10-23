const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { memoryFirestore } = require('./helpers/evidenceQuotaMemory');
const { createEvidenceUploadQuota } = require('../src/services/evidenceUploadQuota.service');
const { createMigrationLedger } = require('../src/services/historicalEvidenceMigrationLedger.service');
const { sha } = require('../src/utils/historicalEvidenceClassification.util');
const { select, link } = require('../src/services/historicalEvidenceMigration.service');
const savedEnv = { ...process.env };
test.before(() => Object.assign(process.env, { NODE_ENV: 'test', MENRO_INTEGRATION_TEST: 'true', MENRO_HISTORICAL_MIGRATION: 'true',
  GCLOUD_PROJECT: 'demo-menro-phase2', FIREBASE_PROJECT_ID: 'demo-menro-phase2', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
  FIREBASE_STORAGE_BUCKET: 'demo-menro-phase2.firebasestorage.app', EVIDENCE_STORAGE_PROVIDER: 'local' }));
test.after(() => { for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv); });
test('fixed migration identity is separate from users/guests and rejects run-specific scopes', () => {
  const quota = createEvidenceUploadQuota({ db: memoryFirestore().db });
  const actor = quota.serverActor({ migrationScope: 'historical-evidence-v1' });
  assert.equal(actor.kind, 'migration');
  assert.notEqual(actor.key, quota.serverActor({ uid: 'historical-evidence-v1' }).key);
  assert.notEqual(actor.key, quota.serverActor({ guestParticipantId: 'historical-evidence-v1' }).key);
  assert.throws(() => quota.serverActor({ migrationScope: randomUUID() }));
  delete process.env.MENRO_HISTORICAL_MIGRATION;
  assert.throws(() => quota.serverActor({ migrationScope: 'historical-evidence-v1' }));
  process.env.MENRO_HISTORICAL_MIGRATION = 'true';
});
test('shared 50-file limit spans concurrent service instances and cannot be raised with user quota config', async () => {
  const m = memoryFirestore(), env = { EVIDENCE_DAILY_FILE_LIMIT: '1000', EVIDENCE_DAILY_BYTE_LIMIT: '999999999' };
  const services = [createEvidenceUploadQuota({ db: m.db, env }), createEvidenceUploadQuota({ db: m.db, env })];
  const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => {
    const q = services[i % 2]; return q.reserve(q.serverActor({ migrationScope: 'historical-evidence-v1' }),
      { intentId: randomUUID(), day: q.today(), fileCount: 1, byteCount: 1 });
  }));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 50);
  assert.equal(m.records('evidenceQuotaDays').size, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'EVIDENCE_DAILY_QUOTA_EXCEEDED'));
});
test('shared 200 MiB boundary, duplicate reservations, successful finalization counted once', async () => {
  const m = memoryFirestore(), q = createEvidenceUploadQuota({ db: m.db }), actor = q.serverActor({ migrationScope: 'historical-evidence-v1' });
  const id = randomUUID(), request = { intentId: id, day: q.today(), fileCount: 1, byteCount: 10485760 };
  await q.reserve(actor, request); await q.reserve(actor, request);
  await m.db.runTransaction(tx => q.finalizeInTransaction(tx, actor, id, { uploadIntentId: id, generation: '18446744073709551615', sizeBytes: 10485760 }));
  await m.db.runTransaction(tx => q.finalizeInTransaction(tx, actor, id, { uploadIntentId: id, generation: '18446744073709551615', sizeBytes: 10485760 }));
  for (let i = 0; i < 19; i++) await q.reserve(actor, { ...request, intentId: randomUUID() });
  await assert.rejects(q.reserve(actor, { ...request, intentId: randomUUID(), byteCount: 1 }), { code: 'EVIDENCE_DAILY_QUOTA_EXCEEDED' });
  const counter = [...m.records('evidenceQuotaDays').values()][0]; assert.equal(counter.finalizedFiles, 1); assert.equal(counter.reservedFiles, 19);
});
test('ledger reservation is idempotent, concurrent owners fenced, immutable conflicts rejected', async () => {
  const m = memoryFirestore(); let now = 1000;
  const ledger = createMigrationLedger({ db: m.db, guard() {}, now: () => now });
  const plan = { id: sha('synthetic'), namespace: 'synthetic', source: 'one' };
  const first = await ledger.reserve(plan);
  await assert.rejects(ledger.reserve(plan), /IN_PROGRESS/);
  await assert.rejects(ledger.reserve({ ...plan, source: 'changed' }), /CONFLICT/);
  now += 180001; const second = await ledger.reserve(plan);
  assert.equal(first.row.intentId, second.row.intentId);
  await assert.rejects(ledger.transition(first, 'UPLOADED'), /STALE_LEASE/);
  await ledger.fail(second); assert.equal((await second.ref.get()).data().status, 'RECONCILIATION_REQUIRED');
});
test('exact observation/revision linkage preserves all unrelated fields and rejects duplicate IDs', () => {
  const data = { participantId: 'owner', history: [{ id: 'OBS', reviewStatus: 'Approved', count: 10,
    revisionHistory: [{ revisionNumber: 1, evidenceRef: { photoUrl: '/local', imageHash: 'hash' } }] }] };
  const target = { kind: 'revision', observationId: 'OBS', revisionNumber: 1 }, ref = { provider: 'firebase' };
  const updated = link(data, target, ref); assert.equal(updated.history[0].reviewStatus, 'Approved');
  assert.equal(updated.participantId, 'owner'); assert.equal(data.history[0].revisionHistory[0].evidenceRef.privateEvidence, undefined);
  assert.deepEqual(select(updated, target).privateEvidence, ref);
  assert.throws(() => select({ history: [data.history[0], data.history[0]] }, target), /OBSERVATION_CONFLICT/);
});
test('upload reconciliation preserves maximum uint64 generation without a File numeric conversion', async () => {
  const sharp = require('sharp');
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'green' } }).png().toBuffer();
  const generation = '18446744073709551615', m = memoryFirestore(); let object, query;
  const bucket = { name: 'demo-menro-phase2.firebasestorage.app', file(name, options) {
    assert.equal(options, undefined, 'large generations must not reach File({generation})');
    return { async save(buffer, opts) { object = { bytes: Buffer.from(buffer), metadata: { ...opts.metadata, generation, size: String(buffer.length) } }; },
      async getMetadata() { if (!object) throw Object.assign(Error('missing'), { code: 404 }); return [object.metadata]; },
      requestStream(options) { query = options.qs; const r = Readable.from([object.bytes]);
        queueMicrotask(() => r.emit('response', { statusCode: 200, headers: { 'x-goog-generation': generation } })); return r; } };
  } };
  const adapter = require('../src/services/firebaseEvidenceStorage.service').createFirebaseEvidenceStorage({ db: m.db, getBucket: () => bucket, log() {} });
  const context = adapter.serverContext({ actor: { migrationScope: 'historical-evidence-v1' }, recordId: 'synthetic', evidenceType: 'planting-report' });
  const image = { buffer: bytes, contentType: 'image/png' }, { intentId } = await adapter.reserve(context, image);
  const ref = await adapter.upload(context, intentId, image);
  assert.equal(ref.generation, generation); assert.equal(query.generation, generation); assert.equal(typeof query.generation, 'string');
  assert.deepEqual(object.bytes, bytes);
});
test('real Storage SDK transports maximum uint64 generation exactly (loopback HTTP stub, not GCS acceptance)', async t => {
  const http = require('node:http'), https = require('node:https'), sharp = require('sharp');
  const { Storage } = require('@google-cloud/storage');
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'green' } }).png().toBuffer();
  const generation = '18446744073709551615', requests = []; let metadata;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(req.method, 'GET'); requests.push(url.searchParams.get('generation'));
    if (url.searchParams.get('alt') === 'media') {
      assert.equal(url.searchParams.get('generation'), generation);
      res.setHeader('x-goog-generation', generation); res.setHeader('Content-Type', 'image/png'); res.end(bytes);
    } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(metadata)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  const originalHttp = http.request, originalHttps = https.request;
  http.request = function(input, ...args) {
    const url = typeof input === 'string' || input instanceof URL ? new URL(input) : null;
    assert.equal(url ? url.hostname : input.hostname || input.host, '127.0.0.1');
    assert.equal(String(url ? url.port : input.port), String(port)); return originalHttp.call(this, input, ...args);
  };
  https.request = () => { throw Error('External HTTPS blocked'); };
  t.after(async () => { http.request = originalHttp; https.request = originalHttps; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const sdk = new Storage({ projectId: 'demo-menro-phase2', apiEndpoint: `http://127.0.0.1:${port}`, useAuthWithCustomEndpoint: false });
  sdk.authClient.getCredentials = async () => { throw Error('ADC prohibited'); };
  const actual = sdk.bucket('demo-menro-phase2.firebasestorage.app');
  const bucket = { name: actual.name, file: actual.file.bind(actual) }; // Injected test transport, not a live service handle.
  const memory = memoryFirestore();
  const adapter = require('../src/services/firebaseEvidenceStorage.service').createFirebaseEvidenceStorage({ db: memory.db, getBucket: () => bucket, log() {} });
  const context = adapter.serverContext({ actor: { migrationScope: 'historical-evidence-v1' }, recordId: 'generation-wire', evidenceType: 'planting-report' });
  const input = { buffer: bytes, contentType: 'image/png' }, { intentId } = await adapter.reserve(context, input);
  const intent = memory.records('evidenceUploadIntents').get(intentId);
  metadata = { name: intent.objectName, bucket: bucket.name, generation, size: String(bytes.length), contentType: 'image/png', cacheControl: 'private, no-store',
    metadata: { schemaVersion: '1', uploadIntentId: intentId, actorScope: sha('migration:historical-evidence-v1'), recordScope: sha('generation-wire'), evidenceType: 'planting-report', sha256: sha(bytes) } };
  const ref = await adapter.upload(context, intentId, input);
  assert.equal(ref.generation, generation); assert.ok(requests.includes(generation));
});
