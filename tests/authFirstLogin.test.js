// /auth/verify reports whether this sign-in is the account's first one, from stored account data only:
// a profile created by this request, or a registered profile whose lastLoginAt is still null. A profile
// with no recorded lastLoginAt (older accounts) is treated as returning; nothing is guessed.
const test = require("node:test");
const assert = require("node:assert/strict");

const firebasePath = require.resolve("../src/config/firebase");
const recordNumberPath = require.resolve("../src/utils/recordNumber.util");
const emailPath = require.resolve("../src/services/email.service");

const writes = [];
const docs = new Map();
const ref = (uid) => ({
  id: uid,
  get: async () => ({ exists: docs.has(uid), id: uid, data: () => docs.get(uid) }),
  update: async (data) => { writes.push({ uid, op: "update", data }); docs.set(uid, { ...docs.get(uid), ...data }); },
});
const db = {
  collection: () => ({ doc: ref }),
  runTransaction: async (fn) => fn({
    get: async (target) => target.get(),
    create: (target, data) => { writes.push({ uid: target.id, op: "create", data }); docs.set(target.id, data); },
  }),
};
const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };
stub(firebasePath, { auth: {}, db });
stub(recordNumberPath, { nextRecordNumber: async () => "USR-2026-0001" });
stub(emailPath, { sendRegistrationEmails: async () => {}, sendVerificationEmail: async () => {} });

const { createUserProfile } = require("../src/services/auth.service");

test.beforeEach(() => { writes.length = 0; docs.clear(); });

test("a profile created by this sign-in is a first login", async () => {
  const profile = await createUserProfile({ uid: "new-user", email: "new@example.com", name: "New User" }, { existingProfile: null });
  assert.equal(profile.firstLogin, true);
  assert.equal(writes[0].op, "create");
  assert.equal("firstLogin" in writes[0].data, false, "the flag is reported, never stored");
});

test("a registered account that has never signed in (lastLoginAt null) is a first login", async () => {
  docs.set("registered", { uid: "registered", role: "participant", lastLoginAt: null });
  const profile = await createUserProfile({ uid: "registered" }, { existingProfile: { uid: "registered", role: "participant", lastLoginAt: null } });
  assert.equal(profile.firstLogin, true);
  assert.ok(writes[0].data.lastLoginAt instanceof Date);
  assert.equal("firstLogin" in writes[0].data, false);
});

test("an account that signed in before is a returning login", async () => {
  const lastLoginAt = new Date("2026-11-01T00:00:00Z");
  docs.set("returning", { uid: "returning", lastLoginAt });
  const profile = await createUserProfile({ uid: "returning" }, { existingProfile: { uid: "returning", lastLoginAt } });
  assert.equal(profile.firstLogin, false);
});

test("an older account with no recorded lastLoginAt is treated as returning, not guessed as new", async () => {
  docs.set("legacy", { uid: "legacy" });
  const profile = await createUserProfile({ uid: "legacy" }, { existingProfile: { uid: "legacy" } });
  assert.equal(profile.firstLogin, false);
});
