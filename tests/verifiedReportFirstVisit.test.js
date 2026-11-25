// Every Admin-verified Planting Report can start the simplified first visit (VERIFIED_REPORT_FIRST_VISIT_ENABLED, off by default).
// Real services, controller and routes over an in-memory Firestore whose transactions buffer writes and reject undefined values.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const tables = new Map();
const table = name => tables.get(name) || (tables.set(name, new Map()), tables.get(name));
const at = (value, field) => field.split(".").reduce((node, key) => node?.[key], value);
const storable = (value, path = "") => {
  assert.notEqual(value, undefined, `undefined at ${path}`);
  if (value && typeof value === "object" && [Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value))) {
    for (const [key, child] of Object.entries(value)) storable(child, `${path}.${key}`);
  }
};
const docRef = (name, id) => ({ id, collection: name, get: async () => snap(name, id) });
const snap = (name, id) => ({ id, ref: docRef(name, id), exists: table(name).has(id), data: () => (table(name).has(id) ? structuredClone(table(name).get(id)) : undefined) });
function query(name, state = { filters: [], after: null, max: Infinity }) {
  const next = change => query(name, { ...state, ...change });
  return {
    doc: id => docRef(name, id), where: (f, op, v) => next({ filters: [...state.filters, [f, op, v]] }), orderBy: () => next({}),
    startAfter: id => next({ after: id }), limit: max => next({ max }),
    async get() {
      const ids = [...table(name)].filter(([id, row]) => state.filters.every(([f, op, v]) => {
        const actual = f === "__name__" ? id : at(row, f);
        return op === "in" ? v.includes(actual) : actual === v;
      })).map(([id]) => id).sort().filter(id => state.after === null || id > state.after);
      return { docs: ids.slice(0, state.max).map(id => snap(name, id)) };
    },
  };
}
let failNextCreate = "";
async function runTransaction(callback) {
  const writes = [];
  const tx = {
    get: target => { assert.equal(writes.length, 0, "all reads must come before writes"); return target.get(); },
    create: (ref, value) => { storable(value); writes.push(["create", ref, value]); },
    update: (ref, value) => { storable(value); writes.push(["update", ref, value]); },
  };
  const result = await callback(tx);
  for (const [op, ref] of writes) {
    if (op === "create" && table(ref.collection).has(ref.id)) throw Error("ALREADY_EXISTS");
    if (op === "create" && ref.collection === failNextCreate) { failNextCreate = ""; throw Error("simulated outage"); }
  }
  for (const [op, ref, value] of writes) table(ref.collection).set(ref.id, op === "update" ? { ...table(ref.collection).get(ref.id), ...value } : value);
  return result;
}
const mock = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
mock("../src/config/firebase", { db: { collection: name => query(name), runTransaction } });
mock("../src/middleware/auth.middleware", { verifyToken: (req, res, next) => {
  const role = req.get("x-role"); if (!role) return res.status(401).json({});
  req.user = { uid: req.get("x-uid") || "staff", role }; return next();
} });
mock("../src/middleware/upload.middleware", { uploadContributionEvidence: (q, s, n) => n(), uploadConcurrencyGuard: (q, s, n) => n() });
const eligibility = require("../src/services/verifiedPlantingCohortEligibility");
const cohortService = require("../src/services/verifiedPlantingCohort.service");
const visits = require("../src/services/sampleMonitoringVisit.service");
const service = require("../src/services/verifiedReportFirstVisit.service");
const rule = require("../src/config/verifiedReportFirstVisit");
const routes = require("../src/routes/sampleMonitoringVisit.routes");
const today = require("../src/config/permanentSampleSchedule").dateOnlyInManila();

