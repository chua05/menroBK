// B2: readiness cursor pagination, global gate booleans and FIRST_VISIT_POLICY_DISABLED (real service, controller and routes).
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const tables = new Map();
const table = name => tables.get(name) || (tables.set(name, new Map()), tables.get(name));
const cohortQueries = [];
// Query double with Firestore's documented constraints: document IDs order by code unit, startAfter needs an order,
// "in" takes 1-30 values. Anything else throws.
function query(name, state = { filters: [], order: false, after: null, max: Infinity }) {
  const next = change => query(name, { ...state, ...change });
  const snap = (id, row) => ({ id, exists: row !== undefined, data: () => row });
  return {
    doc: id => ({ id, get: async () => snap(id, table(name).get(id)) }),
    where(field, op, value) {
      if (!["==", "in"].includes(op) || (op === "in" && (!Array.isArray(value) || !value.length || value.length > 30))) throw Error(`Unsupported filter ${op}`);
      return next({ filters: [...state.filters, [field, op, value]] });
    },
    orderBy(field, direction = "asc") { assert.deepEqual([field, direction], ["__name__", "asc"]); return next({ order: true }); },
    startAfter(id) { if (!state.order || typeof id !== "string") throw Error("startAfter needs a document ID order"); return next({ after: id }); },
    limit: max => next({ max }),
    async get() {
      if (name === "verifiedPlantingCohorts") cohortQueries.push(state);
      const rows = [...table(name)].filter(([id, row]) => state.filters.every(([field, op, value]) => {
        const actual = field === "__name__" ? id : row[field];
        return op === "in" ? value.includes(actual) : actual === value;
      })).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).filter(([id]) => state.after === null || id > state.after);
      return { docs: rows.slice(0, state.max).map(([id, row]) => snap(id, row)) };
    },
  };
}
const mock = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
mock("../src/config/firebase", { db: { collection: name => query(name) } });
mock("../src/middleware/auth.middleware", { verifyToken: (req, res, next) => { const role = req.get("x-role"); if (!role) return res.status(401).json({}); req.user = { uid: req.get("x-uid") || "staff", role }; next(); } });
const service = require("../src/services/sampleMonitoringVisit.service");
const routes = require("../src/routes/sampleMonitoringVisit.routes");

const FLAGS = ["VERIFIED_PLANTING_COHORT_ENABLED", "PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED", "PERMANENT_SAMPLE_SCHEDULE_ENABLED", "PERMANENT_SAMPLE_WRITE_PAUSED",
  "PERMANENT_SAMPLE_PILOT_ENABLED", "PERMANENT_SAMPLE_PILOT_USER_IDS", "PERMANENT_SAMPLE_PILOT_COHORT_IDS"];
