// B3: real Firestore emulator acceptance for historical cohort recovery and readiness paging.
// A verified report that never got its cohort -> read-only dry run -> digest-confirmed execution (concurrent and gated
// cases included) -> readiness eligible -> Visit 1 with ceil(10%) trees. Demo project and loopback hosts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const RELEASE_FLAGS = ["PERMANENT_SAMPLE_PILOT_ENABLED", "PERMANENT_SAMPLE_PILOT_USER_IDS", "PERMANENT_SAMPLE_PILOT_COHORT_IDS", "PERMANENT_SAMPLE_WRITE_PAUSED"];
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG", ...RELEASE_FLAGS,
  "MENRO_PHASE3C_ISOLATED_EMULATORS", "MENRO_BASELINE_EVIDENCE_ACCEPTANCE", "MENRO_REQUEST_LETTER_ACCEPTANCE", "MENRO_MPDO_BOUNDARY_ACCEPTANCE"]) delete process.env[key];
process.env.MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS = "true";
const topology = require("../helpers/emulatorTestTopology");
Object.assign(process.env, {
  NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", GCLOUD_PROJECT: topology.project, FIREBASE_PROJECT_ID: topology.project,
  FIRESTORE_EMULATOR_HOST: topology.firestore, FIREBASE_AUTH_EMULATOR_HOST: topology.auth, FIREBASE_STORAGE_EMULATOR_HOST: topology.storage, FIREBASE_STORAGE_BUCKET: topology.bucket,
  PERMANENT_SAMPLE_WRITE_PAUSED: "false", VERIFIED_PLANTING_COHORT_ENABLED: "true", PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "true", PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true",
  MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-cohort-recovery-${process.pid}`),
});
const validation = require("../../src/config/integrationEnvironment").validateIntegrationEnvironment();
assert.equal(validation.integration, true); assert.equal(validation.legacyMonitoringIsolated, true);
assert.equal(validation.projectId, "demo-menro-legacy-monitoring-20261106"); assert.match(topology.firestore, /^127\.0\.0\.1:\d+$/);

const { db } = require("../../src/config/firebase");
const visits = require("../../src/services/sampleMonitoringVisit.service");
const { ensureCohortForAuthoritativeReportInTransaction: ensure } = require("../../src/services/verifiedPlantingCohort.service");
const { cohortIdFor } = require("../../src/services/verifiedPlantingCohortEligibility");
const { executeRecovery, planRecovery } = require("../../src/services/historicalCohortRecovery.service");
const schedule = require("../../src/config/permanentSampleSchedule");

const prefix = `recovery-${crypto.randomUUID()}`, staff = `${prefix}-staff`, siteId = `${prefix}-site`, eventId = `${prefix}-event`;
const key = name => `${prefix}-${name}`;
const owned = new Map(); // path -> reference, for cleanup of exactly what this suite seeds or provisions
async function seed(collection, id, data) { const ref = db.collection(collection).doc(id); owned.set(ref.path, ref); await ref.set({ ...data, testFixture: prefix }); return ref; }
const cohortRef = reportId => { const ref = db.collection("verifiedPlantingCohorts").doc(cohortIdFor(reportId)); owned.set(ref.path, ref); return ref; };
const sampling = { percentage: 10, minimum: null, firstVisitDelayWeeks: null, intervalMonths: 12, speciesAllocationProcedure: null, physicalSelectionProcedure: null };
const REPORT = { reportType: "parent", reportingProgress: "Completed", verificationStatus: "Completed", acceptedQuantity: 37, siteId, eventId, plantingDate: "2026-09-01", species: "Narra",
  participantId: key("participant"), requesterName: "PRIVATE-NAME", photos: ["PRIVATE-PHOTO"], latitude: 12.66,
  reportingPolicy: { definition: { monitoring: "PERMANENT_SAMPLE", reporting: "REQUIRED" }, sampling, policyVersion: 0, approvedBy: key("admin"), policyStatus: "RESOLVED", staffProposal: { note: "PRIVATE-NOTE" } } };
const seedReport = (name, change = {}) => seed("plantingReports", key(name), { ...REPORT, reportNumber: `RPT-${crypto.randomBytes(3).toString("hex").toUpperCase()}`, ...change });
// Contents and server update times of everything that recovery must never touch.
async function protectedState(exceptCohortIds = []) {
  const out = [];
  for (const collection of ["plantingReports", "events", "sites", "monitoringRecords", "monitoringHistory", "sampleMonitoringVisits", "verifiedPlantingCohorts", "counters", "notifications"]) {
    for (const doc of (await db.collection(collection).get()).docs) if (!exceptCohortIds.includes(doc.id)) out.push([doc.ref.path, doc.updateTime.valueOf(), JSON.stringify(doc.data())]);
  }
  return JSON.stringify(out.sort());
}
const resetFlags = () => { RELEASE_FLAGS.forEach(name => delete process.env[name]); Object.assign(process.env, { PERMANENT_SAMPLE_WRITE_PAUSED: "false", VERIFIED_PLANTING_COHORT_ENABLED: "true" }); };

test.before(async () => {
  await seed("sites", siteId, { siteName: "Recovery emulator site", status: "Active", latitude: 12.662301, longitude: 123.932983, coverageRadiusMeters: 50 });
  await seed("events", eventId, { plantingSiteId: siteId, sourceRequestId: key("request"), seedlingItems: [{ inventoryId: key("inv"), species: "Narra", quantity: 37 }], organizerName: "PRIVATE-NAME" });
  await seed("monitoringRecords", key("mon"), { plantingReportId: key("main"), monitoringNumber: "MON-2026-901", history: [{ observedLiving: 30 }] });
  await seed("verifiedPlantingCohorts", key("unrelated"), { source: { plantingReportId: key("unrelated-report"), siteId }, verifiedPlantedQuantity: 5, samplingPlan: { version: 2, status: "APPROVED", selectedSamples: [] }, baseline: { approvalStatus: "APPROVED", sampleUnits: [] }, baselineVersion: 1 });
});
test.afterEach(resetFlags);
test.after(async () => {
  for (const reportId of ["main", "race"].map(key)) for (const doc of (await db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortIdFor(reportId)).get()).docs) await doc.ref.delete();
  for (const ref of owned.values()) await ref.delete();
  for (const ref of owned.values()) assert.equal((await ref.get()).exists, false);
  await db.terminate();
});

test("a verified nested-only report skipped while the workflow was off is found by the dry run, which writes nothing", async () => {
  const ref = await seedReport("main");
  process.env.VERIFIED_PLANTING_COHORT_ENABLED = "false";
  assert.equal(await db.runTransaction(tx => ensure(tx, { reportId: ref.id, report: REPORT })), null);
  resetFlags();
  await seedReport("none", { reportingPolicy: { monitoring: "NONE" } });
  await seedReport("conflict", { reportingPolicy: { monitoring: "NONE", definition: { monitoring: "PERMANENT_SAMPLE" } } });
  await seedReport("empty-policy", { reportingPolicy: {} });
  const before = await protectedState();
  const plan = await planRecovery({ db, reportIds: ["main", "none", "conflict", "empty-policy", "absent"].map(key) });
  assert.deepEqual(plan.reports.map(row => row.decision), ["ELIGIBLE_MISSING_COHORT", "INCOMPATIBLE_POLICY", "CONFLICTING_POLICY", "REQUIRES_MENRO_APPROVAL", "REPORT_NOT_FOUND"]);
  assert.deepEqual([plan.reports[0].quantity, plan.reports[0].expectedCohortId, plan.reports[0].notes], [37, cohortIdFor(key("main")), []]);
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE|12\.66|participant/);
  assert.equal(await protectedState(), before);
});

test("a write inside a read-only transaction is rejected by Firestore (the dry run cannot write)", async () => {
  await assert.rejects(db.runTransaction(async tx => { tx.create(db.collection("verifiedPlantingCohorts").doc(key("forbidden")), {}); }, { readOnly: true }));
  assert.equal((await db.collection("verifiedPlantingCohorts").doc(key("forbidden")).get()).exists, false);
});

test("paused, pilot and flag-off execution stays gated; a changed report stops before any write", async () => {
  const before = await protectedState();
  for (const env of [{ PERMANENT_SAMPLE_WRITE_PAUSED: "true" }, { VERIFIED_PLANTING_COHORT_ENABLED: "false" },
    { PERMANENT_SAMPLE_PILOT_ENABLED: "true", PERMANENT_SAMPLE_PILOT_USER_IDS: JSON.stringify([staff]), PERMANENT_SAMPLE_PILOT_COHORT_IDS: JSON.stringify([cohortIdFor(key("main"))]) }]) {
    resetFlags(); Object.assign(process.env, env);
    const { digest } = await planRecovery({ db, reportIds: [key("main")] });
    const result = await executeRecovery({ db, reportIds: [key("main")], confirmDigest: digest, ensure });
    assert.deepEqual(result.results.map(row => row.status), ["PROVISIONING_GATED"], JSON.stringify(env));
  }
  resetFlags();
  assert.equal(await protectedState(), before);
  const changed = await seedReport("changed");
  const { digest } = await planRecovery({ db, reportIds: [changed.id] });
  await changed.update({ acceptedQuantity: 36 });
  await assert.rejects(executeRecovery({ db, reportIds: [changed.id], confirmDigest: digest, ensure }), /\[confirmation\]/);
  assert.equal((await cohortRef(changed.id).get()).exists, false);
});

test("five concurrent executions of the same reviewed plan create exactly one cohort and touch nothing else", async () => {
  const report = await seedReport("race"), cohort = cohortRef(report.id);
  const { digest } = await planRecovery({ db, reportIds: [report.id] });
  const before = await protectedState([cohort.id]);
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => executeRecovery({ db, reportIds: [report.id], confirmDigest: digest, ensure })));
  const statuses = outcomes.map(outcome => outcome.status === "fulfilled" ? outcome.value.results[0]?.status || outcome.value.status : outcome.reason.step);
  assert.equal(statuses.filter(status => status === "PROVISIONED").length, 1, JSON.stringify(statuses));
  // A run that starts after the winner committed sees a changed plan and stops at confirmation instead.
  for (const status of statuses) assert.ok(["PROVISIONED", "ALREADY_PROVISIONED", "confirmation"].includes(status), JSON.stringify(outcomes));
  const claims = await db.collection("verifiedPlantingCohorts").where("source.plantingReportId", "==", report.id).get();
  assert.deepEqual(claims.docs.map(doc => doc.id), [cohort.id]);
  assert.equal(await protectedState([cohort.id]), before);
  const again = await planRecovery({ db, reportIds: [report.id] });
  assert.equal(again.reports[0].decision, "ALREADY_PROVISIONED");
  const stored = await cohort.get();
  assert.deepEqual((await executeRecovery({ db, reportIds: [report.id], confirmDigest: again.digest, ensure })).results.map(row => row.status), ["ALREADY_PROVISIONED"]);
  assert.equal((await cohort.get()).updateTime.valueOf(), stored.updateTime.valueOf(), "an existing cohort is never rewritten");
});

test("the real CLI recovers the report in the emulator, then readiness is eligible and Visit 1 has ceil(10%) trees", async () => {
  const reportId = key("main"), cohort = cohortRef(reportId);
  const script = path.join(__dirname, "..", "..", "scripts", "recoverHistoricalCohorts.js");
  const run = (args, env = {}) => { const result = spawnSync(process.execPath, [script, `--reports=${reportId}`, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
    return { ...result, json: result.status === 0 ? JSON.parse(result.stdout.slice(result.stdout.search(/^\{\r?$/m))) : null }; };
  const before = await protectedState([cohort.id]);
  const dry = run([]);
  assert.equal(dry.status, 0, dry.stderr); assert.equal(dry.json.reports[0].decision, "ELIGIBLE_MISSING_COHORT"); assert.equal((await cohort.get()).exists, false);
  const refused = run(["--execute", `--confirm-digest=${dry.json.digest}`], { NODE_ENV: "development" });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /separate approved plan/);
  const wrong = run(["--execute", "--confirm-digest=0123456789abcdef"]);
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /\[confirmation\]/); assert.equal((await cohort.get()).exists, false);
  const executed = run(["--execute", `--confirm-digest=${dry.json.digest}`]);
  assert.equal(executed.status, 0, executed.stderr); assert.deepEqual(executed.json.results.map(row => row.status), ["PROVISIONED"]);
  assert.equal(await protectedState([cohort.id]), before);
  const data = (await cohort.get()).data();
  assert.deepEqual([data.source.plantingReportId, data.source.siteId, data.verifiedPlantedQuantity, data.samplingPolicySnapshot.policyVersion, data.samplingPlan, data.baseline], [reportId, siteId, 37, 0, undefined, null]);

  const ready = await visits.readiness({ actorId: staff, actorRole: "staff" });
  const row = ready.eligible.find(entry => entry.cohortId === cohort.id);
  assert.ok(row, "the recovered report is selectable"); assert.equal(row.sampleTarget, 4); assert.equal(row.registersBaseline, true);
  const visit = await visits.create({ cohortId: cohort.id, actorId: staff, actorRole: "staff", visitDate: schedule.dateOnlyInManila() });
  assert.equal(visit.visitNumber, 1); assert.equal(visit.sampleAssessments.length, 4); // ceil(37 * 10%)
  assert.equal(new Set(visit.sampleAssessments.map(entry => entry.sampleId)).size, 4);
});

test("readiness pages real Firestore in document ID order without gaps, with and without a pilot list", async () => {
  const ids = Array.from({ length: 27 }, (_, n) => `${prefix}-page-${String(n).padStart(2, "0")}`);
  for (const id of ids) await seed("verifiedPlantingCohorts", id, { source: { siteId, plantingReportId: key("main") }, verifiedPlantedQuantity: 5, baseline: null, baselineVersion: 0 });
  const follow = async limit => { const pages = []; let cursor; do { const page = await visits.readiness({ actorId: staff, actorRole: "staff", ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) }); pages.push(page); cursor = page.nextCursor; } while (cursor); return pages; };
  const expected = (await db.collection("verifiedPlantingCohorts").orderBy("__name__").get()).docs.map(doc => doc.id);
  assert.ok(expected.length > 25);
  for (const limit of [undefined, 10]) {
    const pages = await follow(limit);
    assert.deepEqual(pages.flatMap(page => page.cohorts.map(row => row.cohortId)), expected);
    assert.ok(pages.slice(0, -1).every(page => page.truncated && page.cohorts.length === (limit || 25))); assert.equal(pages.at(-1).truncated, false);
  }
  const allowed = [ids[20], ids[3], ids[11]];
  Object.assign(process.env, { PERMANENT_SAMPLE_PILOT_ENABLED: "true", PERMANENT_SAMPLE_PILOT_USER_IDS: JSON.stringify([staff]), PERMANENT_SAMPLE_PILOT_COHORT_IDS: JSON.stringify(allowed) });
  assert.deepEqual((await follow(2)).map(page => page.cohorts.map(row => row.cohortId)), [[ids[3], ids[11]], [ids[20]]]);
});
