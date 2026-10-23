const path = require('node:path'), os = require('node:os');
const { DEVELOPMENT_TARGET } = require('../../src/config/developmentGcs');
function developmentEnv() {
  return { NODE_ENV: 'test', MENRO_INTEGRATION_TEST: 'true', GCLOUD_PROJECT: 'demo-menro-phase2',
    FIREBASE_PROJECT_ID: 'demo-menro-phase2', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', EVIDENCE_STORAGE_PROVIDER: 'gcs',
    MENRO_GCS_DEVELOPMENT: 'true', EVIDENCE_CLOUD_WORKFLOW_ENABLED: 'true', EVIDENCE_CLOUD_READ_ENABLED: 'true',
    EVIDENCE_GCS_PROJECT_ID: DEVELOPMENT_TARGET.projectId, EVIDENCE_GCS_BUCKET: DEVELOPMENT_TARGET.bucket,
    EVIDENCE_GCS_SERVICE_ACCOUNT: DEVELOPMENT_TARGET.serviceAccountEmail,
    EVIDENCE_GCS_NAMESPACE: '00000000-0000-4000-8000-000000000001',
    EVIDENCE_GCS_ADC_FILE: path.join(os.tmpdir(), 'synthetic-never-read', 'application_default_credentials.json'),
    EVIDENCE_GCS_DEVELOPMENT_APPROVAL: 'APPROVED_DEVELOPMENT_BUCKET_AND_IDENTITY_ONLY' };
}
async function withDevelopment(fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(FIREBASE_|FIRESTORE_|STORAGE_|EVIDENCE_|MENRO_|GCLOUD_|GOOGLE_|DEBUG$)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, developmentEnv());
  try { return await fn(); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
module.exports = { developmentEnv, withDevelopment };
