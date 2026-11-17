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

// Direct API requests: route-level role gates for monitoring writes.
function routeIn(router, path, method, guardIndex) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} is registered`);
  return layer.route.stack[guardIndex].handle;
}
function assertOnly(handler, allowed, label) {
  for (const role of ["participant", "staff", "admin"]) {
    const result = authorize(handler, role);
    assert.equal(result.next, allowed.includes(role), `${label} ${allowed.includes(role) ? "allows" : "denies"} ${role}`);
    if (!allowed.includes(role)) assert.equal(result.response.statusCode, 403);
  }
}

test("aggregate monitoring: Staff review/return/edit, Admin final decision, Staff or Admin archive", () => {
  for (const [path, method, allowed] of [
    ["/:monitoringId/observations/:observationId/review", "patch", ["staff"]],
    ["/:monitoringId/observations/:observationId/return", "patch", ["staff"]],
    ["/:monitoringId/observations/:observationId/approve", "patch", ["admin"]],
    ["/:monitoringId/observations/:observationId/reject", "patch", ["admin"]],
    ["/:id", "patch", ["staff"]],
    ["/:id/archive", "patch", ["staff", "admin"]],
  ]) assertOnly(route(path, method), allowed, `${method} ${path}`);
});

test("permanent-sample visits: only Staff create, save, submit or attach evidence; Admin only reviews", () => {
  const visits = require("../src/routes/sampleMonitoringVisit.routes");
  for (const [path, method, allowed] of [
    ["/cohorts/:cohortId/visits", "post", ["staff"]],
    ["/visits/:visitId", "put", ["staff"]],
    ["/visits/:visitId/samples/:sampleId/evidence", "put", ["staff"]],
    ["/visits/:visitId/review", "post", ["admin"]],
  ]) assertOnly(routeIn(visits, path, method, 1), allowed, `${method} ${path}`);
});

test("Requester Clarification requests are created only by Staff; Admin keeps read access", () => {
  const information = require("../src/routes/sampleMonitoringInformation.routes");
  assertOnly(routeIn(information, "/", "post", 0), ["staff"], "POST /sample-monitoring-information");
  assertOnly(routeIn(information, "/:requestId/answer", "post", 0), ["participant"], "POST answer");
  assert.equal(information.stack.some(item => item.route?.path === "/" && item.route.methods.get), true);
});
