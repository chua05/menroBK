const test = require("node:test");
const assert = require("node:assert/strict");

const controllerPath = require.resolve("../src/controller/auth.controller");
const middlewarePath = require.resolve("../src/middleware/auth.middleware");
const rolePath = require.resolve("../src/middleware/role.middleware");
const limiterPath = require.resolve("../src/middleware/rateLimiter.middleware");

const handler = (_req, _res, next) => next?.();

require.cache[controllerPath] = {
  id: controllerPath,
  filename: controllerPath,
  loaded: true,
  exports: {
    register: handler,
    verifyUser: handler,
    getProfile: handler,
    updateProfile: handler,
  },
};
require.cache[middlewarePath] = {
  id: middlewarePath,
  filename: middlewarePath,
  loaded: true,
  exports: { verifyToken: handler, verifyTokenForBootstrap: handler },
};
require.cache[rolePath] = {
  id: rolePath,
  filename: rolePath,
  loaded: true,
  exports: { authorizeRoles: () => handler },
};
require.cache[limiterPath] = {
  id: limiterPath,
  filename: limiterPath,
  loaded: true,
  exports: { authLimiter: handler },
};

const authRoutes = require("../src/routes/auth.routes");

const hasRoute = (method, path) => authRoutes.stack.some(
  (layer) => layer.route?.path === path && layer.route.methods[method]
);

test("authentication routes expose verify, me, and profile operations", () => {
  assert.equal(hasRoute("post", "/verify"), true);
  assert.equal(hasRoute("get", "/me"), true);
  assert.equal(hasRoute("get", "/profile"), true);
  assert.equal(hasRoute("put", "/profile"), true);
});

test("verify and profile routes retain authentication middleware", () => {
  for (const [method, path] of [
    ["post", "/verify"],
    ["get", "/me"],
    ["get", "/profile"],
    ["put", "/profile"],
  ]) {
    const route = authRoutes.stack.find(
      (layer) => layer.route?.path === path && layer.route.methods[method]
    );
    assert.ok(route);
    assert.ok(route.route.stack.length >= 2);
  }
});
