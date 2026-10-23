const test = require('node:test'), assert = require('node:assert/strict');
const { runAcceptance, validateTarget, generation, APPROVED_TARGETS, PROPOSED_SAME_PROJECT_TARGET } = require('../src/services/nonproductionStorageAcceptance.service');
const config = { projectId: 'synthetic-acceptance', bucket: 'synthetic-acceptance-bucket',
  serviceAccountEmail: 'test-actor@synthetic-acceptance.iam.gserviceaccount.com', prefix: 'menro-acceptance/00000000-0000-4000-8000-000000000000/' };
const env = { NODE_ENV: 'test', MENRO_GCS_ACCEPTANCE_ENV: 'nonproduction', MENRO_GCS_ACCEPTANCE_EXECUTE: 'AUTHORIZED_NONPRODUCTION_SYNTHETIC_ONLY' };
const credentials = { type: 'service_account', project_id: config.projectId, client_email: config.serviceAccountEmail,
  private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic-not-a-real-key', token_uri: 'https://oauth2.googleapis.com/token' };
const allowlist = [config];
function fixture() {
  let saved, writes = 0, reads = 0, visibility = 403;
  const transport = {
    async bucketMetadata() { return { name: config.bucket, location: 'ASIA-SOUTHEAST1', storageClass: 'STANDARD',
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' } }; },
    async missingStatus(name) { assert.equal(name, config.prefix + 'missing.png'); return 404; },
    async save(name, bytes, opts) {
      assert.equal(opts.preconditionOpts.ifGenerationMatch, 0); assert.equal(opts.resumable, false);
      writes++; if (saved) throw Object.assign(Error('exists'), { code: 412 });
      saved = { bytes: Buffer.from(bytes), metadata: { name, bucket: config.bucket, generation: '18446744073709551615',
        size: String(bytes.length), ...opts.metadata } };
    },
    async metadata() { return saved.metadata; },
    async read(name, g) { reads++; assert.equal(g, '18446744073709551615'); return saved.bytes; },
    async anonymousStatus() { return visibility; },
  };
  const options = { config, env, credentials, allowlist, execute: true, transportFactory: () => transport };
  return { transport, options, saved: () => saved, writes: () => writes, reads: () => reads, public: () => { visibility = 200; } };
}
test('CLI default preparation has no credentials or client/network initialization', async () => {
  assert.deepEqual(await require('../scripts/acceptNonproductionEvidenceStorage').main([]),
    { mode: 'prepare', networkRequests: 0, executionBlocked: 'EXECUTION_AUTHORIZATION_REQUIRED', cleanupAllowed: false });
});
test('CLI allowlist rejects every unapproved real target', () => {
  assert.throws(() => validateTarget(config, env), /TARGET_APPROVAL_REQUIRED/);
});
test('preparation never constructs transport or reads credentials', async () => {
  const r = await runAcceptance({ config, env, allowlist, transportFactory() { throw Error('network forbidden'); } });
  assert.equal(r.networkRequests, 0);
});
test('create-only, different-byte rejection, exact uint64, private verification and no deletion', async () => {
  const f = fixture(), r = await runAcceptance(f.options);
  assert.equal(r.generation, '18446744073709551615'); assert.equal(r.createOnly, true);
  assert.equal(r.cleanupAllowed, false); assert.equal(r.realServiceVerified, false);
  assert.equal(f.writes(), 2); assert.equal(f.reads(), 2); assert.equal(f.transport.delete, undefined);
});
test('same prefix retry recovers identical bytes without replacement', async () => {
  const f = fixture(); await runAcceptance(f.options); const original = Buffer.from(f.saved().bytes);
  const r = await runAcceptance(f.options); assert.equal(r.resumed, true); assert.deepEqual(f.saved().bytes, original);
});
test('interrupted first response stays uncertain and next invocation verifies same object', async () => {
  const f = fixture(), save = f.transport.save;
  let first = true;
  f.transport.save = async (...args) => { await save(...args); if (first) { first = false; throw Error('interrupted'); } };
  await assert.rejects(runAcceptance(f.options), /UPLOAD_UNCERTAIN/);
  assert.ok(f.saved()); assert.equal((await runAcceptance(f.options)).resumed, true);
});
for (const [name, mutate, code] of [
  ['checksum', f => { f.transport.read = async () => Buffer.from('wrong'); }, 'CHECKSUM_MISMATCH'],
  ['public object', f => f.public(), 'ANONYMOUS_DENIAL'],
  ['anonymous ambiguous 404', f => { f.transport.anonymousStatus = async () => 404; }, 'ANONYMOUS_DENIAL'],
  ['unsafe bucket', f => { f.transport.bucketMetadata = async () => ({ name: config.bucket, location: 'ASIA-SOUTHEAST1', storageClass: 'STANDARD' }); }, 'BUCKET_PRIVACY'],
  ['generation rounding', f => { f.transport.metadata = async () => ({ ...f.saved().metadata, generation: 18446744073709551615 }); }, 'INVALID_GENERATION'],
  ['public token', f => { const save = f.transport.save; f.transport.save = async (...args) => { await save(...args); f.saved().metadata.metadata.firebaseStorageDownloadTokens = 'synthetic'; }; }, 'OBJECT_METADATA_UNSAFE'],
]) test(`rejects ${name}`, async () => { const f = fixture(); mutate(f); await assert.rejects(runAcceptance(f.options), new RegExp(code)); });
for (const [name, override] of [
  ['wrong project', { config: { ...config, projectId: 'menrosystem-ddfac' } }],
  ['wrong bucket', { config: { ...config, bucket: 'menrosystem-ddfac.firebasestorage.app' } }],
  ['bad prefix', { config: { ...config, prefix: 'evidence/real/' } }],
  ['missing execution flag', { env: { ...env, MENRO_GCS_ACCEPTANCE_EXECUTE: undefined } }],
  ['production mode', { env: { ...env, NODE_ENV: 'production' } }],
  ['ambient ADC', { env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: '/not-read' } }],
  ['emulator', { env: { ...env, STORAGE_EMULATOR_HOST: 'localhost:9199' } }],
  ['missing credentials', { credentials: undefined }],
  ['production identity', { credentials: { ...credentials, project_id: 'menrosystem-ddfac' } }],
  ['token endpoint substitution', { credentials: { ...credentials, token_uri: 'https://evil.invalid/token' } }],
]) test(`no transport constructed: ${name}`, async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(runAcceptance({ ...f.options, ...override, transportFactory: () => { calls++; throw Error('forbidden'); } }));
  assert.equal(calls, 0);
});
test('unsafe generation formats rejected', () => {
  for (const g of ['0', '-1', '01', '1e5', '18446744073709551616', 1, null]) assert.throws(() => generation(g));
});
test('default imports and preparation cannot initialize SDK, ADC or HTTP', async () => {
  const Module = require('node:module'), http = require('node:http'), https = require('node:https');
  const load = Module._load, h = http.request, s = https.request;
  Module._load = function(id, ...args) {
    assert.ok(!id.startsWith('firebase-admin') && !id.startsWith('@google-cloud') && !id.includes('config/firebase'));
    return load.call(this, id, ...args);
  };
  http.request = https.request = () => { throw Error('Network forbidden'); };
  try { assert.equal((await require('../scripts/acceptNonproductionEvidenceStorage').main([])).networkRequests, 0); }
  finally { Module._load = load; http.request = h; https.request = s; }
});
test('overwrite acceptance is a failure, never a service pass', async () => {
  const f = fixture(), save = f.transport.save; let first = true;
  f.transport.save = async (...args) => { if (first) { first = false; return save(...args); } };
  await assert.rejects(runAcceptance(f.options), /CREATE_ONLY_NOT_ENFORCED/);
});
test('generation changes after rejected overwrite are detected', async () => {
  const f = fixture(), metadata = f.transport.metadata; let reads = 0;
  f.transport.metadata = async () => ({ ...await metadata(), ...(reads++ ? { generation: '1' } : {}) });
  await assert.rejects(runAcceptance(f.options), /GENERATION_CHANGED/);
});
test('authenticated read denial cannot pass integrity', async () => {
  const f = fixture(); f.transport.read = async () => { throw Object.assign(Error('synthetic forbidden'), { code: 403 }); };
  await assert.rejects(runAcceptance(f.options)); assert.equal(f.writes(), 1);
});

const proposed = { ...PROPOSED_SAME_PROJECT_TARGET, prefix: config.prefix };
const sameProjectEnv = { ...env, MENRO_GCS_ACCEPTANCE_ENV: 'same-project-test-bucket' };
test('Phase 8C pins exactly one immutable preparation target', () => {
  assert.equal(APPROVED_TARGETS.length, 1); assert.equal(Object.isFrozen(APPROVED_TARGETS), true);
  assert.equal(Object.isFrozen(PROPOSED_SAME_PROJECT_TARGET), true);
  assert.deepEqual(APPROVED_TARGETS, [PROPOSED_SAME_PROJECT_TARGET]);
  assert.deepEqual(validateTarget(proposed, sameProjectEnv), proposed);
});
test('exact same-project tuple passes only an injected offline approval policy', () => {
  assert.deepEqual(validateTarget(proposed, sameProjectEnv, [PROPOSED_SAME_PROJECT_TARGET]), proposed);
});
test('same-project production, wildcard and other buckets fail even with a permissive injected policy', async () => {
  for (const bucket of ['menrosystem-ddfac.firebasestorage.app', 'menrosystem-ddfac.appspot.com',
    'another-private-test-bucket', proposed.bucket + '-other', '*', '', `gs://${proposed.bucket}`]) {
    const wrong = { ...proposed, bucket }; let calls = 0;
    await assert.rejects(runAcceptance({ config: wrong, env: sameProjectEnv, execute: true,
      allowlist: [wrong], transportFactory() { calls++; throw Error('Network forbidden'); } }));
    assert.equal(calls, 0);
  }
});
test('same-project wrong and production-style identities fail before transport even if allowlisted', async () => {
  for (const serviceAccountEmail of ['firebase-adminsdk-test@menrosystem-ddfac.iam.gserviceaccount.com',
    'other-test-actor@menrosystem-ddfac.iam.gserviceaccount.com', 'menro-gcs-acceptance@other-project.iam.gserviceaccount.com', '']) {
    const wrong = { ...proposed, serviceAccountEmail }; let calls = 0;
    await assert.rejects(runAcceptance({ config: wrong, env: sameProjectEnv, execute: true,
      allowlist: [wrong], transportFactory() { calls++; throw Error('Network forbidden'); } }));
    assert.equal(calls, 0);
  }
});
test('same-project target requires its independent environment marker and execution authorization', async () => {
  for (const unsafeEnv of [env, { ...sameProjectEnv, MENRO_GCS_ACCEPTANCE_EXECUTE: undefined },
    { ...sameProjectEnv, NODE_ENV: 'production' }, { ...sameProjectEnv, EVIDENCE_CLOUD_READ_ENABLED: 'true' },
    { ...sameProjectEnv, FIREBASE_STORAGE_BUCKET: 'menrosystem-ddfac.firebasestorage.app' }]) {
    let calls = 0;
    await assert.rejects(runAcceptance({ config: proposed, env: unsafeEnv, allowlist: [proposed], execute: true,
      transportFactory() { calls++; throw Error('Network forbidden'); } }));
    assert.equal(calls, 0);
  }
});
test('same-project credentials cannot substitute a different service-account identity', async () => {
  let calls = 0;
  await assert.rejects(runAcceptance({ config: proposed, env: sameProjectEnv, allowlist: [proposed], execute: true,
    credentials: { ...credentials, project_id: proposed.projectId, client_email: 'other-test-actor@menrosystem-ddfac.iam.gserviceaccount.com' },
    transportFactory() { calls++; throw Error('Network forbidden'); } }), /INVALID_CREDENTIALS/);
  assert.equal(calls, 0);
});
test('same-project prepare mode has zero network even with a fake approval', async () => {
  const result = await runAcceptance({ config: proposed, env: sameProjectEnv, allowlist: [proposed],
    transportFactory() { throw Error('Network forbidden'); } });
  assert.equal(result.networkRequests, 0); assert.equal(result.realServiceVerified, false);
});

test('approved default policy prepares without SDK, credentials or Firestore initialization', async () => {
  const Module = require('node:module'), load = Module._load;
  Module._load = function(id, ...args) {
    assert.ok(!id.startsWith('firebase-admin') && !id.startsWith('@google-cloud') && !id.includes('config/firebase'));
    return load.call(this, id, ...args);
  };
  try {
    const result = await runAcceptance({ config: proposed, env: sameProjectEnv,
      transportFactory() { throw Error('Network forbidden'); } });
    assert.equal(result.networkRequests, 0);
  } finally { Module._load = load; }
});

test('approved default policy still requires independent live execution authorization', async () => {
  await assert.rejects(runAcceptance({ config: proposed, execute: true,
    env: { ...sameProjectEnv, MENRO_GCS_ACCEPTANCE_EXECUTE: undefined },
    transportFactory() { throw Error('Network forbidden'); } }), /EXECUTION_AUTHORIZATION_REQUIRED/);
});

test('missing bucket metadata permission stops before any object write', async () => {
  const f = fixture();
  f.transport.bucketMetadata = async () => { throw Object.assign(Error('synthetic forbidden'), { code: 403 }); };
  await assert.rejects(runAcceptance(f.options), { code: 'BUCKET_METADATA_PERMISSION_DENIED' });
  assert.equal(f.writes(), 0); assert.equal(f.reads(), 0);
});

test('missing object is not recreated or replaced after verification fails', async () => {
  const f = fixture();
  f.transport.metadata = async () => { throw Object.assign(Error('synthetic missing'), { code: 404 }); };
  await assert.rejects(runAcceptance(f.options), { code: 404 });
  assert.equal(f.writes(), 1); assert.equal(f.reads(), 0);
});

test('keyless selection uses verified auth client without forwarding ADC or source credentials to Storage', async () => {
  const f = fixture(), client = { synthetic: true }; let verified = false;
  const { credentials: unused, ...options } = f.options;
  const result = await runAcceptance({ ...options, adc: { synthetic: true },
    authFactory: async (adc, target) => { assert.equal(adc.synthetic, true); assert.equal(target.bucket, config.bucket); verified = true; return client; },
    transportFactory(target, identity) { assert.equal(verified, true); assert.deepEqual(identity, { authClient: client }); return f.transport; } });
  assert.equal(result.missingObject, true);
});

test('ADC is not read or authenticated in preparation and cannot be combined with key credentials', async () => {
  const f = fixture(); let calls = 0;
  const options = { ...f.options, adc: {}, authFactory() { calls++; throw Error('forbidden'); } };
  assert.equal((await runAcceptance({ ...options, execute: false })).networkRequests, 0);
  await assert.rejects(runAcceptance(options), /AMBIGUOUS_AUTHENTICATION/);
  assert.equal(calls, 0); assert.equal(f.writes(), 0);
});

test('unverified keyless identity stops before constructing a Storage transport', async () => {
  const f = fixture(); const { credentials: unused, ...options } = f.options; let calls = 0;
  await assert.rejects(runAcceptance({ ...options, adc: {},
    authFactory() { throw Error('EFFECTIVE_IDENTITY_MISMATCH'); },
    transportFactory() { calls++; } }), /EFFECTIVE_IDENTITY_MISMATCH/);
  assert.equal(calls, 0);
});

for (const status of [200, 401, 403, 500, NaN]) test(`missing-object probe cannot accept ${status}`, async () => {
  const f = fixture(); f.transport.missingStatus = async () => status;
  await assert.rejects(runAcceptance(f.options), /MISSING_OBJECT_NOT_VERIFIED/);
  assert.equal(f.writes(), 0);
});

for (const [status, code] of [[401, 'AUTH_CREDENTIALS_INVALID'], [404, 'BUCKET_NOT_FOUND'], [500, 'BUCKET_INSPECTION_UNAVAILABLE']]) {
  test(`bucket inspection distinguishes ${status}`, async () => {
    const f = fixture(); f.transport.bucketMetadata = async () => { throw { code: status }; };
    await assert.rejects(runAcceptance(f.options), { code }); assert.equal(f.writes(), 0);
  });
}

test('CLI error reporting emits only known safe categories, never provider diagnostics', () => {
  const { safeFailure } = require('../scripts/acceptNonproductionEvidenceStorage');
  assert.equal(safeFailure({ code: 'ADC_INVALID', message: 'sensitive' }).error, 'ADC_INVALID');
  assert.equal(safeFailure(Error('sensitive-token-or-path')).error, 'ACCEPTANCE_BLOCKED_OR_FAILED');
});
test('acceptance upload blocks implicit SDK deletion without disabling CRC validation', async () => {
  const { saveWithoutAutomaticCleanup } = require('../src/services/nonproductionStorageAcceptance.service');
  let deletes = 0;
  const file = { async delete() { deletes++; }, async save(bytes, opts) {
    assert.equal(opts.validation, 'crc32c'); assert.equal(opts.preconditionOpts.ifGenerationMatch, 0);
    await this.delete();
  } };
  await assert.rejects(saveWithoutAutomaticCleanup(file, Buffer.from('synthetic'),
    { validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 } }), /ACCEPTANCE_AUTOMATIC_DELETE_FORBIDDEN/);
  assert.equal(deletes, 0); assert.equal(Object.getOwnPropertyDescriptor(file, 'delete').writable, false);
});

