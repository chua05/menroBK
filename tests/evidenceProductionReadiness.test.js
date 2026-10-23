const test = require('node:test'), assert = require('node:assert/strict');
const { validate } = require('../scripts/validateEvidenceProductionReadiness');
function input() { return { values: { NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'menrosystem-ddfac',
  EVIDENCE_STORAGE_PROVIDER: 'local', FIREBASE_STORAGE_BUCKET: 'menrosystem-ddfac.firebasestorage.app',
  FRONTEND_URL: 'https://frontend.example', BACKEND_URL: 'https://backend.example' },
  presentSecretNames: ['FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'REQUEST_IDENTIFICATION_ENCRYPTION_KEY', 'GUEST_INVITATION_SECRET'] }; }
test('safe local configuration does not certify cloud readiness or secret validity', () => {
  const c = input(), before = JSON.stringify(c), r = validate(c);
  assert.equal(r.configurationValid, true); assert.equal(r.productionCloudReady, false); assert.equal(JSON.stringify(c), before);
  assert.ok(r.manualGates.includes('READ_PRESERVING_ROLLBACK'));
});
for (const [key, value] of Object.entries({ FIREBASE_PROJECT_ID: 'other-project', FIREBASE_STORAGE_BUCKET: 'public-bucket',
  EVIDENCE_STORAGE_PROVIDER: 'firebase', EVIDENCE_CLOUD_WORKFLOW_ENABLED: 'true', EVIDENCE_CLOUD_READ_ENABLED: 'true',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_STORAGE_EMULATOR_HOST: '', STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
  MENRO_HISTORICAL_MIGRATION: 'true', MENRO_INTEGRATION_TEST: 'true', EVIDENCE_DAILY_FILE_LIMIT: '0',
  EVIDENCE_DAILY_BYTE_LIMIT: 'NaN', FRONTEND_URL: 'https://user:secret@example.com', BACKEND_URL: 'http://localhost:5000',
  EVIDENCE_PUBLIC_URL: 'https://secret.invalid/token', GOOGLE_CLOUD_PROJECT: 'other-project' })) {
  test(`reject ${key} without echoing supplied values`, () => {
    const c = input(); c.values[key] = value; const r = validate(c);
    assert.equal(r.configurationValid, false); if (value) assert.equal(JSON.stringify(r).includes(value), false);
  });
}
test('missing required secret declarations and actual secret values fail safely', () => {
  const c = input(); c.presentSecretNames = []; assert.equal(validate(c).configurationValid, false);
  c.values.FIREBASE_PRIVATE_KEY = 'SECRET-NOT-PRINTED'; const r = validate(c);
  assert.equal(r.configurationValid, false); assert.equal(JSON.stringify(r).includes('SECRET-NOT-PRINTED'), false);
});
test('production upload root is reported ignored, not claimed persistent', () => {
  const c = input(); c.values.MENRO_UPLOAD_ROOT = '/var/data';
  assert.ok(validate(c).issues.some(i => i.code === 'PRODUCTION_UPLOAD_ROOT_OVERRIDE_IGNORED'));
});
test('an exact production activation projection is accepted as configuration but never self-certifies readiness', () => {
  const c = input(); Object.assign(c.values, {
    MENRO_GCS_PRODUCTION: 'true', EVIDENCE_STORAGE_PROVIDER: 'gcs',
    EVIDENCE_CLOUD_WORKFLOW_ENABLED: 'true', EVIDENCE_CLOUD_READ_ENABLED: 'true',
    EVIDENCE_GCS_PRODUCTION_APPROVAL: 'AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION',
  });
  const r = validate(c);
  assert.equal(r.configurationValid, true);
  assert.equal(r.productionCloudReady, false);
  assert.ok(r.issues.some(i => i.code === 'LIVE_PRODUCTION_STORAGE_ACTIVATION_REQUESTED'));
});
