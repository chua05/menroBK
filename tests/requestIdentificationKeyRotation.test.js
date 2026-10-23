const assert = require("node:assert/strict");
const test = require("node:test");

const collections = new Map();
let failNextCommit = false;

function rows(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

function ref(name, id) {
  return {
    name, id,
    async get() {
      const value = rows(name).get(id);
      return { id, exists: value !== undefined, data: () => value };
    },
  };
}

const db = {
  collection(name) {
    return {
      doc(id) { return ref(name, id); },
      orderBy() {
        let pageLimit = 50;
        let cursor = "";
        const query = {
          limit(value) { pageLimit = value; return query; },
          startAfter(value) { cursor = value; return query; },
          async get() {
            const docs = [...rows(name).entries()]
              .filter(([id]) => id > cursor)
              .sort(([left], [right]) => left.localeCompare(right))
              .slice(0, pageLimit)
              .map(([id, data]) => ({ id, data: () => data }));
            return { docs };
          },
        };
        return query;
      },
    };
  },
  async runTransaction(callback) {
    const writes = [];
    const result = await callback({
      get: (document) => document.get(),
      set(document, value) { writes.push([document, value]); },
    });
    if (failNextCommit) {
      failNextCommit = false;
      throw Object.assign(new Error("injected commit failure"), { code: "INJECTED_COMMIT_FAILURE" });
    }
    for (const [document, value] of writes) rows(document.name).set(document.id, value);
    return result;
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true, exports: { db, auth: {} },
};

const identification = require("../src/services/requestIdentification.service");
const {
  LEDGER_COLLECTION,
  createRequestIdentificationKeyMigration,
} = require("../src/services/requestIdentificationKeyMigration.service");
const migrationCli = require("../scripts/migrateRequestIdentificationKeys");

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

function legacyRecord(requestId, plaintext) {
  const encrypted = identification.encryptIdNumber(plaintext, legacyEnv, requestId);
  delete encrypted.keyId;
  return { requestId, participantId: "participant", ...encrypted };
}

test.beforeEach(() => {
  collections.clear();
  failNextCommit = false;
});

test("dual-key configuration reads unkeyed legacy records and writes only with the active key ID", () => {
  const record = legacyRecord("request-old", "ABC-123456");
  assert.equal(identification.decryptIdNumber(record, dualEnv), "ABC-123456");

  const created = identification.encryptIdNumber("NEW-987654", dualEnv, "request-new");
  assert.equal(created.keyId, "rotation-2026-01");
  assert.equal(identification.decryptIdNumber({ ...created, requestId: "request-new" }, dualEnv), "NEW-987654");
  assert.throws(
    () => identification.decryptIdNumber({ ...created, keyId: "unavailable", requestId: "request-new" }, dualEnv),
    (error) => error.code === "IDENTIFICATION_KEY_UNAVAILABLE",
  );
});

test("configuration fails closed for missing key pairs, invalid IDs, and ambiguous IDs", () => {
  assert.throws(() => identification.validateIdentificationEncryptionConfig({
    REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE: newKey,
  }), (error) => error.code === "IDENTIFICATION_ENCRYPTION_NOT_CONFIGURED");
  assert.throws(() => identification.validateIdentificationEncryptionConfig({
    ...dualEnv, REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE_ID: "contains spaces",
  }), (error) => error.code === "IDENTIFICATION_ENCRYPTION_NOT_CONFIGURED");
  assert.throws(() => identification.validateIdentificationEncryptionConfig({
    ...dualEnv, REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS_ID: "rotation-2026-01",
  }), (error) => error.code === "IDENTIFICATION_ENCRYPTION_NOT_CONFIGURED");
});

test("migration dry-run is inert; execute is resumable/idempotent and reconciliation verifies ciphertext", async () => {
  rows(identification.IDENTIFICATION_COLLECTION).set("request-1", legacyRecord("request-1", "ID-123456"));
  const migration = createRequestIdentificationKeyMigration({ db, env: dualEnv,
    clock: () => new Date("2026-10-23T00:00:00.000Z") });

  const dryRun = await migration.run({ mode: "dry-run", migrationId: "rotation-2026-01", limit: 10 });
  assert.deepEqual(dryRun.counts, { NEEDS_MIGRATION: 1 });
  assert.equal(rows(LEDGER_COLLECTION).size, 0);
  assert.equal(rows(identification.IDENTIFICATION_COLLECTION).get("request-1").keyId, undefined);

  const executed = await migration.run({ mode: "execute", migrationId: "rotation-2026-01", limit: 10 });
  assert.deepEqual(executed.counts, { MIGRATED: 1 });
  const migrated = rows(identification.IDENTIFICATION_COLLECTION).get("request-1");
  assert.equal(migrated.keyId, "rotation-2026-01");
  assert.equal(identification.decryptIdNumber(migrated, dualEnv), "ID-123456");

  const retry = await migration.run({ mode: "execute", migrationId: "rotation-2026-01", limit: 10 });
  assert.deepEqual(retry.counts, { ALREADY_MIGRATED: 1 });
  const reconciled = await migration.run({ mode: "reconcile", migrationId: "rotation-2026-01", limit: 10 });
  assert.deepEqual(reconciled.counts, { VERIFIED: 1 });
});

test("failed transaction leaves the source intact and a retry safely completes", async () => {
  const original = legacyRecord("request-retry", "RECOVERY-1234");
  rows(identification.IDENTIFICATION_COLLECTION).set("request-retry", original);
  const migration = createRequestIdentificationKeyMigration({ db, env: dualEnv });
  failNextCommit = true;
  const failed = await migration.run({ mode: "execute", migrationId: "rotation-retry", limit: 10 });
  assert.deepEqual(failed.counts, { INJECTED_COMMIT_FAILURE: 1 });
  assert.deepEqual(rows(identification.IDENTIFICATION_COLLECTION).get("request-retry"), original);
  assert.equal(rows(LEDGER_COLLECTION).size, 0);

  const recovered = await migration.run({ mode: "execute", migrationId: "rotation-retry", limit: 10 });
  assert.deepEqual(recovered.counts, { MIGRATED: 1 });
});

test("rollback requires an unchanged migrated envelope and restores legacy decryptability", async () => {
  rows(identification.IDENTIFICATION_COLLECTION).set("request-rollback",
    legacyRecord("request-rollback", "ROLLBACK-1234"));
  const migration = createRequestIdentificationKeyMigration({ db, env: dualEnv });
  await migration.run({ mode: "execute", migrationId: "rotation-rollback", limit: 10 });
  const rolledBack = await migration.run({ mode: "rollback", migrationId: "rotation-rollback", limit: 10 });
  assert.deepEqual(rolledBack.counts, { ROLLED_BACK: 1 });
  const restored = rows(identification.IDENTIFICATION_COLLECTION).get("request-rollback");
  assert.equal(restored.keyId, undefined);
  assert.equal(identification.decryptIdNumber(restored, dualEnv), "ROLLBACK-1234");
  const repeat = await migration.run({ mode: "rollback", migrationId: "rotation-rollback", limit: 10 });
  assert.deepEqual(repeat.counts, { ALREADY_ROLLED_BACK: 1 });
});

test("aggregate migration output contains neither plaintext nor key material", async () => {
  const plaintext = "DO-NOT-LOG-1234";
  rows(identification.IDENTIFICATION_COLLECTION).set("request-private",
    legacyRecord("request-private", plaintext));
  const migration = createRequestIdentificationKeyMigration({ db, env: dualEnv });
  const result = await migration.run({ mode: "execute", migrationId: "rotation-redaction", limit: 10 });
  const output = JSON.stringify(result);
  assert.equal(output.includes(plaintext), false);
  assert.equal(output.includes(oldKey), false);
  assert.equal(output.includes(newKey), false);
});

test("migration CLI rejects unknown/duplicate arguments and fails before Firebase without exact gates", async () => {
  assert.throws(() => migrationCli.parse([
    "--mode", "execute", "--migration-id", "rotation", "--unknown", "value",
  ]), /INVALID_IDENTIFICATION_MIGRATION_INVOCATION/);
  assert.throws(() => migrationCli.parse([
    "--mode", "execute", "--mode", "dry-run", "--migration-id", "rotation",
  ]), /INVALID_IDENTIFICATION_MIGRATION_INVOCATION/);
  await assert.rejects(
    migrationCli.main(["--mode", "dry-run", "--migration-id", "rotation"], {
      NODE_ENV: "production", FIREBASE_PROJECT_ID: "menrosystem-ddfac",
    }),
    /IDENTIFICATION_MIGRATION_PRODUCTION_APPROVAL_REQUIRED/,
  );
  await assert.rejects(
    migrationCli.main(["--mode", "rollback", "--migration-id", "rotation"], {
      NODE_ENV: "production", FIREBASE_PROJECT_ID: "menrosystem-ddfac",
      REQUEST_IDENTIFICATION_MIGRATION_ENABLED: "true",
      REQUEST_IDENTIFICATION_MIGRATION_APPROVAL: migrationCli.APPROVAL,
    }),
    /IDENTIFICATION_MIGRATION_PRODUCTION_APPROVAL_REQUIRED/,
  );
});
