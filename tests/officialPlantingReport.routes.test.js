const test = require("node:test"), assert = require("node:assert/strict"), express = require("express");
const { queryMemory } = require("./helpers/queryMemory");
const memory = queryMemory();
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: memory.db } };
const identities = { staff: { uid: "verified-staff", fullName: "Authenticated Staff", role: "staff" }, admin: { uid: "verified-admin", role: "admin" }, participant: { uid: "verified-participant", role: "participant" } };
const authPath = require.resolve("../src/middleware/auth.middleware");
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { verifyToken(req, res, next) {
  const user = identities[String(req.headers.authorization || "").replace(/^Bearer /, "")];
  if (!user) return res.status(401).json({ success: false, message: "Unauthorized" }); req.user = user; next();
} } };
const service = require("../src/services/officialPlantingReport.service"), calls = [];
const list = service.listReleasedOptions;
service.listReleasedOptions = (user, query) => { calls.push({ user, query }); return list(user, query); };
const app = express(); app.use(express.json()); app.use("/api/planting-reports", require("../src/routes/plantingReport.routes"));
let server, base;
test.before(async () => { server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}/api/planting-reports`; });
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const request = (role, path = "/official/options", options = {}) => fetch(`${base}${path}`, { ...options, headers: { ...(role ? { Authorization: `Bearer ${role}` } : {}), ...options.headers } });
test("real Express Staff options forwards canonical identity, returns bounded metadata and no private data", async () => {
  const response = await request("staff"); assert.equal(response.status, 200); const body = await response.json();
  assert.deepEqual(body, { success: true, data: { options: [], nextCursor: null } });
  assert.equal(calls.at(-1).user.uid, "verified-staff"); assert.equal(calls.at(-1).user.role, "staff");
  assert.equal(memory.queries.at(-1).max, 51);
  assert.doesNotMatch(JSON.stringify(body), /privateEvidence|objectName|attendanceIntent/);
});
test("real authorization denies unauthenticated, Participant and Admin creation before service/database access", async () => {
  const before = calls.length, queries = memory.queries.length;
  for (const [role, expected] of [[null, 401], ["participant", 403], ["admin", 403]]) {
    assert.equal((await request(role)).status, expected);
    assert.equal((await request(role, "/official", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, expected);
  }
  assert.equal(calls.length, before); assert.equal(memory.queries.length, queries);
});
test("invalid cursor and overposted client identity follow real controller validation", async () => {
  assert.equal((await request("staff", "/official/options?cursor=..%2Funknown")).status, 400);
  const response = await request("staff", "/official", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ staffName: "spoof", uid: "other" }) });
  assert.equal(response.status, 400); assert.match((await response.json()).message, /Unsupported/);
});
test("attendance maintenance and role guards execute before multipart/storage access", async () => {
  const prior = process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED; process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED = "true";
  try {
    assert.equal((await request("participant", "/official/unknown/attendance", { method: "PUT" })).status, 403);
    assert.equal((await request("staff", "/official/unknown/attendance", { method: "PUT" })).status, 503);
    assert.equal((await request(null, "/official/unknown/attendance")).status, 401);
    assert.equal((await request("participant", "/official/unknown/attendance")).status, 403);
  } finally { if (prior === undefined) delete process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED; else process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED = prior; }
});
