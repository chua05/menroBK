const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const release = require("../src/config/permanentSampleRelease");
const pilot = () => ({ PERMANENT_SAMPLE_PILOT_ENABLED: "true", PERMANENT_SAMPLE_PILOT_USER_IDS: '["owner","admin","requester"]', PERMANENT_SAMPLE_PILOT_COHORT_IDS: '["allowed"]' });
const names = ["PERMANENT_SAMPLE_WRITE_PAUSED", "PERMANENT_SAMPLE_PILOT_ENABLED", "PERMANENT_SAMPLE_PILOT_USER_IDS", "PERMANENT_SAMPLE_PILOT_COHORT_IDS"];
afterEach(() => names.forEach(name => delete process.env[name]));
test("defaults preserve existing gates; pause changes only write permission", () => {
  assert.equal(release.resolve({}).pilot, false);
  const policy = release.resolve({ PERMANENT_SAMPLE_WRITE_PAUSED: "true" });
  release.assertScope("owner", "allowed", policy);
  assert.throws(() => release.assertWrite(policy), { status: 503, code: "PERMANENT_SAMPLE_WRITES_PAUSED" });
});
test("pilot requires user AND cohort; Admin has no release bypass", () => {
  const policy = release.resolve(pilot());
  release.assertScope("owner", "allowed", policy);
  assert.throws(() => release.assertScope("admin", "outside", policy), { status: 404 });
  assert.throws(() => release.assertScope("stranger", "allowed", policy), { status: 403 });
});
test("malformed flags, missing lists, unsafe IDs, duplicates and excessive scope fail closed", () => {
  for (const env of [
    { PERMANENT_SAMPLE_WRITE_PAUSED: "TRUE" }, { PERMANENT_SAMPLE_PILOT_ENABLED: "1" },
    { PERMANENT_SAMPLE_PILOT_ENABLED: "true" }, { ...pilot(), PERMANENT_SAMPLE_PILOT_USER_IDS: "[]" },
    { ...pilot(), PERMANENT_SAMPLE_PILOT_COHORT_IDS: '["*"]' },
    { ...pilot(), PERMANENT_SAMPLE_PILOT_USER_IDS: '["owner","owner"]' },
    { ...pilot(), PERMANENT_SAMPLE_PILOT_USER_IDS: '["owner/other"]' },
    { ...pilot(), PERMANENT_SAMPLE_PILOT_COHORT_IDS: JSON.stringify(Array.from({ length: 11 }, (_, i) => `c${i}`)) },
    { PERMANENT_SAMPLE_PILOT_COHORT_IDS: '["allowed"]' },
  ]) assert.throws(() => release.resolve(env), { status: 503, code: "PERMANENT_SAMPLE_RELEASE_CONFIGURATION_INVALID" });
});
test("pilot constraints are placed on database query before pagination", () => {
  const calls = []; const query = { where(...args) { calls.push(args); return this; } };
  assert.equal(release.scopeQuery(query, release.resolve(pilot())), query);
  assert.deepEqual(calls, [["cohortId", "in", ["allowed"]]]);
  release.scopeQuery(query, release.resolve({})); assert.equal(calls.length, 1);
});
test("audit fingerprint is stable independent of allowlist ordering and contains no raw IDs", () => {
  const a = release.resolve(pilot());
  const b = release.resolve({ ...pilot(), PERMANENT_SAMPLE_PILOT_USER_IDS: '["requester","owner","admin"]' });
  assert.equal(a.fingerprint, b.fingerprint); assert.match(a.fingerprint, /^[a-f0-9]{64}$/);
});