test('CLI keyless mode preserves credential-read ordering and requires explicit execution authorization', async () => {
  const fs = require('node:fs'), auth = require('../src/services/nonproductionStorageAcceptanceAuth.service');
  const stat = fs.statSync, read = fs.readFileSync, authenticate = auth.createKeylessAuth;
  const savedEnv = process.env;
  const reads = []; const input = { type: 'authorized_user', client_id: 'synthetic' };
  fs.statSync = () => ({ size: 100 });
  fs.readFileSync = path => { reads.push(path); return JSON.stringify(path === 'synthetic-config' ? proposed : input); };
  auth.createKeylessAuth = async adc => { assert.deepEqual(adc, input); throw Object.assign(Error('synthetic stop'), { code: 'ADC_INVALID' }); };
  process.env = { ...sameProjectEnv }; // This test owns a clean environment, never inherited ADC/demo selectors.
  try {
    const { main } = require('../scripts/acceptNonproductionEvidenceStorage');
    const args = ['--config', 'synthetic-config', '--execute-authorized', '--adc-file', 'synthetic-adc'];
    delete process.env.MENRO_GCS_ACCEPTANCE_EXECUTE;
    await assert.rejects(main(args), /EXECUTION_AUTHORIZATION_REQUIRED/);
    assert.deepEqual(reads, ['synthetic-config']); reads.length = 0;
    process.env.MENRO_GCS_ACCEPTANCE_EXECUTE = sameProjectEnv.MENRO_GCS_ACCEPTANCE_EXECUTE;
    await assert.rejects(main(args), { code: 'ADC_INVALID' });
    assert.deepEqual(reads, ['synthetic-config', 'synthetic-adc']);
  } finally {
    fs.statSync = stat; fs.readFileSync = read; auth.createKeylessAuth = authenticate;
    process.env = savedEnv;
  }
});
