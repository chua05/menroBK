// Pure, offline assessment of an EXPLICIT NON-SECRET JSON projection; no dotenv.
const fs = require('node:fs');
const { resolveEvidenceStorageConfig } = require('../src/config/evidenceStorage');
const { resolveEvidenceUploadQuotaConfig } = require('../src/config/evidenceUploadQuota');
const PUBLIC_KEYS = new Set(['NODE_ENV', 'EVIDENCE_STORAGE_PROVIDER', 'FIREBASE_STORAGE_BUCKET', 'FIREBASE_PROJECT_ID',
  'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'MENRO_INTEGRATION_TEST', 'MENRO_HISTORICAL_MIGRATION',
  'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST',
  'EVIDENCE_CLOUD_WORKFLOW_ENABLED', 'EVIDENCE_CLOUD_READ_ENABLED', 'MENRO_UPLOAD_ROOT', 'EVIDENCE_DAILY_FILE_LIMIT', 'EVIDENCE_DAILY_BYTE_LIMIT',
  'EVIDENCE_GLOBAL_DAILY_ALERT_BYTES', 'FRONTEND_URL', 'ALLOWED_ORIGINS', 'BACKEND_URL',
  'EVIDENCE_PUBLIC_URL', 'FIREBASE_STORAGE_PUBLIC_URL', 'ALLOW_VERCEL_PREVIEWS',
  'MENRO_GCS_PRODUCTION', 'EVIDENCE_GCS_PRODUCTION_APPROVAL']);
const SECRET_NAMES = new Set(['FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'REQUEST_IDENTIFICATION_ENCRYPTION_KEY',
  'GUEST_INVITATION_SECRET', 'RESEND_API_KEY']);
function validate(input) {
  const issues = [], add = (severity, code) => issues.push({ severity, code });
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).some(k => !['values', 'presentSecretNames'].includes(k)) ||
      !input.values || Object.getPrototypeOf(input.values) !== Object.prototype ||
      Object.entries(input.values).some(([k, v]) => !PUBLIC_KEYS.has(k) || typeof v !== 'string' || v.length > 2048) ||
      !Array.isArray(input.presentSecretNames) || input.presentSecretNames.some(n => !SECRET_NAMES.has(n))) {
    return { configurationValid: false, productionCloudReady: false, issues: [{ severity: 'BLOCKED', code: 'NON_SECRET_PROJECTION_REQUIRED' }] };
  }
  const v = input.values;
  if (v.NODE_ENV !== 'production') add('BLOCKED', 'PRODUCTION_MODE_REQUIRED');
  if (v.FIREBASE_PROJECT_ID !== 'menrosystem-ddfac' ||
      ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'].some(k => v[k] !== undefined && v[k] !== v.FIREBASE_PROJECT_ID)) add('BLOCKED', 'PROJECT_MISMATCH');
  for (const k of ['FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'REQUEST_IDENTIFICATION_ENCRYPTION_KEY', 'GUEST_INVITATION_SECRET']) {
    if (!input.presentSecretNames.includes(k)) add('BLOCKED', `MISSING_${k}`);
  }
  if (['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST'].some(k => v[k] !== undefined) ||
      ['MENRO_INTEGRATION_TEST', 'MENRO_HISTORICAL_MIGRATION'].some(k => v[k] !== undefined && v[k] !== 'false')) add('BLOCKED', 'PRODUCTION_EMULATOR_OR_MIGRATION_SETTING');
  // The report consumes a non-secret projection. For activation-shape validation
  // only, substitute fixed non-secret identity metadata and a presence marker;
  // this never attests that Render's actual secret has either value.
  const storageProjection = v.MENRO_GCS_PRODUCTION === 'true' ? { ...v,
    FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: input.presentSecretNames.includes('FIREBASE_PRIVATE_KEY') ? 'present-not-validated' : '' } : v;
  try { resolveEvidenceStorageConfig(storageProjection); } catch { add('BLOCKED', 'RUNTIME_STORAGE_CONFIG_REJECTED'); }
  try { resolveEvidenceUploadQuotaConfig(v); } catch { add('BLOCKED', 'INVALID_QUOTA_SETTINGS'); }
  if (v.MENRO_UPLOAD_ROOT !== undefined) add('WARNING', 'PRODUCTION_UPLOAD_ROOT_OVERRIDE_IGNORED');
  if (v.MENRO_GCS_PRODUCTION === 'true') add('WARNING', 'LIVE_PRODUCTION_STORAGE_ACTIVATION_REQUESTED');
  if (['EVIDENCE_PUBLIC_URL', 'FIREBASE_STORAGE_PUBLIC_URL'].some(k => v[k] !== undefined)) add('BLOCKED', 'PUBLIC_EVIDENCE_URL_FORBIDDEN');
  function origins(value) {
    return value && value.split(',').every(s => {
      try { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/'; }
      catch { return false; }
    });
  }
  if (!origins(v.FRONTEND_URL) || v.ALLOWED_ORIGINS !== undefined && !origins(v.ALLOWED_ORIGINS)) add('BLOCKED', 'INVALID_HTTPS_ORIGINS');
  if (!origins(v.BACKEND_URL) || v.BACKEND_URL.includes(',')) add('BLOCKED', 'INVALID_BACKEND_ORIGIN');
  if (v.ALLOW_VERCEL_PREVIEWS !== undefined && v.ALLOW_VERCEL_PREVIEWS !== 'false') add('WARNING', 'PREVIEW_ORIGIN_POLICY_REVIEW_REQUIRED');
  const configurationValid = !issues.some(i => i.severity === 'BLOCKED');
  // Never convert declarations of secret presence or emulator tests into deployment proof.
  return { configurationValid, productionCloudReady: false, scope: 'offline-config-only', issues,
    manualGates: ['REAL_GCS_IMMUTABILITY', 'IAM_AND_RULES', 'BACKUP_RESTORE', 'SOURCE_RECONCILIATION',
      'RENDER_DURABILITY', 'PRODUCTION_UPLOAD_AND_READ_GATES', 'READ_PRESERVING_ROLLBACK', 'ACTIVATION_APPROVAL'] };
}
function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--config') throw Error('EXPLICIT_CONFIG_REQUIRED');
  if (fs.statSync(args[1]).size > 32768) throw Error('CONFIG_TOO_LARGE');
  return validate(JSON.parse(fs.readFileSync(args[1], 'utf8')));
}
if (require.main === module) {
  try { const r = main(); console.log(JSON.stringify(r)); if (!r.configurationValid) process.exitCode = 1; }
  catch { console.error(JSON.stringify({ configurationValid: false, productionCloudReady: false, error: 'INVALID_CONFIG_INPUT' })); process.exitCode = 1; }
}
module.exports = { validate, main };