const ON = { VERIFIED_PLANTING_COHORT_ENABLED: "true", PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "true", PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true", VERIFIED_REPORT_FIRST_VISIT_ENABLED: "true" };
const OTHER = ["PERMANENT_SAMPLE_WRITE_PAUSED", "PERMANENT_SAMPLE_PILOT_ENABLED", "PERMANENT_SAMPLE_PILOT_USER_IDS", "PERMANENT_SAMPLE_PILOT_COHORT_IDS"];
const flags = (values = {}) => { for (const key of [...Object.keys(ON), ...OTHER]) delete process.env[key]; Object.assign(process.env, values); };
const pilot = (users, cohorts) => flags({ ...ON, PERMANENT_SAMPLE_PILOT_ENABLED: "true", PERMANENT_SAMPLE_PILOT_USER_IDS: JSON.stringify(users), PERMANENT_SAMPLE_PILOT_COHORT_IDS: JSON.stringify(cohorts) });
test.beforeEach(() => { tables.clear(); failNextCreate = ""; flags(ON); table("sites").set("site", { siteName: "Site", barangay: "Zone 1", status: "Active" }); });
test.after(() => flags());

const POLICIES = {
  spot: { definition: { monitoring: "STAFF_SPOT_CHECK" }, policyVersion: 0 },
  flatSpot: { monitoring: "STAFF_SPOT_CHECK" },
  pending: { monitoring: "PENDING_MENRO_POLICY", definition: { monitoring: "PENDING_MENRO_POLICY" }, policyStatus: "PENDING_MENRO_POLICY", sampling: null },
  none: { monitoring: "NONE" },
  permanent: { monitoring: "PERMANENT_SAMPLE" },
  legacy: undefined,
};
const CONFLICT = { monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "STAFF_SPOT_CHECK" } };
const report = (policy, extra = {}) => ({ reportNumber: "RPT-2026-020", reportType: "parent", reportingProgress: "Completed", verificationStatus: "Completed", acceptedQuantity: 25,
  siteId: "site", species: "Narra", plantingDate: "2026-10-01", participantName: "PRIVATE NAME", ...(policy ? { reportingPolicy: structuredClone(policy) } : {}), ...extra });
const seed = (id, policy, extra) => table("plantingReports").set(id, report(policy, extra));
const start = (reportId, input = {}) => service.startFirstVisit({ reportId, actorId: "staff", actorRole: "staff", visitDate: today, ...input });
const list = input => service.listVerifiedReports({ actorId: "staff", actorRole: "staff", ...input });
const readiness = () => visits.readiness({ actorId: "staff", actorRole: "staff" });
const cohortOf = id => table("verifiedPlantingCohorts").get(eligibility.cohortIdFor(id));
const approve = id => runTransaction(tx => cohortService.ensureCohortForAuthoritativeReportInTransaction(tx, { reportId: id, report: table("plantingReports").get(id) }));
const code = expected => error => { assert.equal(error.code, expected, error.stack); return true; };
const status = expected => error => { assert.equal(error.status, expected, error.stack); return true; };

test("the rule is off by default, and a malformed value fails closed", () => {
  const read = value => rule.verifiedReportFirstVisitEnabled(value === undefined ? {} : { VERIFIED_REPORT_FIRST_VISIT_ENABLED: value });
  assert.deepEqual([read(), read(""), read("false"), read(" TRUE ")], [false, false, false, true]);
  assert.throws(() => read("yes"), status(503));
});

for (const [name, policy] of Object.entries(POLICIES)) {
  test(`${name}: Staff starts Visit 1 without resubmission; the report is unchanged and the original policy is recorded`, async () => {
    seed("r", policy);
    const before = JSON.stringify(table("plantingReports").get("r"));
    const listed = (await list()).eligible;
    assert.equal(listed.length, 1); assert.equal(listed[0].sampleTarget, 3); assert.equal(listed[0].plantingReportId, "r");
    const visit = await start("r");
    assert.equal(visit.status, "DRAFT"); assert.equal(visit.visitNumber, 1);
    assert.deepEqual(visit.sampleAssessments.map(row => row.sampleId), ["RPT-2026-020-T001", "RPT-2026-020-T002", "RPT-2026-020-T003"]);
    assert.equal(JSON.stringify(table("plantingReports").get("r")), before);
    const audit = cohortOf("r").eligibilityAuthorization;
    assert.equal(audit.policyId, rule.VERIFIED_REPORT_POLICY_ID); assert.equal(audit.trigger, "FIRST_VISIT_START"); assert.equal(audit.authorizedBy, "staff");
    assert.equal(audit.originalMethod, eligibility.permanentSamplePolicy(table("plantingReports").get("r")).method);
    assert.deepEqual(audit.originalPolicy, { hasSnapshot: Boolean(policy), monitoring: policy?.monitoring ?? null, definitionMonitoring: policy?.definition?.monitoring ?? null,
      policyStatus: policy?.policyStatus ?? null, policyVersion: policy?.policyVersion ?? null });
    assert.deepEqual((await list()).cohorts, [], "a report with a cohort is listed by readiness only");
    const ready = await readiness();
    assert.equal(ready.cohorts.length, 1); assert.ok(!ready.cohorts[0].reasons.some(row => row.code === "REPORT_NOT_ELIGIBLE"));
  });
}