const records = new Map();
const table = name => records.get(name) || (records.set(name, new Map()), records.get(name));
let writes = 0;
const doc = (name, id) => ({ id, path: `${name}/${id}`, get: async () => ({ id, exists: table(name).has(id), data: () => table(name).get(id) }) });
const db = { collection(name) {
  const filters = []; let max = Infinity, cursor;
  return { doc: id => doc(name, id), where(field, op, value) { filters.push([field, op, value]); return this; },
    orderBy() { return this; }, limit(size) { max = size; return this; }, startAfter(row) { cursor = row.id; return this; },
    async get() {
      let rows = [...table(name)].filter(([id, row]) => filters.every(([field, op, value]) => {
        const actual = field === "__name__" ? id : row[field];
        if (op === "==") return actual === value;
        if (op === "in") return value.includes(actual);
        throw Error(`Unsupported query operator ${op}`);
      })).sort(([a], [b]) => a.localeCompare(b));
      if (cursor) rows = rows.slice(rows.findIndex(([id]) => id === cursor) + 1);
      return { docs: rows.slice(0, max).map(([id, row]) => ({ id, data: () => row })), empty: !rows.length };
    } };
}, async runTransaction(fn) {
  return fn({ get: ref => ref.get(), create() { writes++; }, update() { writes++; }, set() { writes++; } });
} };
const firebase = require.resolve("../src/config/firebase");
require.cache[firebase] = { exports: { db } };
const gate = require.resolve("../src/config/verifiedPlantingCohort");
require.cache[gate] = { exports: { resolveVerifiedPlantingCohortConfig: () => ({ enabled: true }) } };
const visits = require("../src/services/sampleMonitoringVisit.service");
const cohorts = require("../src/services/verifiedPlantingCohort.service");
const capture = require("../src/services/evidenceCaptureSession.service");
const upload = require("../src/services/sampleMonitoringEvidence.service");
const { createService: information } = require("../src/services/sampleMonitoringInformation.service");
const { createService: analytics } = require("../src/services/permanentSampleAnalytics.service");
function seed() {
  records.clear(); writes = 0;
  for (const [id, cohortId, owner] of [["a", "allowed", "owner"], ["b", "outside", "owner"], ["c", "allowed", "other"]]) {
    table("sampleMonitoringVisits").set(id, { createdBy: owner, cohortId, siteId: "site", status: "DRAFT", version: 0, sampleAssessments: [{ sampleId: "TREE-001", condition: "Healthy", evidenceHistory: [{ revision: 0 }] }] });
  }
  table("verifiedPlantingCohorts").set("allowed", { source: { siteId: "site", requestId: "source", plantingReportId: "report" } });
  table("verifiedPlantingCohorts").set("outside", { source: { siteId: "site" } });
  table("plantingReports").set("report", { requestId: "source", verificationStatus: "Approved", quantityPlanted: 1 });
  table("seedlingRequests").set("source", { participantId: "requester" });
  table("users").set("requester", { role: "participant", status: "active" });
}
test("paused mutations reject before any writes; authorized visit/history reads remain available", async () => {
  seed(); process.env.PERMANENT_SAMPLE_WRITE_PAUSED = "true";
  const detail = await visits.get("a", { actorId: "owner", actorRole: "staff" });
  assert.equal(detail.writesPaused, true); assert.deepEqual(detail.sampleAssessments[0].evidenceHistory, [{ revision: 0 }]);
  const page = await visits.list({ actorId: "owner", actorRole: "staff" });
  assert.equal(page.visits[0].actions.saveDraft, false);
  for (const operation of [
    () => visits.create({ cohortId: "allowed", actorId: "owner", testOnly: true }),
    () => visits.save({ visitId: "a", actorId: "owner", expectedVersion: 0, assessments: [] }),
    () => visits.review({ visitId: "a", actorId: "admin", expectedVersion: 0, approve: true }),
    () => cohorts.saveSamplingPlan({ cohortId: "allowed", actorId: "owner" }),
    () => cohorts.registerBaselineWithEvidence({ cohortId: "allowed", actorId: "owner" }),
    () => cohorts.approveBaseline({ cohortId: "allowed", actorId: "admin" }),
    () => capture.createCaptureSession({ actorId: "owner", actorRole: "staff", workflow: "sample-monitoring", cohortId: "allowed", siteId: "site", visitId: "a", sampleId: "TREE-001", assessmentRevision: 0, visitVersion: 0, samplingPlanVersion: 1, baselineVersion: 1 }),
    () => upload.upload({ actorId: "owner", actorRole: "staff", visitId: "a" }),
  ]) await assert.rejects(operation, { status: 503 });
  assert.equal(writes, 0);
  await assert.rejects(() => visits.get("a", { actorId: "other", actorRole: "staff" }), { status: 404 });
});
test("pilot paginates only allowed cohorts and still enforces Staff ownership and role", async () => {
  seed(); Object.assign(process.env, pilot());
  const page = await visits.list({ actorId: "owner", actorRole: "staff", limit: 1 });
  assert.deepEqual(page.visits.map(row => row.id), ["a"]); assert.equal(page.nextCursor, null);
  const admin = await visits.list({ actorId: "admin", actorRole: "admin" });
  assert.deepEqual(admin.visits.map(row => row.id), ["a", "c"]);
  await assert.rejects(() => visits.get("b", { actorId: "owner", actorRole: "staff" }), { status: 404 });
  await assert.rejects(() => visits.get("c", { actorId: "owner", actorRole: "staff" }), { status: 404 });
  await assert.rejects(() => visits.list({ actorId: "owner", actorRole: "staff", cursor: "b" }), { status: 400 });
  await assert.rejects(() => visits.list({ actorId: "requester", actorRole: "participant" }), { status: 403 });
  assert.deepEqual((await cohorts.listVerifiedPlantingCohorts({ actorId: "owner" })).map(row => row.id), ["allowed"]);
});
test("paused requester questions/replies are read-preserving and notification-free", async () => {
  seed(); const service = information({ db, enabled: () => true, now: () => 123, notify: () => { writes++; } });
  table("sampleMonitoringInformationRequests").set("q", { visitId: "a", cohortId: "allowed", siteId: "site", recipientUserId: "requester", sourceRequestId: "source", plantingReportId: "report", status: "OPEN", version: 0, question: "Access?", history: [] });
  process.env.PERMANENT_SAMPLE_WRITE_PAUSED = "true";
  assert.equal((await service.get({ requestId: "q", actorId: "requester", actorRole: "participant" })).writesPaused, true);
  await assert.rejects(() => service.create({ visitId: "a", actorId: "owner", actorRole: "staff", key: "question", question: "Access?" }), { status: 503 });
  await assert.rejects(() => service.answer({ requestId: "q", actorId: "requester", actorRole: "participant", key: "answer", expectedVersion: 0, answer: "Open" }), { status: 503 });
  assert.equal(writes, 0);
});
test("pilot scopes requester inbox and analytics before query execution", async () => {
  seed(); Object.assign(process.env, pilot());
  const calls = []; const query = { where(...args) { calls.push(args); return this; }, orderBy() { return this; }, limit() { return this; }, async get() { return { docs: [] }; } };
  const scopedDb = { collection() { return query; } };
  await information({ db: scopedDb, enabled: () => true }).list({ actorId: "requester", actorRole: "participant", paged: true });
  assert.ok(calls.some(call => call[0] === "cohortId" && call[1] === "in"));
  calls.length = 0;
  await analytics({ db: scopedDb, enabled: () => true }).get({ actorId: "admin", actorRole: "admin" });
  assert.ok(calls.some(call => call[0] === "cohortId" && call[1] === "in"));
});
test("automatic new-cohort provisioning holds without altering legacy report completion", async () => {
  seed(); process.env.PERMANENT_SAMPLE_WRITE_PAUSED = "true";
  assert.equal(await cohorts.ensureCohortForAuthoritativeReportInTransaction({ get() { throw Error("No report/cohort reads required during hold"); } }, { reportId: "report", report: { quantityPlanted: 1, verificationStatus: "Approved" } }), null);
  assert.equal(writes, 0);
});

