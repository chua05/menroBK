const assert = require("node:assert/strict");
const test = require("node:test");

const routes = require("../src/routes/analytics.routes");

test("map tree markers are a Staff/Admin read behind token verification", () => {
  const layer = routes.stack.find((item) => item.route?.path === "/map-trees" && item.route.methods.get);
  assert.ok(layer, "GET /map-trees is registered");
  const [verify, authorize] = layer.route.stack.map((entry) => entry.handle);
  assert.equal(verify.name, "verifyToken");
  for (const [role, allowed] of [["staff", true], ["admin", true], ["participant", false], ["guest", false]]) {
    let next = false;
    const response = { statusCode: null, status(code) { this.statusCode = code; return this; }, json() { return this; } };
    authorize({ user: { uid: `${role}-actor`, role } }, response, () => { next = true; });
    assert.equal(next, allowed, `${role} ${allowed ? "allowed" : "denied"}`);
    if (!allowed) assert.equal(response.statusCode, 403);
  }
});
