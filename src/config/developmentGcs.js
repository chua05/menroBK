// Proposed development resources ONLY. Not provisioning, live approval or activation.
const path = require('node:path');
const { validateIntegrationEnvironment } = require('./integrationEnvironment');
const DEVELOPMENT_TARGET = Object.freeze({ projectId: 'menrosystem-ddfac',
  bucket: 'menro-evidence-dev-20261022-a4c8e912',
  serviceAccountEmail: 'menro-evidence-development@menrosystem-ddfac.iam.gserviceaccount.com' });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function resolveDevelopmentGcs(env = process.env) {
  const fields = ['EVIDENCE_GCS_PROJECT_ID','EVIDENCE_GCS_BUCKET','EVIDENCE_GCS_SERVICE_ACCOUNT',
    'EVIDENCE_GCS_ADC_FILE','EVIDENCE_GCS_NAMESPACE','EVIDENCE_GCS_DEVELOPMENT_APPROVAL'];
  const flag = env.MENRO_GCS_DEVELOPMENT;
  if (flag === undefined || flag === 'false') {
    if (fields.some(key => env[key] !== undefined)) throw Error('Inactive development GCS configuration must not contain target settings.');
    return null;
  }
  if (flag !== 'true' || !['development','test'].includes(env.NODE_ENV) ||
      !validateIntegrationEnvironment(env).integration ||
      (env.GOOGLE_CLOUD_PROJECT !== undefined && env.GOOGLE_CLOUD_PROJECT !== 'demo-menro-phase2') ||
      ['FIREBASE_STORAGE_EMULATOR_HOST','STORAGE_EMULATOR_HOST','FIREBASE_STORAGE_BUCKET',
        'GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_PRIVATE_KEY','FIREBASE_CLIENT_EMAIL','FIREBASE_CONFIG',
        'MENRO_HISTORICAL_MIGRATION','DEBUG','GOOGLE_CLOUD_QUOTA_PROJECT'].some(key => env[key] !== undefined)) {
    throw Error('Development GCS requires isolated loopback Auth/Firestore and no Firebase credentials or Storage emulator.');
  }
  if (env.EVIDENCE_GCS_PROJECT_ID !== DEVELOPMENT_TARGET.projectId ||
      env.EVIDENCE_GCS_BUCKET !== DEVELOPMENT_TARGET.bucket ||
      env.EVIDENCE_GCS_SERVICE_ACCOUNT !== DEVELOPMENT_TARGET.serviceAccountEmail ||
      env.EVIDENCE_GCS_DEVELOPMENT_APPROVAL !== 'APPROVED_DEVELOPMENT_BUCKET_AND_IDENTITY_ONLY' ||
      !uuid(env.EVIDENCE_GCS_NAMESPACE) || typeof env.EVIDENCE_GCS_ADC_FILE !== 'string' ||
      env.EVIDENCE_GCS_ADC_FILE.length > 1024 || !path.isAbsolute(env.EVIDENCE_GCS_ADC_FILE) ||
      path.basename(env.EVIDENCE_GCS_ADC_FILE) !== 'application_default_credentials.json') {
    throw Error('Development GCS target, approval, namespace or explicit ADC configuration is invalid.');
  }
  return Object.freeze({ ...DEVELOPMENT_TARGET, adcFile: env.EVIDENCE_GCS_ADC_FILE,
    prefix: `menro-development/${env.EVIDENCE_GCS_NAMESPACE}/` });
}
function evidenceObjectName(config, suffix) { return `${config.gcsDevelopment?.prefix || config.gcsProduction?.prefix || ''}${suffix}`; }
function matchesEvidenceObject(config, name, suffix) {
  if (config.gcsProduction) return name === `${config.gcsProduction.prefix}${suffix}`;
  if (!config.gcsDevelopment) return name === suffix;
  if (typeof name !== 'string') return false;
  const parts = name.split('/');
  // Persisted authorized references from earlier development namespaces stay readable.
  return parts[0] === 'menro-development' && uuid(parts[1]) && parts.slice(2).join('/') === suffix;
}
function isDevelopmentLoopback(request) {
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request?.socket?.remoteAddress);
}
module.exports = { DEVELOPMENT_TARGET, resolveDevelopmentGcs, evidenceObjectName, matchesEvidenceObject, isDevelopmentLoopback };