test("conflicting, unreadable and unknown stored policies stay closed", async () => {
  const cases = { c: CONFLICT, u: { monitoring: ["STAFF_SPOT_CHECK"] }, x: { monitoring: "SOMETHING" } };
  for (const [id, policy] of Object.entries(cases)) {
    seed(id, policy);
    await assert.rejects(start(id), code("REPORT_NOT_ELIGIBLE"));
    assert.equal(cohortOf(id), undefined);
  }
  const rows = (await list()).notEligible;
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.canCreateVisit === false));
});

test("verified quantity, status, archive, site and species checks stay; nothing is written when one fails", async () => {
  table("sites").set("closed", { siteName: "Closed", status: "Inactive" });
  table("events").set("two", { seedlingItems: [{ inventoryId: "a", species: "Narra", quantity: 5 }, { inventoryId: "b", species: "Molave", quantity: 5 }] });
  table("events").set("elsewhere", { plantingSiteId: "other" });
  const cases = [
    ["zero", { acceptedQuantity: 0 }, "REPORT_NOT_ELIGIBLE"], ["fraction", { acceptedQuantity: 2.5 }, "REPORT_NOT_ELIGIBLE"], ["partial", { reportingProgress: "Partial" }, "REPORT_NOT_ELIGIBLE"],
    ["archived", { archived: true }, "REPORT_NOT_ELIGIBLE"], ["nosite", { siteId: "" }, "REPORT_NOT_ELIGIBLE"], ["missing-site", { siteId: "ghost" }, "REPORT_NOT_ELIGIBLE"],
    ["inactive", { siteId: "closed" }, "REPORT_NOT_ELIGIBLE"], ["site-mismatch", { eventId: "elsewhere" }, "REPORT_NOT_ELIGIBLE"],
    ["species", { eventId: "two" }, "SPECIES_ALLOCATION_PENDING"], ["future-planting", { plantingDate: "2999-01-01" }, "VISIT_BEFORE_ELIGIBILITY"],
  ];
  for (const [id, extra, expected] of cases) { seed(id, POLICIES.spot, extra); await assert.rejects(start(id), code(expected), id); }
  assert.equal(table("verifiedPlantingCohorts").size, 0); assert.equal(table("sampleMonitoringVisits").size, 0);
  await assert.rejects(start("unknown"), status(404));
  for (const bad of ["a/b", "", "..", "__x__", 5, { a: 1 }]) await assert.rejects(start(bad), status(400));
  for (const visitDate of ["2999-01-01", "not-a-date", undefined]) { seed("date", POLICIES.spot); await assert.rejects(start("date", { visitDate })); }
  assert.equal(table("verifiedPlantingCohorts").size, 0);
});

test("gates are not bypassed: rule, cohort, first-visit, schedule, pause and pilot", async () => {
  seed("r", POLICIES.spot);
  const cases = [
    [{ VERIFIED_REPORT_FIRST_VISIT_ENABLED: "false" }, "VERIFIED_REPORT_FIRST_VISIT_DISABLED"], [{ VERIFIED_PLANTING_COHORT_ENABLED: "false" }, "COHORT_WORKFLOW_DISABLED"],
    [{ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "false" }, "FIRST_VISIT_POLICY_DISABLED"], [{ PERMANENT_SAMPLE_SCHEDULE_ENABLED: "false" }, "VISIT_SCHEDULING_POLICY_PENDING"],
    [{ PERMANENT_SAMPLE_WRITE_PAUSED: "true" }, "PERMANENT_SAMPLE_WRITES_PAUSED"],
  ];
  for (const [change, expected] of cases) { flags({ ...ON, ...change }); await assert.rejects(start("r"), code(expected)); }
  pilot(["someone"], [eligibility.cohortIdFor("r")]);
  await assert.rejects(start("r"), status(403)); await assert.rejects(list(), status(403));
  pilot(["staff"], ["VPC-other"]);
  await assert.rejects(start("r"), status(404)); assert.deepEqual((await list()).cohorts, []);
  assert.equal(table("verifiedPlantingCohorts").size, 0);
  // The cohort ID is known before it exists, so a pilot can list it in advance.
  pilot(["staff"], [eligibility.cohortIdFor("r")]);
  assert.equal((await list()).eligible.length, 1); assert.equal((await start("r")).status, "DRAFT");
});

