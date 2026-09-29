const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

let decodedToken;
let userProfile;
const originalLoad = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (parent?.filename?.endsWith("auth.middleware.js")) {
    if (request === "../config/firebase") {
      return {
        auth: {
          verifyIdToken: async (token) => {
            if (token === "invalid") throw new Error("Invalid Firebase token");
            return decodedToken;
          },
        },
      };
    }
    if (request === "../services/user.service") {
      return { getUserByUid: async () => userProfile };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { verifyToken, verifyTokenForBootstrap } = require("../src/middleware/auth.middleware");
Module._load = originalLoad;

function makeToken(overrides = {}) {
  return {
    uid: "user-1",
    email: "person@example.com",
    email_verified: false,
    firebase: { sign_in_provider: "password" },
    ...overrides,
  };
}

function makeProfile(overrides = {}) {
  return { uid: "user-1", role: "participant", status: "active", ...overrides };
}

async function invoke(middleware, token = "valid") {
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: { role: "admin" },
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test("verified active participant is authorized", async () => {
  decodedToken = makeToken({ email_verified: true });
  userProfile = makeProfile();
  const result = await invoke(verifyToken);
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.user.role, "participant");
});

test("unverified active participant is blocked with the verification message", async () => {
  decodedToken = makeToken();
  userProfile = makeProfile();
  const result = await invoke(verifyToken);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body.message, "Please verify your email address before continuing.");
  assert.equal(result.nextCalled, false);
});

test("active admin and staff profiles can use unverified password accounts", async () => {
  decodedToken = makeToken();
  for (const role of ["admin", "staff"]) {
    userProfile = makeProfile({ role });
    const result = await invoke(verifyToken);
    assert.equal(result.nextCalled, true);
    assert.equal(result.req.user.role, role);
  }
});

test("client-provided privileged role cannot exempt a participant profile", async () => {
  decodedToken = makeToken({ role: "admin" });
  userProfile = makeProfile({ role: "participant" });
  const result = await invoke(verifyToken);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.nextCalled, false);
});

test("Google-authenticated active participant is not blocked by the password verification rule", async () => {
  decodedToken = makeToken({ firebase: { sign_in_provider: "google.com" } });
  userProfile = makeProfile();
  const result = await invoke(verifyToken);
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.user.role, "participant");
});

test("inactive privileged profile is denied", async () => {
  decodedToken = makeToken();
  userProfile = makeProfile({ role: "staff", status: "inactive" });
  const result = await invoke(verifyToken);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body.message, "User account is inactive.");
  assert.equal(result.nextCalled, false);
});

test("bootstrap requires verification for a new password account but allows Google", async () => {
  userProfile = null;
  decodedToken = makeToken();
  const passwordResult = await invoke(verifyTokenForBootstrap);
  assert.equal(passwordResult.res.statusCode, 403);
  assert.equal(passwordResult.res.body.message, "Please verify your email address before continuing.");

  decodedToken = makeToken({ firebase: { sign_in_provider: "google.com" } });
  const googleResult = await invoke(verifyTokenForBootstrap);
  assert.equal(googleResult.nextCalled, true);
});

test("bootstrap only exempts an existing active admin or staff profile", async () => {
  decodedToken = makeToken();
  for (const role of ["admin", "staff"]) {
    userProfile = makeProfile({ role });
    const result = await invoke(verifyTokenForBootstrap);
    assert.equal(result.nextCalled, true);
  }
});

test("missing and invalid Firebase ID tokens are rejected", async () => {
  decodedToken = makeToken({ email_verified: true });
  userProfile = makeProfile();
  const missing = await invoke(verifyToken, "");
  assert.equal(missing.res.statusCode, 401);
  assert.equal(missing.nextCalled, false);

  const invalid = await invoke(verifyToken, "invalid");
  assert.equal(invalid.res.statusCode, 401);
  assert.equal(invalid.res.body.message, "Invalid token");
  assert.equal(invalid.nextCalled, false);
});