test("pilot cannot notify a requester who is outside the user allowlist", async () => {
  seed(); Object.assign(process.env, { ...pilot(), PERMANENT_SAMPLE_PILOT_USER_IDS: '["owner","admin"]' });
  const service = information({ db, enabled: () => true, now: () => 123, notify: () => { writes++; } });
  await assert.rejects(() => service.create({ visitId: "a", actorId: "owner", actorRole: "staff", question: "Access?", key: "question" }), { status: 403 });
  assert.equal(writes, 0);
});

test("allowlisted Requester cannot retrieve an existing question from an excluded cohort", async () => {
  seed(); Object.assign(process.env, pilot());
  table("sampleMonitoringInformationRequests").set("outside-question", { visitId: "b", cohortId: "outside", siteId: "site", recipientUserId: "requester", question: "Private excluded question" });
  const service = information({ db, enabled: () => true });
  await assert.rejects(() => service.get({ requestId: "outside-question", actorId: "requester", actorRole: "participant" }), { status: 404 });
  assert.equal(writes, 0);
});

test("pilot reply cannot notify an original sender removed from the pilot", async () => {
  seed(); Object.assign(process.env, pilot());
  table("sampleMonitoringInformationRequests").set("q", { visitId: "a", cohortId: "allowed", siteId: "site", requestedBy: "removed-sender", recipientUserId: "requester", sourceRequestId: "source", plantingReportId: "report", question: "Access?", status: "OPEN", version: 0, history: [] });
  const service = information({ db, enabled: () => true, now: () => 123, notify: () => { writes++; } });
  await assert.rejects(() => service.answer({ requestId: "q", actorId: "requester", actorRole: "participant", expectedVersion: 0, answer: "Open", key: "reply" }), { status: 403 });
  assert.equal(writes, 0);
});
