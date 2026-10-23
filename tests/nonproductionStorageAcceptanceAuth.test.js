const test = require('node:test'), assert = require('node:assert/strict');
const { SCOPES, validateAdc, validateTokenInfo, createKeylessAuth } = require('../src/services/nonproductionStorageAcceptanceAuth.service');
const { PROPOSED_SAME_PROJECT_TARGET: target } = require('../src/services/nonproductionStorageAcceptance.service');
const source = { type: 'authorized_user', client_id: 'synthetic-client', client_secret: 'synthetic-secret', refresh_token: 'synthetic-refresh' };
const impersonated = { type: 'impersonated_service_account', source_credentials: source,
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${target.serviceAccountEmail}:generateAccessToken` };
const info = () => ({ email: target.serviceAccountEmail, email_verified: true, expiry_date: Date.now() + 300000, scopes: [...SCOPES] });
function library({ tokenInfo = info(), error } = {}) {
  const calls = []; let pinned;
  class UserRefreshClient { constructor(opts) { calls.push(['source', opts]); } }
  class Impersonated {
    constructor(opts) { calls.push(['impersonation', opts]); }
    async getAccessToken() { if (error) throw error; return { token: 'synthetic-short-token' }; }
  }
  class OAuth2Client {
    async getTokenInfo(token) { assert.equal(token, 'synthetic-short-token'); return tokenInfo; }
    setCredentials(c) { pinned = c; }
  }
  return { api: { UserRefreshClient, Impersonated, OAuth2Client }, calls, pinned: () => pinned };
}
test('authorized-user ADC and exact impersonated ADC are sanitized to source refresh credentials only', () => {
  assert.deepEqual(validateAdc(source, target), { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' });
  assert.deepEqual(validateAdc(impersonated, target), validateAdc(source, target));
});
for (const [name, value, code] of [
  ['missing', undefined, 'ADC_REQUIRED'], ['empty', {}, 'ADC_INVALID'],
  ['service-account key', { type: 'service_account' }, 'ADC_INVALID'],
  ['external endpoint', { ...source, token_uri: 'https://evil.invalid' }, 'ADC_INVALID'],
  ['external-account credentials', { type: 'external_account' }, 'ADC_INVALID'],
  ['empty refresh', { ...source, refresh_token: '' }, 'ADC_INVALID'],
  ['oversized refresh', { ...source, refresh_token: 'a'.repeat(8193) }, 'ADC_INVALID'],
  ['billing project', { ...source, quota_project_id: 'other-project' }, 'ADC_INVALID'],
  ['universe', { ...source, universe_domain: 'evil.invalid' }, 'ADC_INVALID'],
  ['wrong impersonation target', { ...impersonated, service_account_impersonation_url: impersonated.service_account_impersonation_url.replace('menro-gcs-acceptance@', 'production@') }, 'ADC_IDENTITY_MISMATCH'],
  ['endpoint substitution', { ...impersonated, service_account_impersonation_url: impersonated.service_account_impersonation_url.replace('iamcredentials.googleapis.com', 'evil.invalid') }, 'ADC_IDENTITY_MISMATCH'],
  ['delegation chain', { ...impersonated, delegates: ['other-account'] }, 'ADC_IDENTITY_MISMATCH'],
  ['source key', { ...impersonated, source_credentials: { type: 'service_account' } }, 'ADC_INVALID'],
  ['endpoint option', { ...impersonated, endpoint: 'https://evil.invalid' }, 'ADC_INVALID'],
]) test(`invalid ADC fails offline before authentication: ${name}`, async () => {
  await assert.rejects(createKeylessAuth(value, target, {}), { code });
});
test('keyless authentication impersonates only the pinned principal and pins the introspected token', async () => {
  const f = library(); await createKeylessAuth(impersonated, target, f.api);
  const options = f.calls.find(c => c[0] === 'impersonation')[1];
  assert.equal(options.targetPrincipal, target.serviceAccountEmail); assert.equal(options.lifetime, 300);
  assert.deepEqual(options.delegates, []); assert.deepEqual(options.targetScopes, [...SCOPES]);
  assert.equal(options.endpoint, 'https://iamcredentials.googleapis.com');
  assert.deepEqual(Object.keys(f.pinned()).sort(), ['access_token', 'expiry_date', 'token_type']);
  assert.equal(f.pinned().access_token, 'synthetic-short-token');
});
for (const [name, changes, code] of [
  ['wrong account', { email: 'wrong@menrosystem-ddfac.iam.gserviceaccount.com' }, 'EFFECTIVE_IDENTITY_MISMATCH'],
  ['missing email', { email: undefined }, 'EFFECTIVE_IDENTITY_MISMATCH'],
  ['unverified email', { email_verified: false }, 'EFFECTIVE_TOKEN_INVALID'],
  ['expired token', { expiry_date: 0 }, 'EFFECTIVE_TOKEN_INVALID'],
  ['near-expiry token', { expiry_date: Date.now() + 1000 }, 'EFFECTIVE_TOKEN_INVALID'],
  ['missing scopes', { scopes: [] }, 'EFFECTIVE_TOKEN_INVALID'],
]) test(`effective token fails closed: ${name}`, async () => {
  const f = library({ tokenInfo: { ...info(), ...changes } });
  await assert.rejects(createKeylessAuth(source, target, f.api), { code }); assert.equal(f.pinned(), undefined);
});
for (const [error, code] of [[{ code: 403 }, 'IMPERSONATION_PERMISSION_DENIED'],
  [{ response: { status: 401 } }, 'AUTH_CREDENTIALS_INVALID'],
  [{ response: { data: { error: 'invalid_grant' } } }, 'AUTH_CREDENTIALS_INVALID'],
  [{ response: { data: { error: 'invalid_client' } } }, 'AUTH_CREDENTIALS_INVALID'],
  [Error('sensitive diagnostic'), 'AUTH_VERIFICATION_UNAVAILABLE']]) {
  test(`authentication failure is safely classified as ${code}`, async () => {
    const f = library({ error }); await assert.rejects(createKeylessAuth(source, target, f.api), { code });
    assert.equal(f.pinned(), undefined);
  });
}
test('expired token validation never relies on source email claims', () => {
  assert.throws(() => validateTokenInfo({ ...info(), email: 'operator@example.com' }, target), /EFFECTIVE_IDENTITY_MISMATCH/);
});
test('token introspection denial is not mislabeled as an impersonation permission failure', async () => {
  const f = library(); f.api.OAuth2Client.prototype.getTokenInfo = async () => { throw { code: 403 }; };
  await assert.rejects(createKeylessAuth(source, target, f.api), { code: 'TOKEN_INTROSPECTION_DENIED' });
});
for (const [name, result] of [['missing', {}], ['null', { token: null }], ['empty', { token: '' }],
  ['oversized', { token: 'x'.repeat(16385) }]]) {
  test(`invalid minted token fails before introspection or Storage: ${name}`, async () => {
    const f = library(); let introspected = false;
    f.api.Impersonated.prototype.getAccessToken = async () => result;
    f.api.OAuth2Client.prototype.getTokenInfo = async () => { introspected = true; throw Error('forbidden'); };
    await assert.rejects(createKeylessAuth(source, target, f.api), { code: 'EFFECTIVE_TOKEN_INVALID' });
    assert.equal(introspected, false); assert.equal(f.pinned(), undefined);
  });
}
test('installed Google auth constructors support the keyless adapter and fixed-token Storage client offline', async () => {
  const lib = require('node:module').createRequire(require.resolve('@google-cloud/storage'))('google-auth-library');
  const getToken = lib.Impersonated.prototype.getAccessToken, getInfo = lib.OAuth2Client.prototype.getTokenInfo;
  lib.Impersonated.prototype.getAccessToken = async function() { assert.equal(this.getTargetPrincipal(), target.serviceAccountEmail); return { token: 'synthetic-only' }; };
  lib.OAuth2Client.prototype.getTokenInfo = async () => info();
  try {
    const client = await createKeylessAuth(source, target, lib);
    assert.equal((await client.getRequestHeaders('https://storage.googleapis.com')).get('authorization'), 'Bearer synthetic-only');
    assert.equal(client.credentials.refresh_token, undefined);
    const { Storage } = require('@google-cloud/storage');
    const storage = new Storage({ projectId: target.projectId, authClient: client });
    assert.equal(await storage.authClient.getClient(), client);
    client.credentials.expiry_date = Date.now() - 1;
    await assert.rejects(client.getRequestHeaders('https://storage.googleapis.com'), /No refresh token/);
  } finally { lib.Impersonated.prototype.getAccessToken = getToken; lib.OAuth2Client.prototype.getTokenInfo = getInfo; }
});
