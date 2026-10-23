const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveEvidenceStorageConfig } = require("../src/config/evidenceStorage");
const { PRODUCTION_TARGET } = require("../src/config/productionGcs");
const { evidenceObjectName, matchesEvidenceObject } = require("../src/config/developmentGcs");
const { memoryFirestore } = require("./helpers/evidenceQuotaMemory");
const { createEvidenceWorkflow } = require("../src/services/evidenceWorkflow.service");
const { createEvidenceUploadQuota } = require("../src/services/evidenceUploadQuota.service");
const { createFirebaseEvidenceStorage } = require("../src/services/firebaseEvidenceStorage.service");
const { createFirebaseEvidenceRetrieval } = require("../src/services/firebaseEvidenceRetrieval.service");

function production(overrides = {}) {
  return {
    NODE_ENV: "production",
    MENRO_GCS_PRODUCTION: "true",
    FIREBASE_PROJECT_ID: PRODUCTION_TARGET.projectId,
    FIREBASE_STORAGE_BUCKET: PRODUCTION_TARGET.bucket,
    FIREBASE_CLIENT_EMAIL: PRODUCTION_TARGET.serviceAccountEmail,
    FIREBASE_PRIVATE_KEY: "test-only-placeholder",
    EVIDENCE_STORAGE_PROVIDER: "gcs",
    EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true",
    EVIDENCE_CLOUD_READ_ENABLED: "true",
    EVIDENCE_GCS_PRODUCTION_APPROVAL: "AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION",
    ...overrides,
  };
}

test("production GCS is disabled by default", () => {
  const config = resolveEvidenceStorageConfig({ NODE_ENV: "production", EVIDENCE_STORAGE_PROVIDER: "local" });
  assert.equal(config.provider, "local");
  assert.equal(config.gcsProduction, undefined);
});

test("production GCS requires the exact approved tuple and all write/read gates", () => {
  const config = resolveEvidenceStorageConfig(production());
  assert.equal(config.provider, "gcs");
  assert.deepEqual(config.gcsProduction, { ...PRODUCTION_TARGET, prefix: "menro-production/" });
  assert.equal(config.cloudWorkflow, true);
  assert.equal(config.cloudRead, true);
});

test("production rollback returns new writes to local while retaining exact private cloud reads", () => {
  const config = resolveEvidenceStorageConfig(production({ EVIDENCE_STORAGE_PROVIDER: "local",
    EVIDENCE_CLOUD_WORKFLOW_ENABLED: "false" }));
  assert.equal(config.provider, "local");
  assert.equal(config.cloudWorkflow, undefined);
  assert.equal(config.cloudRead, true);
  assert.equal(config.gcsProduction.bucket, PRODUCTION_TARGET.bucket);
});

for (const [name, overrides] of [
  ["approval", { EVIDENCE_GCS_PRODUCTION_APPROVAL: "no" }],
  ["project", { FIREBASE_PROJECT_ID: "other-project" }],
  ["bucket", { FIREBASE_STORAGE_BUCKET: "other-bucket" }],
  ["identity", { FIREBASE_CLIENT_EMAIL: "other@example.invalid" }],
  ["provider", { EVIDENCE_STORAGE_PROVIDER: "local" }],
  ["write gate", { EVIDENCE_CLOUD_WORKFLOW_ENABLED: "false" }],
  ["read gate", { EVIDENCE_CLOUD_READ_ENABLED: "false" }],
  ["environment", { NODE_ENV: "development" }],
  ["emulator", { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
  ["ADC selector", { GOOGLE_APPLICATION_CREDENTIALS: "credentials.json" }],
]) test(`production GCS rejects wrong ${name}`, () => {
  assert.throws(() => resolveEvidenceStorageConfig(production(overrides)));
});

test("production object namespace is exact and cannot cross environments", () => {
  const config = resolveEvidenceStorageConfig(production());
  const suffix = "evidence/v1/planting-report/report-1/12345678-1234-1234-1234-123456789abc";
  const name = evidenceObjectName(config, suffix);
  assert.equal(name, `menro-production/${suffix}`);
  assert.equal(matchesEvidenceObject(config, name, suffix), true);
  assert.equal(matchesEvidenceObject(config, suffix, suffix), false);
  assert.equal(matchesEvidenceObject(config, `menro-development/12345678-1234-1234-1234-123456789abc/${suffix}`, suffix), false);
});

test("production project is accepted by the existing private workflow, quota, upload and retrieval adapters", () => {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, production());
    const memory = memoryFirestore();
    memory.db.projectId = PRODUCTION_TARGET.projectId;
    assert.doesNotThrow(() => createEvidenceWorkflow({ db: memory.db, storage: {} }));
    assert.doesNotThrow(() => createEvidenceUploadQuota({ db: memory.db }));
    assert.doesNotThrow(() => createFirebaseEvidenceStorage({ db: memory.db,
      getBucket: async () => ({ name: PRODUCTION_TARGET.bucket, storage: { apiEndpoint: "https://storage.googleapis.com" } }) }));
    assert.doesNotThrow(() => createFirebaseEvidenceRetrieval({
      getBucket: async () => ({ name: PRODUCTION_TARGET.bucket, storage: { apiEndpoint: "https://storage.googleapis.com" } }) }));
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

module.exports = { production };