test("while paused or switched off, reports stay listed with the reason and are never startable; with the rule off nothing is listed", async () => {
  seed("r", POLICIES.pending);
  flags({ ...ON, PERMANENT_SAMPLE_WRITE_PAUSED: "true", PERMANENT_SAMPLE_SCHEDULE_ENABLED: "false", PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "false" });
  const data = await list();
  assert.equal(data.eligible.length, 0);
  assert.deepEqual(data.notEligible[0].reasons.filter(row => !row.informational).map(row => row.code).sort(), ["FIRST_VISIT_POLICY_DISABLED", "VISIT_SCHEDULING_POLICY_PENDING", "WRITES_PAUSED"]);
  assert.deepEqual(data.gates, { writesPaused: true, firstVisitBaselineEnabled: false, scheduleEnabled: false, pilotRestricted: false, verifiedReportRuleEnabled: true });
  flags({ ...ON, VERIFIED_REPORT_FIRST_VISIT_ENABLED: "false" });
  const off = await list();
  assert.deepEqual(off.cohorts, []); assert.equal(off.gates.verifiedReportRuleEnabled, false); assert.equal(off.nextCursor, null);
});

test("only Staff can start; Staff and Admin can list", async () => {
  seed("r", POLICIES.spot);
  for (const actorRole of ["admin", "participant", undefined]) await assert.rejects(start("r", { actorRole }), status(403));
  for (const actorRole of ["participant", undefined]) await assert.rejects(list({ actorRole }), status(403));
  assert.equal((await list({ actorId: "admin", actorRole: "admin" })).eligible.length, 1);
});

test("idempotent: a retry returns the same visit, another Staff is refused, one cohort exists", async () => {
  seed("r", POLICIES.spot);
  const first = await start("r"), again = await start("r");
  assert.equal(first.id, again.id);
  await assert.rejects(start("r", { actorId: "other" }), code("OPEN_VISIT_EXISTS"));
  assert.equal(table("verifiedPlantingCohorts").size, 1); assert.equal(table("sampleMonitoringVisits").size, 1);
  assert.equal(cohortOf("r").eligibilityAuthorization.authorizedBy, "staff");
});

test("an outage after the cohort is created is recovered by a retry without a second cohort", async () => {
  seed("r", POLICIES.spot); failNextCreate = "sampleMonitoringVisits";
  await assert.rejects(start("r"), /outage/);
  assert.equal(table("verifiedPlantingCohorts").size, 1); assert.equal((await readiness()).eligible.length, 1);
  assert.equal((await start("r")).status, "DRAFT"); assert.equal(table("verifiedPlantingCohorts").size, 1);
});

test("a cohort under another ID, or an ID taken by another report, is never duplicated or reused", async () => {
  seed("r", POLICIES.spot); table("verifiedPlantingCohorts").set("VPC-old", { source: { plantingReportId: "r" } });
  await assert.rejects(start("r"), code("COHORT_IDENTITY_CONFLICT")); assert.equal(cohortOf("r"), undefined);
  table("verifiedPlantingCohorts").clear(); table("verifiedPlantingCohorts").set(eligibility.cohortIdFor("r"), { source: { plantingReportId: "someone-else" } });
  await assert.rejects(start("r"), code("COHORT_IDENTITY_CONFLICT"));
});

test("an existing cohort without the recorded authorization is not widened by the flag", async () => {
  seed("r", POLICIES.permanent); flags({ ...ON, VERIFIED_REPORT_FIRST_VISIT_ENABLED: "false" });
  await approve("r");
  assert.equal(cohortOf("r").eligibilityAuthorization, undefined, "stored permanent-sample provisioning is unchanged");
  flags(ON); table("plantingReports").get("r").reportingPolicy = { monitoring: "STAFF_SPOT_CHECK" };
  await assert.rejects(start("r"), code("REPORT_NOT_ELIGIBLE"));
});

test("turning the rule off blocks an authorized cohort again at readiness and create, without changing it", async () => {
  seed("r", POLICIES.spot); failNextCreate = "sampleMonitoringVisits"; await assert.rejects(start("r"), /outage/);
  const before = JSON.stringify(cohortOf("r"));
  flags({ ...ON, VERIFIED_REPORT_FIRST_VISIT_ENABLED: "false" });
  const [row] = (await readiness()).cohorts;
  assert.deepEqual(row.reasons.find(reason => reason.code === "REPORT_NOT_ELIGIBLE").problems, ["NOT_PERMANENT_SAMPLE_MONITORING"]);
  await assert.rejects(visits.create({ cohortId: row.cohortId, actorId: "staff", actorRole: "staff", visitDate: today }), code("REPORT_NOT_ELIGIBLE"));
  assert.equal(JSON.stringify(cohortOf("r")), before);
});

