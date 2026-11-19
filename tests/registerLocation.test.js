const test = require("node:test");
const assert = require("node:assert/strict");

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const calls = { createUser: [], created: [], deleted: [] };
const fakeDb = {
  collection: () => ({ doc: (id) => ({ id }) }),
  runTransaction: async (fn) => fn({ create: (ref, data) => calls.created.push({ ref, data }) }),
};
stub("../src/config/firebase", {
  auth: {
    createUser: async (input) => { calls.createUser.push(input); return { uid: "uid-1" }; },
    deleteUser: async (uid) => calls.deleted.push(uid),
  },
  db: fakeDb,
});
stub("../src/utils/recordNumber.util", { nextRecordNumber: async () => "USR-2026-001" });
stub("../src/services/email.service", {
  sendRegistrationEmails: async () => ({ sent: true }),
  sendVerificationEmail: async () => ({}),
});

const { registerUser, resolveRegistrationLocation } = require("../src/services/auth.service");

const MESSAGE = "Please select Bulan, Sorsogon as your registration location.";
const base = {
  fullName: "Ana Cruz", username: "ana", email: "ana@example.com",
  contactNumber: "09123456789", password: "secret12", userType: "Student / School Representative",
  userTypeDetail: "Bulan National High School",
};

test.beforeEach(() => { calls.createUser.length = 0; calls.created.length = 0; calls.deleted.length = 0; });

test("helper defaults missing or empty values", () => {
  const expected = { province: "Sorsogon", municipality: "Bulan" };
  assert.deepEqual(resolveRegistrationLocation({}), expected);
  assert.deepEqual(resolveRegistrationLocation(), expected);
  assert.deepEqual(resolveRegistrationLocation({ province: "", municipality: "  " }), expected);
  assert.deepEqual(resolveRegistrationLocation({ province: null, municipality: undefined }), expected);
});

test("helper accepts trimmed, case-insensitive values and returns canonical", () => {
  assert.deepEqual(
    resolveRegistrationLocation({ province: " sorsogon ", municipality: "BULAN" }),
    { province: "Sorsogon", municipality: "Bulan" }
  );
});

test("helper rejects other provinces, municipalities and non-strings", () => {
  assert.throws(() => resolveRegistrationLocation({ province: "Albay", municipality: "Bulan" }), { message: MESSAGE });
  assert.throws(() => resolveRegistrationLocation({ province: "Sorsogon", municipality: "Gubat" }), { message: MESSAGE });
  assert.throws(() => resolveRegistrationLocation({ province: 5 }), { message: MESSAGE });
});

test("registerUser persists canonical location", async () => {
  const user = await registerUser({ ...base, province: " sorsogon", municipality: "bulan " });
  assert.equal(user.province, "Sorsogon");
  assert.equal(user.municipality, "Bulan");
  assert.equal(calls.created[0].data.province, "Sorsogon");
  assert.equal(calls.created[0].data.municipality, "Bulan");
});

test("registerUser defaults location when omitted", async () => {
  await registerUser(base);
  assert.equal(calls.created[0].data.province, "Sorsogon");
  assert.equal(calls.created[0].data.municipality, "Bulan");
});

test("registerUser rejects invalid location before creating auth user", async () => {
  await assert.rejects(registerUser({ ...base, province: "Albay" }), { message: MESSAGE });
  assert.equal(calls.createUser.length, 0);
  assert.equal(calls.created.length, 0);
});
