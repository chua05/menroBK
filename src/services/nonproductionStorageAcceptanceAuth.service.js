// Standalone harness only. Explicit ADC input; NO discovery, metadata server or ADC fallback.
const SCOPES = Object.freeze(['https://www.googleapis.com/auth/devstorage.read_write',
  'https://www.googleapis.com/auth/userinfo.email']);
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const status = e => Number(e?.response?.status || e?.code);
function validateAdc(input, target) {
  if (!plain(input)) fail('ADC_REQUIRED');
  let source = input;
  if (input.type === 'impersonated_service_account') {
    if (input.service_account_impersonation_url !==
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${target.serviceAccountEmail}:generateAccessToken` ||
        input.delegates !== undefined && (!Array.isArray(input.delegates) || input.delegates.length)) fail('ADC_IDENTITY_MISMATCH');
    if (Object.keys(input).some(k => !['type', 'source_credentials', 'service_account_impersonation_url',
      'delegates', 'quota_project_id', 'universe_domain'].includes(k))) fail('ADC_INVALID');
    source = input.source_credentials;
  }
  for (const c of [input, source]) {
    if (!plain(c) || c.universe_domain !== undefined && c.universe_domain !== 'googleapis.com' ||
        c.quota_project_id !== undefined && c.quota_project_id !== target.projectId) fail('ADC_INVALID');
  }
  if (source.type !== 'authorized_user' || Object.keys(source).some(k =>
    !['type', 'client_id', 'client_secret', 'refresh_token', 'quota_project_id', 'universe_domain', 'account'].includes(k)) ||
    ['client_id', 'client_secret', 'refresh_token'].some(k => typeof source[k] !== 'string' ||
      !source[k].trim() || source[k].length > 8192)) fail('ADC_INVALID');
  // Never forward configurable endpoints, billing projects, scopes, delegates or account claims.
  return { clientId: source.client_id, clientSecret: source.client_secret, refreshToken: source.refresh_token };
}
function validateTokenInfo(info, target, now = Date.now()) {
  if (!info || info.email !== target.serviceAccountEmail) fail('EFFECTIVE_IDENTITY_MISMATCH');
  if (![true, 'true'].includes(info.email_verified) || !Number.isFinite(info.expiry_date) ||
      info.expiry_date < now + 30000 || !Array.isArray(info.scopes) ||
      SCOPES.some(s => !info.scopes.includes(s))) fail('EFFECTIVE_TOKEN_INVALID');
}
async function createKeylessAuth(input, target, library) {
  const sourceOptions = validateAdc(input, target); // Before SDK loading or network.
  library ||= require('node:module').createRequire(require.resolve('@google-cloud/storage'))('google-auth-library');
  const { UserRefreshClient, Impersonated, OAuth2Client } = library;
  const options = { transporterOptions: { timeout: 15000, retry: false, maxRedirects: 0,
    maxContentLength: 32768 }, universeDomain: 'googleapis.com' };
  const sourceClient = new UserRefreshClient({ ...options, ...sourceOptions });
  const impersonated = new Impersonated({ ...options, sourceClient,
    targetPrincipal: target.serviceAccountEmail, targetScopes: [...SCOPES], delegates: [], lifetime: 300,
    endpoint: 'https://iamcredentials.googleapis.com' });
  let token, info, introspecting = false;
  try {
    token = (await impersonated.getAccessToken())?.token;
    if (typeof token !== 'string' || !token || token.length > 16384) fail('EFFECTIVE_TOKEN_INVALID');
    introspecting = true;
    info = await new OAuth2Client(options).getTokenInfo(token);
  } catch (e) {
    if (e?.code === 'EFFECTIVE_TOKEN_INVALID') throw e;
    if (status(e) === 403) fail(introspecting ? 'TOKEN_INTROSPECTION_DENIED' : 'IMPERSONATION_PERMISSION_DENIED');
    if (status(e) === 401 || ['invalid_grant', 'invalid_client', 'unauthorized_client']
      .includes(e?.response?.data?.error)) fail('AUTH_CREDENTIALS_INVALID');
    fail('AUTH_VERIFICATION_UNAVAILABLE');
  }
  validateTokenInfo(info, target);
  // Pin the EXACT introspected token. No refresh source or user credentials reach GCS.
  // AuthClient ignores an option value of zero; use 1ms instead of its 5-minute default.
  const client = new OAuth2Client({ ...options, eagerRefreshThresholdMillis: 1, forceRefreshOnFailure: false });
  client.setCredentials({ access_token: token, expiry_date: info.expiry_date, token_type: 'Bearer' });
  return client;
}
module.exports = { SCOPES, validateAdc, validateTokenInfo, createKeylessAuth };
