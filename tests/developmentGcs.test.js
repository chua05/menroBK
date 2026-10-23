const test = require('node:test'), assert = require('node:assert/strict');
const { resolveEvidenceStorageConfig: resolve } = require('../src/config/evidenceStorage');
const { DEVELOPMENT_TARGET: target, matchesEvidenceObject, isDevelopmentLoopback } = require('../src/config/developmentGcs');
const { createDevelopmentGcsAccess } = require('../src/services/developmentGcs.service');
const { developmentEnv, withDevelopment } = require('./helpers/developmentGcsFixture');
test('development target is explicit, inactive by default and separate from acceptance/production', () => {
  assert.equal(resolve({}).provider, 'local'); assert.equal(resolve({}).gcsDevelopment, undefined);
  assert.notEqual(target.bucket, 'menro-gcs-acceptance-20261021-6f8c2d91');
  const config = resolve(developmentEnv());
  assert.equal(config.gcsDevelopment.bucket, target.bucket); assert.equal(config.storageEmulator, false);
  assert.equal(config.cloudRead, true); assert.equal(config.cloudWorkflow, true);
});
for (const [name, changes] of [
  ['production', { NODE_ENV: 'production' }], ['missing environment', { NODE_ENV: undefined }],
  ['missing integration gate', { MENRO_INTEGRATION_TEST: undefined }],
  ['production Firestore', { FIREBASE_PROJECT_ID: 'menrosystem-ddfac' }],
  ['production GCLOUD alias', { GCLOUD_PROJECT: 'menrosystem-ddfac' }],
  ['production GOOGLE alias', { GOOGLE_CLOUD_PROJECT: 'menrosystem-ddfac' }],
  ['remote Firestore', { FIRESTORE_EMULATOR_HOST: 'example.invalid:8080' }],
  ['missing Auth emulator', { FIREBASE_AUTH_EMULATOR_HOST: undefined }],
  ['Storage emulator mixed in', { FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' }],
  ['Storage alias mixed in', { STORAGE_EMULATOR_HOST: 'https://storage.googleapis.com' }],
  ['Firebase Storage selector', { FIREBASE_STORAGE_BUCKET: target.bucket }],
  ['service-account key', { GOOGLE_APPLICATION_CREDENTIALS: 'serviceAccountKey.json' }],
  ['Firebase key', { FIREBASE_PRIVATE_KEY: 'synthetic-never-real' }],
  ['Firebase identity', { FIREBASE_CLIENT_EMAIL: target.serviceAccountEmail }],
  ['Firebase SDK discovery', { FIREBASE_CONFIG: '{}' }], ['debug logs', { DEBUG: '*' }],
  ['quota override', { GOOGLE_CLOUD_QUOTA_PROJECT: 'other-project' }],
  ['migration', { MENRO_HISTORICAL_MIGRATION: 'true' }],
  ['missing approval', { EVIDENCE_GCS_DEVELOPMENT_APPROVAL: undefined }],
  ['acceptance bucket', { EVIDENCE_GCS_BUCKET: 'menro-gcs-acceptance-20261021-6f8c2d91' }],
  ['production bucket', { EVIDENCE_GCS_BUCKET: 'menrosystem-ddfac.firebasestorage.app' }],
  ['old production bucket', { EVIDENCE_GCS_BUCKET: 'menrosystem-ddfac.appspot.com' }],
  ['wrong project', { EVIDENCE_GCS_PROJECT_ID: 'other-project' }],
  ['acceptance identity', { EVIDENCE_GCS_SERVICE_ACCOUNT: 'menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com' }],
  ['namespace traversal', { EVIDENCE_GCS_NAMESPACE: '../menro-acceptance' }],
  ['implicit ADC', { EVIDENCE_GCS_ADC_FILE: undefined }], ['key path', { EVIDENCE_GCS_ADC_FILE: 'serviceAccountKey.json' }],
  ['provider mismatch', { EVIDENCE_STORAGE_PROVIDER: 'firebase' }],
]) test(`development GCS rejects ${name}`, () => {
  assert.throws(() => resolve({ ...developmentEnv(), ...changes }));
});
test('rollback keeps authorized GCS reads while new uploads return to local', () => {
  const config = resolve({ ...developmentEnv(), EVIDENCE_STORAGE_PROVIDER: 'local', EVIDENCE_CLOUD_WORKFLOW_ENABLED: 'false' });
  assert.equal(config.provider, 'local'); assert.equal(config.cloudWorkflow, undefined); assert.equal(config.cloudRead, true);
  const suffix = 'evidence/v1/monitoring-official/record/00000000-0000-4000-8000-000000000002';
  assert.ok(matchesEvidenceObject(config, `menro-development/00000000-0000-4000-8000-000000000099/${suffix}`, suffix));
  for (const name of [`menro-acceptance/00000000-0000-4000-8000-000000000099/${suffix}`, suffix,
    `menro-development/../${suffix}`, `menro-development/00000000-0000-4000-8000-000000000099/${suffix}/other`]) {
    assert.equal(matchesEvidenceObject(config, name, suffix), false);
  }
});
test('unused target selectors and unguarded gcs provider do not activate anything', () => {
  assert.throws(() => resolve({ EVIDENCE_STORAGE_PROVIDER: 'gcs' }));
  assert.throws(() => resolve({ EVIDENCE_GCS_BUCKET: target.bucket }));
});
function accessHarness({ metadata, failure } = {}) {
  const env = developmentEnv(), stats = { reads: 0, auth: 0, clients: 0, metadata: 0 }; let time = 10000;
  const bucket = { name: target.bucket, async getMetadata() { stats.metadata++; return [metadata || {
    name: target.bucket, location: 'ASIA-SOUTHEAST1', storageClass: 'STANDARD',
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' } }]; } };
  const service = createDevelopmentGcsAccess({ env: () => env, now: () => time,
    readAdc(file) { assert.equal(file, env.EVIDENCE_GCS_ADC_FILE); stats.reads++; return { type: 'synthetic-ADC' }; },
    async authenticate(adc, selected) { assert.equal(adc.type, 'synthetic-ADC'); assert.equal(selected.serviceAccountEmail, target.serviceAccountEmail);
      stats.auth++; if (failure) throw Error('private SDK credentials diagnostic'); return { credentials: { expiry_date: time + 300000 } }; },
    storageFactory(selected, client) { stats.clients++; assert.equal(selected.projectId, target.projectId);
      assert.equal(client.credentials.refresh_token, undefined); return { bucket(name) { assert.equal(name, target.bucket); return bucket; } }; } });
  return { ...service, stats, env, bucket, advance() { time += 250000; } };
}
test('keyless transport is lazy, coalesces initialization and refreshes only a verified expiring client', async () => {
  const h = accessHarness(); assert.deepEqual(h.stats, { reads: 0, auth: 0, clients: 0, metadata: 0 });
  assert.deepEqual(await Promise.all([h.getBucket(), h.getBucket()]), [h.bucket, h.bucket]);
  assert.equal(h.stats.auth, 1); await h.getBucket(); assert.equal(h.stats.auth, 1);
  h.advance(); await h.getBucket(); assert.equal(h.stats.auth, 2);
});
test('concurrent authentication failures are sanitized for every caller', async () => {
  const h = accessHarness({ failure: true }); const results = await Promise.allSettled([h.getBucket(), h.getBucket()]);
  for (const r of results) { assert.equal(r.status, 'rejected'); assert.equal(r.reason.message, 'DEVELOPMENT_GCS_UNAVAILABLE'); }
  assert.equal(h.stats.clients, 0);
});
test('unsafe bucket privacy fails before exposing a client', async () => {
  const h = accessHarness({ metadata: { name: target.bucket, location: 'US', storageClass: 'STANDARD' } });
  await assert.rejects(h.getBucket(), /DEVELOPMENT_GCS_UNAVAILABLE/);
});
test('cached cloud client cannot bypass disabled read capability', async () => {
  const h = accessHarness(); await h.getBucket(); h.env.EVIDENCE_CLOUD_WORKFLOW_ENABLED = 'false'; h.env.EVIDENCE_CLOUD_READ_ENABLED = 'false';
  await assert.rejects(h.getBucket()); assert.equal(h.stats.auth, 1);
});
test('loopback protection ignores spoofed forwarded headers', () => {
  for (const remoteAddress of ['127.0.0.1','::1','::ffff:127.0.0.1']) assert.equal(isDevelopmentLoopback({ socket: { remoteAddress } }), true);
  assert.equal(isDevelopmentLoopback({ socket: { remoteAddress: '203.0.113.2' }, headers: { 'x-forwarded-for': '127.0.0.1' } }), false);
  assert.equal(isDevelopmentLoopback({}), false);
});
test('development retrieval preserves private bytes after write disablement and namespace change', async () => withDevelopment(async () => {
  const { fixture, sink } = require('./helpers/evidenceRetrievalFixture');
  const f = await fixture({ format: 'png' });
  f.reference.bucket = target.bucket; f.bucket.name = target.bucket; f.bucket.storage.apiEndpoint = 'https://storage.googleapis.com';
  f.reference.objectName = `menro-development/${process.env.EVIDENCE_GCS_NAMESPACE}/${f.reference.objectName}`;
  f.reference.generation = '18446744073709551614';
  Object.assign(f.metadata, { bucket: f.reference.bucket, name: f.reference.objectName, generation: f.reference.generation });
  const token = f.token();
  process.env.EVIDENCE_STORAGE_PROVIDER = 'local'; process.env.EVIDENCE_CLOUD_WORKFLOW_ENABLED = 'false';
  process.env.EVIDENCE_GCS_NAMESPACE = '00000000-0000-4000-8000-000000000099';
  const output = sink(); await f.streamTo(token, output.output); assert.deepEqual(output.data(), f.buffer);
  assert.ok(f.stats.calls.every(c => c.options.qs.generation === '18446744073709551614'));
  assert.equal(output.headers['Cache-Control'], 'private, no-store');
  f.reference.bucket = 'menro-gcs-acceptance-20261021-6f8c2d91'; assert.throws(() => f.token(), { code: 'INVALID_EVIDENCE_REFERENCE' });
}));

function workflowHarness() {
  const { Readable } = require('node:stream');
  const { memoryFirestore } = require('./helpers/evidenceQuotaMemory');
  const { createFirebaseEvidenceStorage } = require('../src/services/firebaseEvidenceStorage.service');
  const { createEvidenceWorkflow } = require('../src/services/evidenceWorkflow.service');
  const memory = memoryFirestore(), objects = new Map(), faults = {}; let saves = 0, deletes = 0;
  const bucket = { name: target.bucket, storage: { apiEndpoint: 'https://storage.googleapis.com' }, file(name) {
    return { async delete() { deletes++; throw Error('Must never call SDK deletion'); },
      async save(buffer, options) {
        assert.equal(memory.inTransaction(), false); assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
        assert.equal(Object.getOwnPropertyDescriptor(this, 'delete').writable, false);
        await assert.rejects(this.delete(), { code: 'AUTOMATIC_DELETE_FORBIDDEN' });
        saves++;
        if (faults.save) throw Object.assign(Error('private Storage error'), { code: 503 });
        if (objects.has(name)) throw Object.assign(Error('collision'), { code: 412 });
        objects.set(name, { buffer: Buffer.from(buffer), metadata: { ...options.metadata, name, bucket: target.bucket,
          generation: '1800000000000001', size: String(buffer.length), timeCreated: '2026-10-22T00:00:00Z' } });
      }, async getMetadata() {
        if (!objects.has(name)) throw Object.assign(Error('missing'), { code: 404 });
        return [objects.get(name).metadata];
      }, createReadStream() { return Readable.from([objects.get(name).buffer]); } };
  } };
  const storage = createFirebaseEvidenceStorage({ db: memory.db, getBucket: async () => bucket, log() {} });
  const workflow = createEvidenceWorkflow({ db: memory.db, storage });
  return { ...memory, storage, workflow, objects, faults, saves: () => saves, deletes: () => deletes };
}
for (const [workflowName, type] of [
  ['planting-report','planting-report'], ['planting-contribution','planting-contribution'],
  ['monitoring-early','monitoring-early'], ['monitoring-official','monitoring-official'],
  ['monitoring-resubmit','monitoring-official'],
]) test(`development GCS reuses transactional ${workflowName} linkage and idempotency`, async () => withDevelopment(async () => {
  const h = workflowHarness(), sharp = require('sharp');
  const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'green' } }).png().toBuffer();
  const options = { actor: workflowName === 'planting-contribution' ? { guestParticipantId: 'synthetic-guest' } : { uid: 'synthetic-user' },
    workflow: workflowName, target: 'synthetic-cohort', payload: { totalMonitored: 25 }, files: [{ buffer }], key: 'same-operation-key' };
  const perform = async operation => {
    const reference = await h.workflow.upload(operation, 0, { buffer }, { recordId: operation.targetId, evidenceType: type });
    await h.db.runTransaction(async tx => {
      const complete = await h.workflow.prepareLink(tx, operation);
      tx.create(h.db.collection('syntheticBusiness').doc(operation.targetId), { privateEvidence: reference });
      complete({ recordId: operation.targetId });
    });
    return { id: operation.targetId };
  };
  const resolveResult = link => ({ id: link.recordId });
  const first = await h.workflow.run(options, perform, resolveResult);
  assert.deepEqual(await h.workflow.run(options, perform, resolveResult), first);
  assert.equal(h.objects.size, 1); assert.equal(h.saves(), 1); assert.equal(h.deletes(), 0);
  assert.equal(h.records('evidenceWorkflowOperations').size, 1);
  const intent = [...h.records('evidenceUploadIntents').values()][0];
  assert.equal(intent.status, 'LINKED'); assert.ok(intent.objectName.startsWith('menro-development/'));
  assert.equal(intent.reference.provider, 'firebase'); assert.equal(intent.reference.bucket, target.bucket);
  assert.equal([...h.records('evidenceQuotaDays').values()][0].finalizedFiles, 1);
}));
test('development upload failure never reports local success or creates business linkage', async () => withDevelopment(async () => {
  const h = workflowHarness(), buffer = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: 'green' } }).png().toBuffer();
  h.faults.save = true;
  const context = h.storage.serverContext({ actor: { uid: 'synthetic-user' }, recordId: 'record', evidenceType: 'planting-report' });
  const image = { buffer, contentType: 'image/png' }, { intentId } = await h.storage.reserve(context, image);
  await assert.rejects(h.storage.upload(context, intentId, image), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(h.objects.size, 0); assert.equal(h.records('syntheticBusiness').size, 0);
  assert.equal(h.records('evidenceUploadIntents').get(intentId).status, 'RECONCILIATION_REQUIRED');
  h.faults.save = false;
  const first = await h.storage.upload(context, intentId, image);
  assert.deepEqual(await h.storage.upload(context, intentId, image), first);
  assert.equal(h.objects.size, 1); assert.equal(h.deletes(), 0);
}));

test('real-GCS development requires an explicit retry key before any reservation or upload', async () => withDevelopment(async () => {
  const h = workflowHarness();
  await assert.rejects(h.workflow.run({ actor: { uid: 'synthetic-user' }, workflow: 'planting-report',
    payload: {}, files: [] }, () => assert.fail('must not mutate'), () => {}), { code: 'INVALID_IDEMPOTENCY_KEY', status: 400 });
  assert.equal(h.records('evidenceWorkflowOperations').size, 0);
  assert.equal(h.objects.size, 0);
}));

test('real-cloud development retains all existing rate limits instead of the emulator skip', async () => withDevelopment(async () => {
  const Module = require('node:module'), filename = require.resolve('../src/middleware/rateLimiter.middleware');
  const original = Module._load, previous = require.cache[filename], options = [];
  delete require.cache[filename];
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === filename && request === 'express-rate-limit') return {
      rateLimit(config) { options.push(config); return () => {}; }, ipKeyGenerator: ip => ip };
    return original.call(this, request, parent, isMain);
  };
  try {
    require(filename); assert.equal(options.length, 6);
    for (const config of options) assert.equal(config.skip({ method: 'POST' }), false);
    assert.equal(options[1].skip({ method: 'OPTIONS' }), true);
    process.env.MENRO_GCS_DEVELOPMENT = 'false';
    for (const key of Object.keys(process.env).filter(key => key.startsWith('EVIDENCE_GCS_'))) delete process.env[key];
    process.env.EVIDENCE_STORAGE_PROVIDER = 'firebase';
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
    process.env.FIREBASE_STORAGE_BUCKET = 'demo-menro-phase2.firebasestorage.app';
    for (const config of options) assert.equal(config.skip({ method: 'POST' }), true);
  } finally { Module._load = original; delete require.cache[filename]; if (previous) require.cache[filename] = previous; }
}));
test('development entrypoint binds localhost even with the real-cloud configuration present', async () => withDevelopment(async () => {
  const Module = require('node:module'), filename = require.resolve('../src/server');
  const original = Module._load, previous = require.cache[filename]; let args;
  delete require.cache[filename];
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === filename) {
      if (request === 'dotenv') return { config() {} };
      if (request === './services/requestIdentification.service') return { validateIdentificationEncryptionConfig() {} };
      if (request === './app') return { listen(...input) { args = input; } };
    }
    return original.call(this, request, parent, isMain);
  };
  try { require(filename); assert.equal(args[1], '127.0.0.1'); }
  finally { Module._load = original; delete require.cache[filename]; if (previous) require.cache[filename] = previous; }
}));