test("Admin verification with the rule on provisions any readable policy with its audit record; with it off nothing changes", async () => {
  seed("off", POLICIES.spot); flags({ ...ON, VERIFIED_REPORT_FIRST_VISIT_ENABLED: "false" });
  assert.equal(await approve("off"), null);
  flags(ON);
  for (const id of ["spot", "pending", "none"]) {
    seed(id, POLICIES[id]);
    assert.equal((await approve(id)).created, true);
    assert.equal(cohortOf(id).eligibilityAuthorization.trigger, "REPORT_VERIFICATION"); assert.equal(cohortOf(id).eligibilityAuthorization.authorizedBy, null);
  }
  seed("conflict", CONFLICT); assert.equal(await approve("conflict"), null);
  flags({ ...ON, PERMANENT_SAMPLE_WRITE_PAUSED: "true" }); seed("paused", POLICIES.spot); assert.equal(await approve("paused"), null);
  // A configuration mistake must not block an Admin's report decision.
  flags({ ...ON, VERIFIED_REPORT_FIRST_VISIT_ENABLED: "yes" }); seed("bad", POLICIES.spot); assert.equal(await approve("bad"), null);
});

test("submit and Admin review use the same rule as start", async () => {
  seed("r", POLICIES.spot); await start("r");
  const cohort = cohortOf("r"), reportSnap = snap("plantingReports", "r"), site = snap("sites", "site");
  const problems = () => visits._test.reportEligibilityProblems(cohort, reportSnap, site);
  assert.deepEqual(problems(), []);
  flags({ ...ON, VERIFIED_REPORT_FIRST_VISIT_ENABLED: "false" }); assert.deepEqual(problems(), ["NOT_PERMANENT_SAMPLE_MONITORING"]);
  flags(ON); delete cohort.eligibilityAuthorization; assert.deepEqual(problems(), ["NOT_PERMANENT_SAMPLE_MONITORING"]);
});

test("I1: the earlier plan and baseline routes cannot take over an authorized cohort, with the rule and first-visit flags on or off", async () => {
  const sampling = { percentage: 10, minimum: 1, firstVisitDelayWeeks: 0, intervalMonths: 3, speciesAllocationProcedure: "p", physicalSelectionProcedure: "p" };
  seed("r", { monitoring: "STAFF_SPOT_CHECK", sampling, policyVersion: 1, approvedBy: "admin" }); await approve("r");
  const id = eligibility.cohortIdFor("r"), before = JSON.stringify(cohortOf("r"));
  for (const change of [{}, { VERIFIED_REPORT_FIRST_VISIT_ENABLED: "false", PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "false" }]) {
    flags({ ...ON, ...change });
    for (const call of [() => cohortService.saveSamplingPlan({ cohortId: id, actorId: "staff", expectedVersion: 0, selectionMethod: "systematic", submitForApproval: true, notes: "", selectedSamples: ["A-1", "A-2", "A-3"].map(permanentId => ({ permanentId, unitType: "tree", species: "Narra", siteReference: "site", selectionReason: "random" })), speciesSiteDistribution: [{ species: "Narra", siteReference: "site", sampleIds: ["A-1", "A-2", "A-3"] }] }), () => cohortService.approveSamplingPlan({ cohortId: id, actorId: "admin", expectedVersion: 0, approve: true }),
      () => cohortService.registerBaseline({ cohortId: id, actorId: "staff", expectedVersion: 0, sampleUnits: [{ permanentId: "TREE-001", unitType: "tree", latitude: 12.66, longitude: 123.93, condition: "Healthy", captureDate: "2026-11-01", photoReferences: [{ evidenceId: "photo-1" }] }] }), () => cohortService.approveBaseline({ cohortId: id, actorId: "admin", expectedVersion: 0, approve: true })]) {
      await assert.rejects(call(), error => { assert.equal(error.status, 409, error.stack); assert.equal(error.code, "FIRST_VISIT_BASELINE_ACTIVE", error.stack); return true; });
    }
  }
  assert.equal(JSON.stringify(cohortOf("r")), before);
});

