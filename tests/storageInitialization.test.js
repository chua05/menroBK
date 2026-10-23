const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function initialize(env, fn) {
  const saved = { ...process.env };
  // Tests must not inherit developer-machine Firebase/GCS selectors or debug
  // switches. Production code deliberately fails closed when any are present.
  for (const key of Object.keys(process.env)) {
    if (/^(FIREBASE_|FIRESTORE_|STORAGE_|EVIDENCE_|MENRO_|GCLOUD_|GOOGLE_|DEBUG$)/.test(key)) {
      delete process.env[key];
    }
  }
  delete process.env.NODE_ENV;
  Object.assign(process.env, env);
  const filename = require.resolve("../src/config/firebase");
  const previous = require.cache[filename];
  delete require.cache[filename];
  const calls = { apps: 0, storage: 0, operations: 0, dotenv: 0 };
  const app = {};
  const auth = {}, db = {};
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === filename) {
      if (request === "dotenv") return { config() { calls.dotenv++; } };
      if (request === "firebase-admin/app") return { initializeApp(options) { calls.apps++; calls.options = options; return app; }, cert() { return {}; } };
      if (request === "firebase-admin/auth") return { getAuth(value) { assert.equal(value, app); return auth; } };
      if (request === "firebase-admin/firestore") return { getFirestore(value) { assert.equal(value, app); return db; } };
      if (request === "firebase-admin/storage") return { getStorage(value) {
        assert.equal(value, app); calls.storage++;
        return { bucket(name) { return { name, save() { calls.operations++; }, download() { calls.operations++; } }; } };
      } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { fn(require(filename), calls, auth, db); }
  finally {
    Module._load = originalLoad;
    delete require.cache[filename];
    if (previous) require.cache[filename] = previous;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
const demo = { MENRO_INTEGRATION_TEST: "true", NODE_ENV: "test", GCLOUD_PROJECT: "demo-menro-phase2",
  FIREBASE_PROJECT_ID: "demo-menro-phase2", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };

test("Auth and Firestore keep the same app/exports; Storage is lazy and absent by default", () => {
  initialize(demo, (firebase, calls, auth, db) => {
    assert.equal(firebase.auth, auth); assert.equal(firebase.db, db);
    assert.equal(calls.apps, 1); assert.equal(calls.options.projectId, "demo-menro-phase2");
    assert.equal(calls.storage, 0); assert.equal(calls.options.storageBucket, undefined);
    assert.throws(() => firebase.getStorageBucket(), /restricted/);
    assert.equal(calls.storage, 0); assert.equal(calls.operations, 0);
  });
});
test("Storage handle uses the existing app and only the explicit synthetic bucket; no object operations", () => {
  initialize({ ...demo, FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199",
    FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app" }, (firebase, calls) => {
    assert.equal(calls.storage, 0);
    assert.equal(firebase.getStorageBucket().name, "demo-menro-phase2.firebasestorage.app");
    assert.equal(calls.apps, 1); assert.equal(calls.operations, 0);
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = "public.example:9199";
    assert.throws(() => firebase.getStorageBucket(), /approved loopback Storage/);
    assert.equal(calls.storage, 1);
  });
});
test("production initialization remains compatible but cloud Storage client access stays blocked", () => {
  initialize({ NODE_ENV: "production", FIREBASE_PROJECT_ID: "menrosystem-ddfac",
    FIREBASE_CLIENT_EMAIL: "test-only@example.invalid", FIREBASE_PRIVATE_KEY: "test-only-mocked-key",
    FIREBASE_STORAGE_BUCKET: "menrosystem-ddfac.firebasestorage.app" }, (firebase, calls) => {
    assert.equal(calls.apps, 1); assert.ok(calls.options.credential);
    assert.equal(calls.options.storageBucket, "menrosystem-ddfac.firebasestorage.app");
    assert.throws(() => firebase.getStorageBucket(), /restricted/);
    assert.equal(calls.storage, 0); assert.equal(calls.operations, 0);
  });
});
test("approved production initialization reuses the exact Admin app and bucket without object I/O", () => {
  initialize({ NODE_ENV: "production", MENRO_GCS_PRODUCTION: "true",
    FIREBASE_PROJECT_ID: "menrosystem-ddfac",
    FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: "test-only-mocked-key",
    FIREBASE_STORAGE_BUCKET: "menrosystem-ddfac.firebasestorage.app",
    EVIDENCE_STORAGE_PROVIDER: "gcs", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true",
    EVIDENCE_CLOUD_READ_ENABLED: "true",
    EVIDENCE_GCS_PRODUCTION_APPROVAL: "AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION" }, (firebase, calls) => {
    assert.equal(calls.apps, 1); assert.ok(calls.options.credential);
    assert.equal(firebase.getStorageBucket().name, "menrosystem-ddfac.firebasestorage.app");
    assert.equal(calls.storage, 1); assert.equal(calls.operations, 0);
    process.env.FIREBASE_CLIENT_EMAIL = "wrong@example.invalid";
    assert.throws(() => firebase.getStorageBucket(), /identity/);
    assert.equal(calls.operations, 0);
  });
});
test('development GCS never gives real Storage credentials or a real bucket to Admin Auth/Firestore', () => {
  initialize(require('./helpers/developmentGcsFixture').developmentEnv(), (firebase, calls) => {
    assert.equal(calls.options.projectId, 'demo-menro-phase2');
    assert.equal(calls.options.credential, undefined); assert.equal(calls.options.storageBucket, undefined);
    assert.equal(calls.storage, 0); assert.equal(calls.operations, 0);
    assert.equal(typeof firebase.getStorageBucket, 'function');
    assert.equal(calls.dotenv, 0, 'must not load a real .env in opt-in development GCS mode');
  });
});
