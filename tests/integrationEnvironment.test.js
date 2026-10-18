const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { resolveUploadRoot, validateIntegrationEnvironment } = require("../src/config/integrationEnvironment");

const valid = () => ({ MENRO_INTEGRATION_TEST: "true", NODE_ENV: "test",
  GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" });

test("rejects emulator hosts when integration mode is disabled", () => {
  assert.throws(() => validateIntegrationEnvironment({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }), /require MENRO_INTEGRATION_TEST/);
});
test("rejects production mode, real projects, and non-loopback hosts", () => {
  assert.throws(() => validateIntegrationEnvironment({ ...valid(), NODE_ENV: "production" }), /disabled in production/);
  assert.throws(() => validateIntegrationEnvironment({ ...valid(), FIREBASE_PROJECT_ID: "real-project" }), /requires project/);
  assert.throws(() => validateIntegrationEnvironment({ ...valid(), FIRESTORE_EMULATOR_HOST: "example.com:8080" }), /approved loopback/);
});
test("accepts only the explicit demo emulator configuration", () => {
  assert.equal(validateIntegrationEnvironment(valid()).projectId, "demo-menro-phase2");
});
test("requires an isolated temporary upload root", () => {
  const cwd = path.resolve("C:/work/menrobackend");
  assert.throws(() => resolveUploadRoot(valid(), cwd), /MENRO_UPLOAD_ROOT/);
  assert.throws(() => resolveUploadRoot({ ...valid(), MENRO_UPLOAD_ROOT: path.join(cwd, "uploads") }, cwd), /dedicated directory/);
  const isolated = path.join(os.tmpdir(), "menro-phase2-test-uploads");
  assert.equal(resolveUploadRoot({ ...valid(), MENRO_UPLOAD_ROOT: isolated }, cwd), path.resolve(isolated));
});