const clear = () => FLAGS.forEach(name => delete process.env[name]);
test.beforeEach(() => { tables.clear(); cohortQueries.length = 0; clear(); process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true"; });
test.after(clear);

const cohortId = n => `VPC-${String(n).padStart(3, "0")}`;
const cohort = (n, extra = {}) => ({ source: { plantingReportId: `report-${n}`, siteId: "site", plantingDate: "2026-10-01", requestId: "PRIVATE-REQUEST", species: [{ species: "Narra", verifiedPlantedQuantity: 10 }] },
  verifiedPlantedQuantity: 10, baselineVersion: 0, baseline: null, ...extra });
function seed(count) {
  table("sites").set("site", { siteName: "Site", status: "active", createdBy: "PRIVATE-STAFF" });
  // Inserted in reverse so a result in ID order can only come from the query's order.
  for (let n = count; n >= 1; n--) {
    table("verifiedPlantingCohorts").set(cohortId(n), cohort(n));
    table("plantingReports").set(`report-${n}`, { reportNumber: `RPT-${n}`, verificationStatus: "Approved", quantityPlanted: 10, siteId: "site", requesterName: "PRIVATE-REQUESTER" });
  }
}
const ask = input => service.readiness({ actorId: "staff", actorRole: "staff", ...input });
async function allPages(input = {}) {
  const pages = []; let cursor;
  do { const page = await ask({ ...input, ...(cursor ? { cursor } : {}) }); pages.push(page); cursor = page.nextCursor; assert.ok(pages.length < 20, "pagination must end"); } while (cursor);
  return pages;
}
const ids = page => page.cohorts.map(row => row.cohortId);

for (const [count, sizes] of [[0, [0]], [25, [25]], [26, [25, 1]], [51, [25, 25, 1]]]) {
  test(`${count} cohorts page as ${sizes.join("/")} in document ID order without gaps or duplicates`, async () => {
    seed(count);
    const pages = await allPages();
    assert.deepEqual(pages.map(page => page.cohorts.length), sizes);
    assert.deepEqual(pages.flatMap(ids), Array.from({ length: count }, (_, i) => cohortId(i + 1)));
    for (const [index, page] of pages.entries()) {
      const last = index === pages.length - 1;
      assert.equal(page.nextCursor, last ? null : ids(page).at(-1));
      assert.equal(page.truncated, !last);
      assert.deepEqual([...page.eligible, ...page.notEligible].map(row => row.cohortId).sort(), ids(page));
    }
  });
}

test("an explicit limit bounds each page and the cursor stays valid when its cohort no longer exists", async () => {
  seed(7);
  assert.deepEqual((await allPages({ limit: 3 })).map(ids), [[1, 2, 3], [4, 5, 6], [7]].map(page => page.map(cohortId)));
  assert.deepEqual((await allPages({ limit: "7" })).map(page => page.cohorts.length), [7]);
  table("verifiedPlantingCohorts").delete(cohortId(3));
  assert.deepEqual(ids(await ask({ limit: 3, cursor: cohortId(3) })), [4, 5, 6].map(cohortId));
  assert.ok(cohortQueries.every(state => state.max <= 26));
});

const INVALID = [{ limit: "0" }, { limit: "26" }, { limit: "-1" }, { limit: "1.5" }, { limit: "1e1" }, { limit: " 5" }, { limit: "abc" }, { limit: "" }, { limit: 0 }, { limit: 26 }, { limit: 2.5 }, { limit: ["5", "6"] }, { limit: null },
  { cursor: "" }, { cursor: "a/b" }, { cursor: "a b" }, { cursor: "__reserved__" }, { cursor: "____" }, { cursor: "x".repeat(201) }, { cursor: ["a"] }, { cursor: { a: "b" } }, { cursor: null }, { cursor: 5 }];
test("invalid limit or cursor is refused with INVALID_READINESS_QUERY before any read", async () => {
  seed(2);
  for (const input of INVALID) await assert.rejects(ask(input), error => error.status === 400 && error.code === "INVALID_READINESS_QUERY", JSON.stringify(input));
  assert.equal(cohortQueries.length, 0);
  assert.equal((await ask({ limit: 25, cursor: "x".repeat(200) })).cohorts.length, 0);
});

const pilotEnv = (cohortIds, users = ["staff"]) => Object.assign(process.env, { PERMANENT_SAMPLE_PILOT_ENABLED: "true",
  PERMANENT_SAMPLE_PILOT_USER_IDS: JSON.stringify(users), PERMANENT_SAMPLE_PILOT_COHORT_IDS: JSON.stringify(cohortIds) });
test("pilot mode pages only the allowed cohorts, in order, across cursors that skip missing or excluded cohorts", async () => {
  seed(30);
  const allowed = [29, 3, 11, 12, 20].map(cohortId);
  pilotEnv([...allowed, "VPC-000-missing"]);
  const pages = await allPages({ limit: 2 });
  assert.deepEqual(pages.map(ids), [[3, 11], [12, 20], [29]].map(page => page.map(cohortId)));
  assert.deepEqual(pages.map(page => page.truncated), [true, true, false]);
  // An excluded cohort's ID is only a position: it reveals nothing and returns only allowed cohorts after it.
  assert.deepEqual(ids(await ask({ cursor: cohortId(15) })), [20, 29].map(cohortId));
  assert.deepEqual(ids(await ask({ cursor: cohortId(29) })), []);
  for (const state of cohortQueries) assert.ok(state.filters.length === 1 && state.filters[0][0] === "__name__" && state.filters[0][2].every(id => allowed.includes(id) || id === "VPC-000-missing"));
  assert.equal(pages[0].gates.pilotRestricted, true);
  await assert.rejects(ask({ actorId: "other" }), error => error.status === 403);
  await assert.rejects(ask({ actorId: "other", limit: "bad" }), error => error.status === 403);
});

test("participants are refused whatever the query is", async () => {
  seed(1);
  for (const input of [{}, { limit: "bad" }, { cursor: cohortId(1) }]) {
    await assert.rejects(ask({ ...input, actorRole: "participant" }), error => error.status === 403);
  }
  assert.equal(cohortQueries.length, 0);
});

test("gates report paused, first-visit, schedule and pilot state as booleans only, even with no cohort", async () => {
  const gates = async env => { clear(); Object.assign(process.env, { VERIFIED_PLANTING_COHORT_ENABLED: "true" }, env); return (await ask()).gates; };
  const off = { writesPaused: false, firstVisitBaselineEnabled: false, scheduleEnabled: false, pilotRestricted: false };
  assert.deepEqual(await gates({}), off);
  assert.deepEqual(await gates({ PERMANENT_SAMPLE_WRITE_PAUSED: "true" }), { ...off, writesPaused: true });
  assert.deepEqual(await gates({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "true" }), { ...off, firstVisitBaselineEnabled: true });
  assert.deepEqual(await gates({ PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" }), { ...off, scheduleEnabled: true });
  assert.deepEqual(await gates({ PERMANENT_SAMPLE_PILOT_ENABLED: "true", PERMANENT_SAMPLE_PILOT_USER_IDS: '["staff"]', PERMANENT_SAMPLE_PILOT_COHORT_IDS: '["VPC-none"]' }), { ...off, pilotRestricted: true });
});

test("a malformed first-visit or schedule flag fails closed instead of reporting a gate, with or without cohorts", async () => {
  for (const [name, code] of [["PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED", "PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_CONFIGURATION_INVALID"],
    ["PERMANENT_SAMPLE_SCHEDULE_ENABLED", "PERMANENT_SAMPLE_SCHEDULE_CONFIGURATION_INVALID"]]) {
    for (const count of [0, 1]) {
      tables.clear(); seed(count); clear(); process.env[name] = "yes";
      await assert.rejects(ask(), error => error.status === 503 && error.code === code);
    }
  }
});

test("FIRST_VISIT_POLICY_DISABLED appears only for a cohort with no plan and no baseline while the flag is off", async () => {
  seed(4);
  const set = (n, extra) => table("verifiedPlantingCohorts").set(cohortId(n), cohort(n, extra));
  set(2, { samplingPlan: { status: "DRAFT", origin: "FIRST_VISIT" } });
  set(3, { baseline: { approvalStatus: "REGISTERED" } });
  set(4, { samplingPlan: { status: "APPROVED", selectedSamples: [] }, baseline: { approvalStatus: "APPROVED" } });
  const codes = page => page.cohorts.map(row => row.reasons.map(reason => reason.code));
  const off = codes(await ask());
  assert.deepEqual(off[0], ["SAMPLING_PLAN_NOT_APPROVED", "BASELINE_NOT_APPROVED", "FIRST_VISIT_POLICY_DISABLED", "VISIT_SCHEDULING_POLICY_PENDING"]);
  for (const index of [1, 2, 3]) assert.ok(!off[index].includes("FIRST_VISIT_POLICY_DISABLED"));
  process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED = "true";
  for (const row of codes(await ask())) assert.ok(!row.includes("FIRST_VISIT_POLICY_DISABLED"));
});

test("a conflicting report policy is reported as POLICY_CONFLICT and a matching nested policy is eligible", async () => {
  seed(2);
  Object.assign(process.env, { PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "true", PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" });
  table("plantingReports").get("report-1").reportingPolicy = { monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "NONE" } };
  table("plantingReports").get("report-2").reportingPolicy = { definition: { monitoring: "PERMANENT_SAMPLE" } };
  const page = await ask();
  assert.deepEqual(page.cohorts[0].reasons.find(reason => reason.code === "REPORT_NOT_ELIGIBLE").problems, ["POLICY_CONFLICT"]);
  assert.deepEqual(page.eligible.map(row => row.cohortId), [cohortId(2)]);
});

test("every earlier response key is kept and no private field is added", async () => {
  seed(26);
  const page = await ask();
  assert.deepEqual(Object.keys(page).sort(), ["cohorts", "eligible", "gates", "nextCursor", "notEligible", "schedulePolicy", "schedulingPolicyStatus", "truncated", "visitCreationAvailable"]);
  assert.deepEqual(Object.keys(page.gates).sort(), ["firstVisitBaselineEnabled", "pilotRestricted", "scheduleEnabled", "writesPaused"]);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE|createdBy|requesterName|requestId/);
});

test("HTTP: the controller passes limit and cursor and returns stable status codes", async () => {
  seed(3);
  const app = express(); app.use(routes);
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  // A starved test process can outlast Node's 5 s idle limit; the reused connection then fails with ECONNRESET.
  server.keepAliveTimeout = 0;
  const get = async (suffix, headers = { "x-role": "staff" }) => { const response = await fetch(`http://127.0.0.1:${server.address().port}/readiness${suffix}`, { headers }); return { status: response.status, body: await response.json() }; };
  try {
    const first = await get("?limit=2");
    assert.equal(first.status, 200); assert.equal(first.body.data.nextCursor, cohortId(2));
    const second = await get(`?limit=2&cursor=${first.body.data.nextCursor}`, { "x-role": "admin" });
    assert.deepEqual(second.body.data.cohorts.map(row => row.cohortId), [cohortId(3)]); assert.equal(second.body.data.nextCursor, null);
    assert.equal((await get("")).body.data.cohorts.length, 3);
    for (const bad of ["?limit=26", "?limit=", "?limit=1&limit=2", "?cursor=a%2Fb", "?cursor=", "?cursor=a&cursor=b"]) {
      const response = await get(bad);
      assert.equal(response.status, 400, bad); assert.equal(response.body.code, "INVALID_READINESS_QUERY", bad);
    }
    assert.equal((await get("?limit=2", { "x-role": "participant" })).status, 403);
    assert.equal((await get("", {})).status, 401);
    process.env.VERIFIED_PLANTING_COHORT_ENABLED = "false";
    const disabled = await get("?limit=bad");
    assert.equal(disabled.status, 409); assert.equal(disabled.body.code, "COHORT_WORKFLOW_DISABLED");
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});
