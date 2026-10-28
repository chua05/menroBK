const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { resolveUploadRoot, validateIntegrationEnvironment } = require("../src/config/integrationEnvironment");

const valid = () => ({ MENRO_INTEGRATION_TEST: "true", NODE_ENV: "test",
  GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" });
const mpdoValid = () => ({ ...valid(), MENRO_MPDO_BOUNDARY_ACCEPTANCE: "true",
  MENRO_TEST_BOUNDARY_SOURCE: "mpdo-candidate", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180" });

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
test("accepts port 8180 only for the explicit MPDO candidate acceptance gate", () => {
  assert.equal(validateIntegrationEnvironment(mpdoValid()).mpdoAcceptance, true);
  assert.throws(() => validateIntegrationEnvironment({ ...valid(), FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180" }),
    /approved loopback/);
  assert.throws(() => validateIntegrationEnvironment({ ...mpdoValid(), MENRO_MPDO_BOUNDARY_ACCEPTANCE: undefined }),
    /explicit MPDO acceptance gate/);
  assert.throws(() => validateIntegrationEnvironment({ ...mpdoValid(), MENRO_TEST_BOUNDARY_SOURCE: undefined }),
    /requires the inactive MPDO candidate/);
  assert.throws(() => validateIntegrationEnvironment({ ...mpdoValid(), MENRO_MPDO_BOUNDARY_ACCEPTANCE: "false" }),
    /must be exactly true/);
  assert.throws(() => validateIntegrationEnvironment({ ...mpdoValid(), NODE_ENV: "production" }),
    /disabled in production/);
});

test("accepts port 8181 only for explicit request-letter acceptance", () => {
  const env = valid();
  env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8181";
  env.MENRO_REQUEST_LETTER_ACCEPTANCE = "true";
  assert.equal(validateIntegrationEnvironment(env).requestLetterAcceptance, true);
  delete env.MENRO_REQUEST_LETTER_ACCEPTANCE;
  assert.throws(() => validateIntegrationEnvironment(env), /approved loopback/);
});
test("requires an isolated temporary upload root", () => {
  const cwd = path.resolve("C:/work/menrobackend");
  assert.throws(() => resolveUploadRoot(valid(), cwd), /MENRO_UPLOAD_ROOT/);
  assert.throws(() => resolveUploadRoot({ ...valid(), MENRO_UPLOAD_ROOT: path.join(cwd, "uploads") }, cwd), /dedicated directory/);
  const isolated = path.join(os.tmpdir(), "menro-phase2-test-uploads");
  assert.equal(resolveUploadRoot({ ...valid(), MENRO_UPLOAD_ROOT: isolated }, cwd), path.resolve(isolated));
});
