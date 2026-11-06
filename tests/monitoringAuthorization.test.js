const assert = require("node:assert/strict");
const test = require("node:test");

const routes = require("../src/routes/monitoring.routes");

function route(path, method) {
  const layer = routes.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} is registered`);
  return layer.route.stack[1].handle;
}

function authorize(handler, role) {
  let next = false;
  const response = { statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  handler({ user: { uid: `${role}-actor`, role } }, response, () => { next = true; });
  return { next, response };
}

test("legacy and early monitoring creation and returned corrections are Staff-only", () => {
  for (const [path, method] of [["/", "post"], ["/early", "post"],
    ["/:monitoringId/observations/:observationId/resubmit", "patch"]]) {
    const handler = route(path, method);
    assert.equal(authorize(handler, "staff").next, true, `${method} ${path} allows Staff`);
    for (const role of ["participant", "admin"]) {
      const result = authorize(handler, role);
      assert.equal(result.next, false, `${method} ${path} denies ${role}`);
      assert.equal(result.response.statusCode, 403);
    }
  }
});

test("Participant historical monitoring read remains available and management reads remain role-scoped", () => {
  const participantRead = route("/my-records", "get");
  assert.equal(authorize(participantRead, "participant").next, true);
  assert.equal(authorize(participantRead, "staff").next, false);
  const managementRead = route("/", "get");
  assert.equal(authorize(managementRead, "staff").next, true);
  assert.equal(authorize(managementRead, "admin").next, true);
  assert.equal(authorize(managementRead, "participant").next, false);
});