test("I2: archive, site-mismatch, unsafe site and unsafe quantity checks are the same before and after a cohort exists", async () => {
  table("events").set("elsewhere", { plantingSiteId: "other" });
  for (const [id, extra] of [["mismatch", { eventId: "elsewhere" }], ["unsafe-site", { siteId: "a/b" }], ["unsafe-quantity", { acceptedQuantity: 1e17, reportingPolicy: { monitoring: "STAFF_SPOT_CHECK", sampling: {} } }]]) {
    seed(id, POLICIES.spot, extra); assert.equal(await approve(id), null, id); await assert.rejects(start(id), undefined, id); assert.equal(cohortOf(id), undefined, id);
  }
  seed("archived", POLICIES.spot); await approve("archived"); table("plantingReports").get("archived").archived = true;
  await assert.rejects(start("archived"), code("REPORT_NOT_ELIGIBLE"));
  const row = (await readiness()).cohorts.find(entry => entry.context.plantingReportId === "archived");
  assert.deepEqual(row.reasons.find(reason => reason.code === "REPORT_NOT_ELIGIBLE").problems, ["REPORT_ARCHIVED"]);
});

test("M1: one unusable report never hides the others from the list", async () => {
  seed("good", POLICIES.spot); seed("bad", { monitoring: "STAFF_SPOT_CHECK", sampling: {} }, { acceptedQuantity: 1e17 });
  assert.deepEqual((await list()).eligible.map(row => row.plantingReportId), ["good"]);
});

test("a report without a usable species is refused with a code and writes nothing", async () => {
  seed("r", POLICIES.spot, { species: "" });
  await assert.rejects(start("r"), error => error.status === 409 && error.code === "FIRST_VISIT_PLAN_UNAVAILABLE"); assert.equal(cohortOf("r"), undefined);
});

test("listing pages every verified report once, in bounded pages, without private data", async () => {
  for (let n = 0; n < 120; n++) seed(`r${String(n).padStart(3, "0")}`, POLICIES.spot, { reportNumber: `RPT-${n}` });
  seed("draft", undefined, { reportingProgress: "Awaiting Submission" });
  const seen = []; let cursor, pages = 0;
  do {
    const page = await list(cursor ? { cursor } : {});
    seen.push(...page.cohorts.map(row => row.plantingReportId)); cursor = page.nextCursor; pages++;
    assert.equal(page.truncated, cursor !== null); assert.ok(!JSON.stringify(page).includes("PRIVATE"));
  } while (cursor && pages < 20);
  assert.equal(seen.length, 120); assert.equal(new Set(seen).size, 120); assert.ok(pages >= 3);
  for (const bad of ["a/b", "__x__", ["a"], ""]) await assert.rejects(list({ cursor: bad }), code("INVALID_READINESS_QUERY"));
});

test("the Staff-visible cohort list never shows who authorized it", async () => {
  seed("r", POLICIES.spot); await start("r");
  const [row] = await cohortService.listVerifiedPlantingCohorts({ actorId: "other" });
  assert.equal(row.eligibilityAuthorization.policyId, rule.VERIFIED_REPORT_POLICY_ID); assert.equal("authorizedBy" in row.eligibilityAuthorization, false);
});

test("HTTP: roles, gate, status codes, and client-sent values are ignored", async () => {
  seed("r", POLICIES.spot);
  const app = express(); app.use(express.json()); app.use("/m", routes);
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/m/verified-reports`;
  const call = async (path, method, role, body) => {
    const response = await fetch(base + path, { method, headers: { ...(role ? { "x-role": role } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return [response.status, await response.json().catch(() => ({}))];
  };
  try {
    assert.equal((await call("", "GET"))[0], 401); assert.equal((await call("", "GET", "participant"))[0], 403);
    assert.equal((await call("", "GET", "staff"))[1].data.eligible.length, 1); assert.equal((await call("?cursor=a&cursor=b", "GET", "staff"))[0], 400);
    for (const role of ["admin", "participant"]) assert.equal((await call("/r/first-visit", "POST", role, { visitDate: today }))[0], 403);
    const [created, body] = await call("/r/first-visit", "POST", "staff", { visitDate: today, quantity: 9999, siteId: "x", actorRole: "admin" });
    assert.equal(created, 201); assert.equal(body.data.sampleAssessments.length, 3); assert.equal(cohortOf("r").source.siteId, "site");
    flags({ ...ON, VERIFIED_PLANTING_COHORT_ENABLED: "false" });
    const [gated, gatedBody] = await call("", "GET", "staff"); assert.deepEqual([gated, gatedBody.code], [409, "COHORT_WORKFLOW_DISABLED"]);
  } finally { server.close(); }
});
