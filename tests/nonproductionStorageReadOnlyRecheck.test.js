// Exercise the EXACT documented future body with fake filesystem/auth/transport.
// No real ADC reads, SDK auth, subprocesses, cloud requests or object operations.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const document = fs.readFileSync(path.join(__dirname, '../docs/firebase-storage-phase8h-results.md'), 'utf8');
const body = /<!-- phase8h-readonly-recheck:start -->\r?\n```javascript\r?\n([\s\S]*?)\r?\n```/.exec(document)?.[1];
assert.ok(body, 'Reviewed read-only body must exist');
assert.equal(body.split('(async () => {').length, 2);
const run = new Function('require', 'process', 'console', body.replace('(async () => {', 'return (async () => {'));
const targetModule = require('../src/services/nonproductionStorageAcceptance.service');
const authModule = require('../src/services/nonproductionStorageAcceptanceAuth.service');
const policyModule = require('../src/services/nonproductionStorageAcceptancePolicy.service');
const P = targetModule.PROPOSED_SAME_PROJECT_TARGET.projectId;
const urls = [
  `https://cloudresourcemanager.googleapis.com/v1/projects/${P}`,
  `https://cloudresourcemanager.googleapis.com/v1/projects/${P}:getAncestry`,
  `https://iam.googleapis.com/v1/projects/${P}/roles/menroGcsBucketMetadataReader`,
  `https://cloudbilling.googleapis.com/v1/projects/${P}/billingInfo`,
];
async function execute({ mutate = () => {}, email = 'chuakyla21@gmail.com', approval = true, failure, tokenChanges = {} } = {}) {
  const responses = [
    { projectId: P, projectNumber: '123456789012', lifecycleState: 'ACTIVE' },
    { ancestor: [{ resourceId: { type: 'project', id: P } }] },
    { name: `projects/${P}/roles/menroGcsBucketMetadataReader`, stage: 'GA', includedPermissions: ['storage.buckets.get'] },
    { projectId: P, billingEnabled: true, billingAccountName: 'billingAccounts/SYNTHETIC-ONLY' },
  ];
  mutate(responses);
  const calls = [], output = [], fakeProcess = { env: {
    APPDATA: 'X:/synthetic-appdata', NODE_ENV: 'test', MENRO_GCS_ACCEPTANCE_ENV: 'same-project-test-bucket',
    ...(approval ? { MENRO_GCS_READONLY_RECHECK: 'AUTHORIZED_ANCESTRY_BILLING_METADATA_ROLE_ONLY' } : {}),
  } };
  const base = path.join(fakeProcess.env.APPDATA, 'gcloud');
  const files = new Map([
    [path.join(base, 'active_config'), 'default'],
    [path.join(base, 'configurations', 'config_default'), `[core]\naccount = ${email}\nproject = ${P}\n`],
    [path.join(base, 'application_default_credentials.json'), JSON.stringify({ type: 'authorized_user',
      client_id: 'synthetic-client', client_secret: 'synthetic-secret', refresh_token: 'synthetic-refresh' })],
  ]);
  class UserRefreshClient { async getAccessToken() { return { token: 'synthetic-never-real-token' }; } }
  class OAuth2Client {
    async getTokenInfo(token) {
      assert.equal(token, 'synthetic-never-real-token');
      return { email, email_verified: true, expiry_date: Date.now() + 300000, scopes: ['https://www.googleapis.com/auth/cloud-platform'], ...tokenChanges };
    }
    setCredentials(c) { assert.equal(c.access_token, 'synthetic-never-real-token'); assert.equal(c.refresh_token, undefined); }
    async request(options) {
      const index = calls.length;
      assert.ok(index < 4, 'Bounded requests'); assert.equal(options.url, urls[index]);
      assert.equal(options.method, index === 1 ? 'POST' : 'GET');
      assert.equal(options.retry, false); assert.equal(options.maxRedirects, 0);
      assert.equal(options.timeout, 15000); assert.equal(options.maxContentLength, 32768);
      if (index === 1) assert.deepEqual(options.data, {});
      calls.push(options.url);
      if (failure?.index === index) throw failure.error;
      return { status: 200, data: responses[index] };
    }
  }
  const modules = {
    'node:fs': {
      readFileSync(file) { assert.ok(files.has(file), 'Synthetic files only'); return files.get(file); },
      statSync(file) { assert.equal(file, path.join(base, 'application_default_credentials.json')); return { size: 400, mtimeMs: 7 }; },
    },
    'node:path': path,
    'node:module': { createRequire: () => name => {
      assert.equal(name, 'google-auth-library'); return { UserRefreshClient, OAuth2Client };
    } },
    './src/services/nonproductionStorageAcceptance.service': targetModule,
    './src/services/nonproductionStorageAcceptanceAuth.service': authModule,
    './src/services/nonproductionStorageAcceptancePolicy.service': policyModule,
  };
  const fakeRequire = name => { assert.ok(Object.hasOwn(modules, name), 'Only reviewed imports'); return modules[name]; };
  fakeRequire.resolve = name => { assert.equal(name, '@google-cloud/storage'); return 'synthetic-storage-module'; };
  await run(fakeRequire, fakeProcess, { log: line => output.push(JSON.parse(line)) });
  assert.equal(JSON.stringify(output).includes('synthetic-never-real-token'), false);
  assert.equal(JSON.stringify(output).includes('SYNTHETIC-ONLY'), false);
  return { calls, output, exitCode: fakeProcess.exitCode || 0 };
}
for (const reference of ['projectId', 'projectNumber']) test(`documented recheck is four fixed reads with ${reference} ancestry`, async () => {
  const r = await execute({ mutate: values => { values[1].ancestor[0].resourceId.id = values[0][reference]; } });
  assert.equal(r.exitCode, 0); assert.deepEqual(r.calls, urls);
  assert.equal(r.output.find(v => v.check === 'ancestry').projectReference, reference);
  assert.deepEqual(r.output.at(-1), { check: 'recheckComplete', status: 'PASS', metadataRequests: 4,
    objectRequests: 0, acceptanceExecutions: 0, adcUnchanged: true });
});
for (const [name, mutate, count, reason] of [
  ['mismatched project', a => { a[0].projectId = 'other-project'; }, 1, 'PROJECT_IDENTITY_MISMATCH'],
  ['missing ancestry', a => { a[1] = {}; }, 2, 'ANCESTRY_RESPONSE_INVALID'],
  ['mismatched ancestry', a => { a[1].ancestor[0].resourceId.id = 'other-project'; }, 2, 'ANCESTRY_PROJECT_MISMATCH'],
  ['unexpected parent', a => { a[1].ancestor.push({ resourceId: { type: 'folder', id: '123' } }); }, 2, 'ANCESTRY_REVIEW_REQUIRED'],
  ['excess role permission', a => { a[2].includedPermissions.push('storage.buckets.update'); }, 3, 'METADATA_ROLE_MISMATCH'],
  ['disabled billing', a => { a[3].billingEnabled = false; }, 4, 'BILLING_NOT_READY'],
]) test(`documented recheck stops on ${name}`, async () => {
  const r = await execute({ mutate }); assert.equal(r.exitCode, 1); assert.equal(r.calls.length, count);
  assert.equal(r.output.at(-1).reason, reason); assert.equal(r.output.at(-1).objectRequests, 0);
});
test('documented recheck cannot authenticate or read metadata without separate approval', async () => {
  const r = await execute({ approval: false }); assert.equal(r.exitCode, 1); assert.equal(r.calls.length, 0);
  assert.equal(r.output.at(-1).reason, 'READONLY_APPROVAL_REQUIRED');
});
test('documented recheck rejects an unexpected operator before metadata requests', async () => {
  const r = await execute({ email: 'wrong@example.invalid' }); assert.equal(r.exitCode, 1); assert.equal(r.calls.length, 0);
  assert.equal(r.output.at(-1).reason, 'LOCAL_CONFIG_MISMATCH');
});
for (const [name, tokenChanges, reason] of [
  ['wrong identity', { email: 'wrong@example.invalid' }, 'OPERATOR_IDENTITY_MISMATCH'],
  ['unverified email', { email_verified: false }, 'OPERATOR_IDENTITY_MISMATCH'],
  ['expired token', { expiry_date: 0 }, 'OPERATOR_SCOPE_EXPIRY_INVALID'],
  ['missing scope', { scopes: [] }, 'OPERATOR_SCOPE_EXPIRY_INVALID'],
  ['nonarray scopes', { scopes: 'https://www.googleapis.com/auth/cloud-platform' }, 'OPERATOR_SCOPE_EXPIRY_INVALID'],
]) test(`documented recheck rejects ${name} before metadata`, async () => {
  const r = await execute({ tokenChanges }); assert.equal(r.exitCode, 1); assert.equal(r.calls.length, 0);
  assert.equal(r.output.at(-1).reason, reason);
});
test('documented recheck reports permission denial without continuing', async () => {
  const r = await execute({ failure: { index: 1, error: { response: { status: 403 } } } });
  assert.equal(r.exitCode, 1); assert.equal(r.calls.length, 2); assert.equal(r.output.at(-1).reason, 'READ_PERMISSION_DENIED');
});
test('documented recheck does not expose an untrusted error safe property or diagnostic', async () => {
  const r = await execute({ failure: { index: 0, error: { safe: 'private-diagnostic-do-not-log', message: 'private-diagnostic-do-not-log' } } });
  assert.equal(r.exitCode, 1); assert.equal(r.calls.length, 1);
  assert.equal(r.output.at(-1).reason, 'READONLY_RECHECK_FAILED');
  assert.equal(JSON.stringify(r.output).includes('private-diagnostic'), false);
});
