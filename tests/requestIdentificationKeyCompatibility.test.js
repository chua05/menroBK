const assert = require("node:assert/strict");
const test = require("node:test");

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: { db: {}, auth: {} },
};

const identification = require("../src/services/requestIdentification.service");

const oldKey = Buffer.alloc(32, 17).toString("base64");
const newKey = Buffer.alloc(32, 29).toString("base64");
const legacyEnv = { REQUEST_IDENTIFICATION_ENCRYPTION_KEY: oldKey };
const dualEnv = {
  REQUEST_IDENTIFICATION_ENCRYPTION_KEY: oldKey,
  REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE: newKey,
  REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE_ID: "rotation-2026-01",
  REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS: oldKey,
  REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS_ID: "legacy-v1",
};

test("existing single-key configuration remains valid and labels new records legacy-v1", () => {
  assert.equal(identification.validateIdentificationEncryptionConfig(legacyEnv), true);
  const encrypted = identification.encryptIdNumber("SYNTHETIC-1234", legacyEnv, "request-legacy");
  assert.equal(encrypted.keyId, "legacy-v1");
  assert.equal(identification.decryptIdNumber({ ...encrypted, requestId: "request-legacy" }, legacyEnv),
    "SYNTHETIC-1234");
});

test("unkeyed existing records remain decryptable after dual-key configuration", () => {
  const encrypted = identification.encryptIdNumber("SYNTHETIC-2345", legacyEnv, "request-old");
  delete encrypted.keyId;
  assert.equal(identification.decryptIdNumber({ ...encrypted, requestId: "request-old" }, dualEnv),
    "SYNTHETIC-2345");
});

test("new encryption uses only the active key ID and exact-key decryption", () => {
  const encrypted = identification.encryptIdNumber("SYNTHETIC-3456", dualEnv, "request-new");
  assert.equal(encrypted.keyId, "rotation-2026-01");
  assert.equal(identification.decryptIdNumber({ ...encrypted, requestId: "request-new" }, dualEnv),
    "SYNTHETIC-3456");
  assert.throws(
    () => identification.decryptIdNumber({ ...encrypted, keyId: "unknown", requestId: "request-new" }, dualEnv),
    (error) => error.code === "IDENTIFICATION_KEY_UNAVAILABLE",
  );
});

test("missing and invalid key configurations fail closed", () => {
  assert.throws(() => identification.validateIdentificationEncryptionConfig({}),
    (error) => error.code === "IDENTIFICATION_ENCRYPTION_NOT_CONFIGURED");
  assert.throws(() => identification.validateIdentificationEncryptionConfig({
    REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE: newKey,
  }), (error) => error.code === "IDENTIFICATION_ENCRYPTION_NOT_CONFIGURED");
  assert.throws(() => identification.validateIdentificationEncryptionConfig({
    ...dualEnv,
    REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE_ID: "invalid key id",
  }), (error) => error.code === "IDENTIFICATION_ENCRYPTION_NOT_CONFIGURED");
  assert.throws(() => identification.validateIdentificationEncryptionConfig({
    ...dualEnv,
    REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS_ID: "rotation-2026-01",
  }), (error) => error.code === "IDENTIFICATION_ENCRYPTION_NOT_CONFIGURED");
});

test("errors and exported configuration contain no key or plaintext material", () => {
  const plaintext = "SYNTHETIC-DO-NOT-LOG";
  const encrypted = identification.encryptIdNumber(plaintext, dualEnv, "request-redaction");
  const serialized = JSON.stringify({
    activeId: encrypted.keyId,
    failure: (() => {
      try {
        identification.decryptIdNumber({ ...encrypted, keyId: "missing", requestId: "request-redaction" }, dualEnv);
      } catch (error) {
        return { code: error.code, message: error.message };
      }
      return null;
    })(),
  });
  assert.equal(serialized.includes(plaintext), false);
  assert.equal(serialized.includes(oldKey), false);
  assert.equal(serialized.includes(newKey), false);
});
