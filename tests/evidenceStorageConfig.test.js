const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveEvidenceStorageConfig: resolve } = require("../src/config/evidenceStorage");
const { validateIntegrationEnvironment: validate } = require("../src/config/integrationEnvironment");

const demo = () => ({ MENRO_INTEGRATION_TEST: "true", NODE_ENV: "test",
  GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" });
const storageDemo = () => ({ ...demo(), FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199",
  FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app" });

test("missing provider/bucket preserves local storage with no production fallback", () => {
  assert.deepEqual(resolve({}), { provider: "local", bucket: null, storageEmulator: false });
  assert.equal(resolve({ EVIDENCE_STORAGE_PROVIDER: "local" }).provider, "local");
});
test("firebase provider is explicitly unavailable even with an approved bucket", () => {
  for (const env of [{}, storageDemo(), { FIREBASE_STORAGE_BUCKET: "menrosystem-ddfac.firebasestorage.app" }]) {
    assert.throws(() => resolve({ ...env, EVIDENCE_STORAGE_PROVIDER: "firebase" }), /unavailable in Phase 1/);
  }
});
test("unknown and empty provider values fail closed without echoing values", () => {
  for (const value of ["", "s3", "LOCAL", "firebase ", "secret-like-value"]) {
    assert.throws(() => resolve({ EVIDENCE_STORAGE_PROVIDER: value }), /must be local/);
  }
});
test("only the explicitly approved bare MENRO production bucket is accepted", () => {
  assert.equal(resolve({ FIREBASE_STORAGE_BUCKET: "menrosystem-ddfac.firebasestorage.app" }).storageEmulator, false);
  for (const bucket of ["", "wrong.firebasestorage.app", "gs://menrosystem-ddfac.firebasestorage.app",
    "https://example.test", "menrosystem-ddfac.firebasestorage.app/path", " menrosystem-ddfac.firebasestorage.app"]) {
    assert.throws(() => resolve({ FIREBASE_STORAGE_BUCKET: bucket }), /approved MENRO bucket/);
  }
});
test("a configured MENRO bucket cannot accompany a different explicit project", () => {
  assert.throws(() => resolve({ FIREBASE_STORAGE_BUCKET: "menrosystem-ddfac.firebasestorage.app",
    FIREBASE_PROJECT_ID: "another-project" }), /do not match/);
});
test("existing Auth/Firestore-only demo configuration remains supported", () => {
  assert.equal(validate(demo()).integration, true);
  assert.deepEqual(resolve(demo()), { provider: "local", bucket: null, storageEmulator: false });
});
test("the complete approved Storage demo configuration is accepted with local provider", () => {
  assert.deepEqual(resolve(storageDemo()), { provider: "local", bucket: "demo-menro-phase2.firebasestorage.app", storageEmulator: true });
});
test("Storage emulator settings require explicit integration mode", () => {
  for (const host of ["127.0.0.1:9199", "", "https://evil.example"]) {
    assert.throws(() => validate({ FIREBASE_STORAGE_EMULATOR_HOST: host }), /require MENRO_INTEGRATION_TEST/);
  }
});
test("Storage host rejects public, alternate, malformed and protocol-prefixed addresses", () => {
  for (const host of ["", "localhost:9199", "0.0.0.0:9199", "127.0.0.1:9200", "http://127.0.0.1:9199",
    "example.com:9199", "127.0.0.1:9199@evil.example", "[::1]:9199"]) {
    assert.throws(() => resolve({ ...storageDemo(), FIREBASE_STORAGE_EMULATOR_HOST: host }), /approved loopback Storage/);
  }
});
test("Storage host and synthetic bucket are required together", () => {
  for (const field of ["FIREBASE_STORAGE_EMULATOR_HOST", "FIREBASE_STORAGE_BUCKET"]) {
    const env = storageDemo(); delete env[field];
    assert.throws(() => resolve(env), /Storage/);
  }
});
test("production and arbitrary buckets are rejected even against the loopback emulator", () => {
  for (const bucket of ["menrosystem-ddfac.firebasestorage.app", "demo-other.firebasestorage.app", ""]) {
    assert.throws(() => resolve({ ...storageDemo(), FIREBASE_STORAGE_BUCKET: bucket }), /synthetic demo Storage bucket/);
  }
});
test("production mode and mismatched project IDs remain blocked", () => {
  assert.throws(() => resolve({ ...storageDemo(), NODE_ENV: "production" }), /disabled in production/);
  for (const field of ["GCLOUD_PROJECT", "FIREBASE_PROJECT_ID"]) {
    const env = storageDemo(); env[field] = "menrosystem-ddfac";
    assert.throws(() => resolve(env), /requires project/);
    delete env[field]; assert.throws(() => resolve(env), /requires project/);
  }
});
test("existing Auth/Firestore host protections cannot be bypassed by Storage configuration", () => {
  for (const field of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) {
    const env = storageDemo(); delete env[field];
    assert.throws(() => resolve(env), /approved loopback Firestore and Auth/);
    env[field] = "public.example:8080";
    assert.throws(() => resolve(env), /approved loopback Firestore and Auth/);
  }
});

test("read-only rollback uses local uploads, independent explicit reads and no cloud workflow", () => {
  const config = resolve({ ...storageDemo(), EVIDENCE_STORAGE_PROVIDER: "local",
    EVIDENCE_CLOUD_WORKFLOW_ENABLED: "false", EVIDENCE_CLOUD_READ_ENABLED: "true" });
  assert.equal(config.cloudRead, true); assert.equal(config.cloudWorkflow, undefined);
  assert.equal(config.provider, "local"); assert.equal(config.storageEmulator, true);
  assert.equal(resolve({ ...storageDemo(), EVIDENCE_CLOUD_READ_ENABLED: "true",
    STORAGE_EMULATOR_HOST: "http://127.0.0.1:9199" }).cloudRead, true);
  const disabled = resolve({ ...storageDemo(), EVIDENCE_STORAGE_PROVIDER: "firebase",
    EVIDENCE_CLOUD_WORKFLOW_ENABLED: "false", EVIDENCE_CLOUD_READ_ENABLED: "true" });
  assert.equal(disabled.cloudRead, true); assert.equal(disabled.cloudWorkflow, undefined);
});

test("cloud workflow retains backward-compatible reads but cannot explicitly turn reads off", () => {
  const env = { ...storageDemo(), EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true" };
  assert.equal(resolve(env).cloudRead, true);
  assert.throws(() => resolve({ ...env, EVIDENCE_CLOUD_READ_ENABLED: "false" }), /require cloud reads/);
});

test("local-only and disabled read flags do not enable cloud reads", () => {
  assert.equal(resolve(storageDemo()).cloudRead, undefined);
  assert.equal(resolve({ ...storageDemo(), EVIDENCE_CLOUD_READ_ENABLED: "false" }).cloudRead, undefined);
});

test("read-only mode rejects credentials, mismatched aliases, missing hosts and production", () => {
  const env = { ...storageDemo(), EVIDENCE_CLOUD_READ_ENABLED: "true" };
  for (const patch of [{ NODE_ENV: "production" }, { MENRO_INTEGRATION_TEST: "false" },
    { FIREBASE_STORAGE_BUCKET: "menrosystem-ddfac.firebasestorage.app" }, { GOOGLE_CLOUD_PROJECT: "other-project" },
    { FIREBASE_STORAGE_EMULATOR_HOST: undefined }, { FIREBASE_AUTH_EMULATOR_HOST: undefined },
    { GOOGLE_APPLICATION_CREDENTIALS: "never-read" }, { FIREBASE_PRIVATE_KEY: "" },
    { FIREBASE_CLIENT_EMAIL: "" }, { FIREBASE_CONFIG: "{}" },
    { STORAGE_EMULATOR_HOST: "https://storage.googleapis.com" }]) assert.throws(() => resolve({ ...env, ...patch }));
  assert.throws(() => resolve({ NODE_ENV: "production", EVIDENCE_CLOUD_READ_ENABLED: "true",
    FIREBASE_PROJECT_ID: "menrosystem-ddfac", FIREBASE_STORAGE_BUCKET: "menrosystem-ddfac.firebasestorage.app" }));
});

test("malformed read flags fail closed without reflecting input", () => {
  for (const value of ["", "TRUE", " true", "1", true, "secret-like-value"]) {
    assert.throws(() => resolve({ ...storageDemo(), EVIDENCE_CLOUD_READ_ENABLED: value }), /Invalid evidence read gate/);
  }
});
