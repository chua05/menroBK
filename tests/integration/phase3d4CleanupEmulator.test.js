const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");
assert.equal(process.env.MENRO_PHASE3C_ISOLATED_EMULATORS, "true");
const integration = validateIntegrationEnvironment();
assert.equal(integration.projectId, "demo-menro-phase3c-isolated");
const prefix = process.env.MENRO_PHASE3D4_CLEANUP_PREFIX;
assert.match(prefix || "", /^phase3c-browser-[0-9a-f-]{36}$/);
const { auth, db, getStorageBucket } = require("../../src/config/firebase");
const { cleanupFixture } = require("./phase3cBrowserFixtureCleanup");

test("repeated fixture cleanup preserves independently owned Auth, Firestore and Storage sentinels", async () => {
  const owner = `phase3d4-sentinel-${randomUUID()}`;
  const ref = db.collection("notifications").doc(owner);
  const file = getStorageBucket().file(`test-only/phase3d4-cleanup/${owner}`);
  try {
    await auth.createUser({ uid: owner });
    await ref.create({ recipientUserId: owner, testFixture: owner, relatedRecordType: "cleanupSentinel", relatedRecordId: owner });
    await file.save(Buffer.from("UUID-owned cleanup sentinel"), { metadata: { metadata: { testFixture: owner } } });
    for (let pass = 0; pass < 2; pass++) {
      const result = await cleanupFixture(prefix);
      assert.equal(result.verified, true);
      assert.equal(result.usersRemoved, 0);
      assert.equal(result.recordsRemoved, 0);
      assert.equal(result.objectsRemoved, 0);
      assert.equal((await auth.getUser(owner)).uid, owner);
      assert.equal((await ref.get()).data().testFixture, owner);
      assert.equal((await file.exists())[0], true);
    }
  } finally {
    const doc = await ref.get();
    if (doc.exists) { assert.equal(doc.data().testFixture, owner); await ref.delete(); }
    if ((await file.exists())[0]) {
      assert.equal((await file.getMetadata())[0].metadata.testFixture, owner);
      await file.delete();
    }
    await auth.deleteUser(owner).catch(error => { if (error.code !== "auth/user-not-found") throw error; });
  }
});
