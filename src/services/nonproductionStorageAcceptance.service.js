// Standalone acceptance preparation. NEVER imported by application startup.
const { createHash } = require('node:crypto');
const { validateBucketMetadata } = require('./nonproductionStorageAcceptancePolicy.service');
const sha = b => createHash('sha256').update(b).digest('hex');
// Exact Phase 8C preparation approval, NOT live execution authorization.
// In the production-sensitive project, even an injected allowlist cannot select
// any other bucket/identity. Independent execution authorization remains required.
const PROPOSED_SAME_PROJECT_TARGET = Object.freeze({ projectId: 'menrosystem-ddfac',
  bucket: 'menro-gcs-acceptance-20261021-6f8c2d91',
  serviceAccountEmail: 'menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com' });
const APPROVED_TARGETS = Object.freeze([PROPOSED_SAME_PROJECT_TARGET]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQ63IV63JlgFAAGF4Dlc53ccoAAAAASUVORK5CYII=', 'base64');
const fail = code => { const e = new Error(code); e.code = code; throw e; };
function validateTarget(c, env, allowlist = APPROVED_TARGETS) {
  if (!c || Object.getPrototypeOf(c) !== Object.prototype ||
      Object.keys(c).some(k => !['projectId', 'bucket', 'serviceAccountEmail', 'prefix'].includes(k))) fail('INVALID_CONFIG');
  const sameProject = c.projectId === PROPOSED_SAME_PROJECT_TARGET.projectId;
  const exactSameProjectTarget = sameProject && c.bucket === PROPOSED_SAME_PROJECT_TARGET.bucket &&
    c.serviceAccountEmail === PROPOSED_SAME_PROJECT_TARGET.serviceAccountEmail;
  if (typeof c.projectId !== 'string' || !/^[a-z][a-z0-9-]{5,29}$/.test(c.projectId) ||
      c.projectId.includes('menrosystem-ddfac') && !exactSameProjectTarget || c.projectId.startsWith('demo-')) fail('PROJECT_NOT_ALLOWED');
  if (typeof c.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{2,220}[a-z0-9]$/.test(c.bucket) ||
      c.bucket.includes('menrosystem-ddfac') || c.bucket.includes('..')) fail('BUCKET_NOT_ALLOWED');
  if (typeof c.serviceAccountEmail !== 'string' ||
      !new RegExp(`^[a-z][a-z0-9-]{4,28}@${c.projectId}\\.iam\\.gserviceaccount\\.com$`).test(c.serviceAccountEmail)) fail('IDENTITY_NOT_ALLOWED');
  if (typeof c.prefix !== 'string' || !/^menro-acceptance\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/$/.test(c.prefix)) fail('INVALID_PREFIX');
  if (env.NODE_ENV !== 'test' || env.MENRO_GCS_ACCEPTANCE_ENV !== (sameProject ? 'same-project-test-bucket' : 'nonproduction') ||
      ['FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL',
        'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST',
        'STORAGE_EMULATOR_HOST', 'MENRO_INTEGRATION_TEST', 'EVIDENCE_CLOUD_WORKFLOW_ENABLED',
        'EVIDENCE_CLOUD_READ_ENABLED', 'MENRO_HISTORICAL_MIGRATION', 'FIREBASE_STORAGE_BUCKET', 'DEBUG'].some(k => env[k] !== undefined) ||
      ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_PROJECT_ID'].some(k => env[k] !== undefined && env[k] !== c.projectId) ||
      env.EVIDENCE_STORAGE_PROVIDER !== undefined && env.EVIDENCE_STORAGE_PROVIDER !== 'local') fail('UNSAFE_ENVIRONMENT');
  if (!allowlist.some(a => a.projectId === c.projectId && a.bucket === c.bucket && a.serviceAccountEmail === c.serviceAccountEmail)) fail('TARGET_APPROVAL_REQUIRED');
  return Object.freeze({ ...c });
}
function generation(g) {
  if (typeof g !== 'string' || !/^[1-9]\d{0,19}$/.test(g) || BigInt(g) > 18446744073709551615n) fail('INVALID_GENERATION');
  return g;
}
function validateCredentials(c, target) {
  if (!c || c.type !== 'service_account' || c.project_id !== target.projectId || c.client_email !== target.serviceAccountEmail ||
      typeof c.private_key !== 'string' || !c.private_key.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
      c.token_uri !== 'https://oauth2.googleapis.com/token' || c.universe_domain && c.universe_domain !== 'googleapis.com') fail('INVALID_CREDENTIALS');
  // Do not forward arbitrary credential endpoint or external-account options.
  return { type: 'service_account', project_id: c.project_id, client_email: c.client_email, private_key: c.private_key };
}
async function runAcceptance({ config, env = {}, execute = false, credentials, adc, authFactory, transportFactory,
  allowlist = APPROVED_TARGETS } = {}) {
  // Tests inject a local fake policy/transport; the CLI cannot override the pinned allowlist.
  const target = validateTarget(config, env, allowlist);
  if (!execute) return { mode: 'prepare', networkRequests: 0, cleanupAllowed: false, realServiceVerified: false };
  if (execute !== true || env.MENRO_GCS_ACCEPTANCE_EXECUTE !== 'AUTHORIZED_NONPRODUCTION_SYNTHETIC_ONLY') fail('EXECUTION_AUTHORIZATION_REQUIRED');
  if (adc !== undefined && credentials !== undefined) fail('AMBIGUOUS_AUTHENTICATION');
  const identity = adc !== undefined ? { authClient: await (authFactory || require('./nonproductionStorageAcceptanceAuth.service').createKeylessAuth)(adc, target) }
    : validateCredentials(credentials, target);
  const transport = transportFactory ? transportFactory(target, identity) : createSdkTransport(target, identity);
  const name = target.prefix + 'synthetic.png', expected = sha(PNG);
  const options = { resumable: false, validation: 'crc32c', timeout: 15000,
    preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: 'image/png', cacheControl: 'private, no-store',
      metadata: { acceptance: 'synthetic-v1', sha256: expected } } };
  // Require uniform access + enforced public prevention, then independently probe anonymously.
  let bucket;
  try { bucket = await transport.bucketMetadata(); }
  catch (e) {
    const status = Number(e?.response?.status || e?.code);
    fail(status === 403 ? 'BUCKET_METADATA_PERMISSION_DENIED' : status === 401 ? 'AUTH_CREDENTIALS_INVALID' :
      status === 404 ? 'BUCKET_NOT_FOUND' : 'BUCKET_INSPECTION_UNAVAILABLE');
  }
  validateBucketMetadata(bucket, target);
  // A fixed, never-written second name. Permission denial is NOT proof of absence.
  if (await transport.missingStatus(target.prefix + 'missing.png') !== 404) fail('MISSING_OBJECT_NOT_VERIFIED');
  let resumed = false;
  try { await transport.save(name, Buffer.from(PNG), options); }
  catch (e) { if (Number(e.code) !== 412) fail('UPLOAD_UNCERTAIN_RETRY_SAME_PREFIX'); resumed = true; }
  async function verify(expectedGeneration) {
    const m = await transport.metadata(name);
    const g = generation(m.generation);
    if (expectedGeneration && g !== expectedGeneration) fail('GENERATION_CHANGED');
    if (m.name !== name || m.bucket !== target.bucket || String(m.size) !== String(PNG.length) ||
        m.contentType !== 'image/png' || m.cacheControl !== 'private, no-store' || m.contentEncoding && m.contentEncoding !== 'identity' ||
        m.metadata?.acceptance !== 'synthetic-v1' || m.metadata?.sha256 !== expected ||
        Object.hasOwn(m.metadata || {}, 'firebaseStorageDownloadTokens') ||
        m.acl?.some(a => ['allUsers', 'allAuthenticatedUsers'].includes(a.entity))) fail('OBJECT_METADATA_UNSAFE');
    const bytes = await transport.read(name, g, PNG.length);
    if (!Buffer.isBuffer(bytes) || bytes.length !== PNG.length || sha(bytes) !== expected) fail('CHECKSUM_MISMATCH');
    return g;
  }
  const g = await verify();
  let rejected = false;
  try { await transport.save(name, Buffer.from('synthetic-overwrite-must-fail'), options); }
  catch (e) { if (Number(e.code) === 412) rejected = true; else fail('OVERWRITE_TEST_UNCERTAIN'); }
  if (!rejected) fail('CREATE_ONLY_NOT_ENFORCED');
  await verify(g);
  const status = await transport.anonymousStatus(name, g);
  if (![401, 403].includes(status)) fail('ANONYMOUS_DENIAL_NOT_VERIFIED');
  return { mode: 'acceptance', resumed, createOnly: true, integrity: true, anonymousDenied: true,
    generation: g, missingObject: true, cleanupAllowed: false, realServiceVerified: false,
    limitation: 'Transport assertions only; operator must attest real-service target, inherited IAM and execution provenance.' };
}
function saveWithoutAutomaticCleanup(file, bytes, options) {
  // Storage 8.4.0 attempts this.delete() on CRC mismatch. Cleanup is separately
  // authorized: keep validation enabled but prohibit that implicit DELETE locally.
  Object.defineProperty(file, 'delete', { value: async () => { fail('ACCEPTANCE_AUTOMATIC_DELETE_FORBIDDEN'); },
    writable: false, configurable: false });
  return file.save(bytes, options);
}
function createSdkTransport(target, identity) {
  // Lazy load after all guards. ADC is explicitly selected and validated, never discovered.
  const { Storage } = require('@google-cloud/storage');
  const storage = new Storage({ projectId: target.projectId,
    ...(identity.authClient ? { authClient: identity.authClient } : { credentials: identity }), apiEndpoint: 'https://storage.googleapis.com',
    retryOptions: { autoRetry: false, maxRetries: 0 } });
  const bucket = storage.bucket(target.bucket);
  return {
    async bucketMetadata() { return (await bucket.getMetadata({ timeout: 15000 }))[0]; },
    save(name, bytes, opts) { return saveWithoutAutomaticCleanup(bucket.file(name), bytes, opts); },
    async metadata(name) { return (await bucket.file(name).getMetadata({ timeout: 15000 }))[0]; },
    async missingStatus(name) {
      try { await bucket.file(name).getMetadata({ timeout: 15000 }); return 200; }
      catch (e) { return Number(e?.response?.status || e?.code); }
    },
    async read(name, g, limit) {
      // Do not use File({generation}): SDK 8.4.0 converts it to Number.
      const sdk = bucket.file(name).requestStream({ method: 'GET', uri: '', timeout: 15000, maxRetries: 0,
        qs: { generation: g, alt: 'media' }, headers: { 'Accept-Encoding': 'identity' } });
      return new Promise((resolve, reject) => {
        const chunks = []; let size = 0, response = false, ended = false;
        const timer = setTimeout(() => finish(Error('READ_TIMEOUT')), 20000);
        function finish(e, b) { if (ended) return; ended = true; clearTimeout(timer); sdk.destroy(); e ? reject(e) : resolve(b); }
        sdk.on('error', e => finish(e));
        sdk.on('response', r => { response = r.statusCode === 200 && r.headers['x-goog-generation'] === g;
          if (!response) finish(Error('READ_GENERATION_MISMATCH')); });
        sdk.on('data', c => { size += c.length; if (size > limit) finish(Error('READ_LIMIT')); else chunks.push(c); });
        sdk.on('end', () => finish(response ? null : Error('MISSING_RESPONSE'), Buffer.concat(chunks)));
        sdk.on('close', () => { if (!ended) finish(Error('INTERRUPTED_READ')); });
      });
    },
    anonymousStatus(name, g) {
      // Native HTTPS, no auth headers, no redirects, cookies, proxy or SDK credentials.
      const https = require('node:https');
      const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(target.bucket)}/o/${encodeURIComponent(name)}`);
      url.searchParams.set('alt', 'media'); url.searchParams.set('generation', g);
      return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 15000 }, res => { const status = res.statusCode; res.destroy(); resolve(status); });
        req.on('timeout', () => req.destroy(Error('ANONYMOUS_TIMEOUT'))); req.on('error', reject);
      });
    },
  };
}
module.exports = { APPROVED_TARGETS, PROPOSED_SAME_PROJECT_TARGET, validateTarget, validateCredentials, generation, runAcceptance,
  saveWithoutAutomaticCleanup };
