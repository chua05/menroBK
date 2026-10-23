// Explicit, lazy, development-only transport. Auth/Firestore never receive ADC.
const fs = require('node:fs');
const { resolveEvidenceStorageConfig } = require('../config/evidenceStorage');
const { createKeylessAuth } = require('./nonproductionStorageAcceptanceAuth.service');
const { validateBucketMetadata } = require('./nonproductionStorageAcceptancePolicy.service');
function createDevelopmentGcsAccess({ env = () => process.env, authenticate = createKeylessAuth,
  readAdc = file => {
    if (fs.statSync(file).size > 32768) throw Error('ADC_INVALID');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }, storageFactory = (config, authClient) => {
    const { Storage } = require('@google-cloud/storage');
    return new Storage({ projectId: config.projectId, authClient, apiEndpoint: 'https://storage.googleapis.com',
      retryOptions: { autoRetry: false, maxRetries: 0 } });
  }, now = Date.now } = {}) {
  let cached, pending;
  function config() {
    const value = resolveEvidenceStorageConfig(env());
    if (!value.gcsDevelopment || !value.cloudRead) throw Error('DEVELOPMENT_GCS_DISABLED');
    return value.gcsDevelopment;
  }
  async function getBucket() {
    const target = config(), signature = JSON.stringify(target);
    if (cached?.signature === signature && cached.expires > now() + 60000) return cached.bucket;
    if (pending) {
      try { await pending; } catch { throw Error('DEVELOPMENT_GCS_UNAVAILABLE'); }
      return getBucket();
    }
    pending = (async () => {
      const client = await authenticate(readAdc(target.adcFile), target);
      const bucket = storageFactory(target, client).bucket(target.bucket);
      const metadata = (await bucket.getMetadata({ timeout: 15000 }))[0];
      validateBucketMetadata(metadata, target);
      if (JSON.stringify(config()) !== signature || !Number.isFinite(client.credentials?.expiry_date) ||
          client.credentials.expiry_date <= now() + 60000) throw Error('DEVELOPMENT_GCS_DISABLED');
      cached = { signature, bucket, expires: client.credentials.expiry_date };
    })();
    try { await pending; } catch { cached = undefined; throw Error('DEVELOPMENT_GCS_UNAVAILABLE'); }
    finally { pending = undefined; }
    return cached.bucket;
  }
  return { getBucket };
}
let access;
function getDevelopmentStorageBucket() { return (access ||= createDevelopmentGcsAccess()).getBucket(); }
module.exports = { createDevelopmentGcsAccess, getDevelopmentStorageBucket };
