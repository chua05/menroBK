// FIX-G H-1: the real-browser teardown audit and fixture cleanup must cope with a first-visit run that failed
// before visit 1 existed, while still failing on real mismatches. In-memory Firestore/Auth/Storage fakes only.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { createHash, randomUUID } = require("node:crypto");

// Process-local: a private temporary directory (fixture + manifest files) and the isolated legacy topology values
// that validateIntegrationEnvironment() demands. No emulator or network is used.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "menro-fixg-h1-"));
Object.assign(process.env, { TMP: tmp, TEMP: tmp, TMPDIR: tmp });
assert.equal(os.tmpdir(), tmp);
const PROJECT = "demo-menro-legacy-monitoring-20261106", BUCKET = `${PROJECT}.firebasestorage.app`;
Object.assign(process.env, { NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS: "true",
  GCLOUD_PROJECT: PROJECT, FIREBASE_PROJECT_ID: PROJECT, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8381", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9399",
  FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9398", FIREBASE_STORAGE_BUCKET: BUCKET, MENRO_SAMPLE_MONITORING_FORM_ACCEPTANCE: "true" });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const tables = new Map(), table = n => tables.get(n) || (tables.set(n, new Map()), tables.get(n));
const objects = new Map(), users = new Map();
const field = (row, name) => name.split(".").reduce((value, key) => value?.[key], row);
const ref = (c, id) => ({ id, collectionName: c, get: async () => { const v = table(c).get(id); return { id, exists: v !== undefined, data: () => v, ref: ref(c, id) }; } });
const db = { projectId: PROJECT,
  collection: c => { const filters = []; const query = { doc: id => ref(c, id), where: (f, o, x) => { filters.push([f, o, x]); return query; },
    get: async () => { const rows = [...table(c)].filter(([, v]) => filters.every(([f, o, x]) => o === "==" && field(v, f) === x));
      return { docs: rows.map(([id, v]) => ({ id, data: () => v, ref: ref(c, id) })), empty: rows.length === 0 }; } }; return query; },
  batch: () => { const deletes = []; return { delete: r => deletes.push(r), commit: async () => deletes.forEach(r => table(r.collectionName).delete(r.id)) }; } };
const notFound = () => Object.assign(new Error("not found"), { code: "auth/user-not-found" });
const auth = { getUser: async uid => { if (!users.has(uid)) throw notFound(); return users.get(uid); },
  deleteUser: async uid => { if (!users.delete(uid)) throw notFound(); } };
const bucket = { name: BUCKET, file: name => ({ exists: async () => [objects.has(name)], download: async () => [objects.get(name).bytes],
  getMetadata: async () => [{ metadata: objects.get(name).metadata }], delete: async () => { objects.delete(name); } }) };
require.cache[require.resolve("../src/config/firebase")] = { exports: { db, auth, getStorageBucket: () => bucket } };

const { auditFixture } = require("./integration/sampleMonitoringBrowserAudit");
const { cleanupFixture, fixturePath, manifestPath, evidenceDirectory } = require("./integration/phase3cBrowserFixtureCleanup");
const { rid } = require("../src/services/sampleMonitoringEvidence.service");
const visitId = (cohortId, date) =>require("../src/services/sampleMonitoringVisit.service")._test.id(cohortId, date);
const DATE = "2026-11-24";

// The first-visit seed of phase3cBrowserServer.js: manifest, users, site, source, report and a plan-less cohort; no visit.
function seedFirstVisit({ withVisit = false } = {}) {
  tables.clear(); objects.clear(); users.clear();
  const prefix = `phase3c-browser-${randomUUID()}`, cohortId = `${prefix}-cohort`, siteId = `${prefix}-site`, id = visitId(cohortId, DATE);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(manifestPath(prefix), JSON.stringify({ prefix, project: PROJECT, visitId: id, visitDate: DATE, formAcceptance: true, combinedWorkflow: false, mode: "first-visit" }));
  for (const role of ["admin", "staff", "participant", "otherStaff"]) {
    users.set(`${prefix}-${role}`, { uid: `${prefix}-${role}`, email: `${role}.${prefix}@example.test` });
    table("users").set(`${prefix}-${role}`, { role, testFixture: prefix });
  }
  table("sites").set(siteId, { testFixture: prefix });
  table("seedlingRequests").set(`${prefix}-source`, { testFixture: prefix });
  table("plantingReports").set(`${prefix}-report`, { testFixture: prefix });
  table("verifiedPlantingCohorts").set(cohortId, { source: { siteId, plantingReportId: `${prefix}-report` }, baseline: null, testFixture: prefix });
  // Dashboard counters are recorded in the per-run ledger (formAcceptance mode).
  table("counters").set(`${prefix}_plantingReports`, { value: 1 });
  fs.writeFileSync(path.join(evidenceDirectory, `${prefix}.counter-refs.jsonl`), `${JSON.stringify(`${prefix}_plantingReports`)}\n`);
  // An unrelated record must survive cleanup.
  table("sites").set("someone-else", { testFixture: "other" });
  if (withVisit) {
    table("verifiedPlantingCohorts").get(cohortId).samplingPlan = { origin: "FIRST_VISIT", status: "DRAFT", version: 1 };
    table("sampleMonitoringVisits").set(id, { createdBy: `${prefix}-staff`, cohortId, siteId, status: "DRAFT", version: 0,
      sampleAssessments: [{ sampleId: "T001", assessmentRevision: 0, evidenceHistory: [] }] });
  }
  const fixture = { prefix, project: PROJECT, visitId: id, visitDate: DATE, mode: "first-visit", cohortId };
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  return fixture;
}
function addEvidence(fixture, { tamper = false } = {}) {
  const staffId = `${fixture.prefix}-staff`, recordId = rid(fixture.visitId, "T001", 0);
  const bytes = Buffer.from("jpeg-bytes"), uploadIntentId = randomUUID(), objectName = `evidence/v1/sample-monitoring/${recordId}/${uploadIntentId}`;
  objects.set(objectName, { bytes: tamper ? Buffer.from("other") : bytes,
    metadata: { uploadIntentId, actorScope: createHash("sha256").update(staffId).digest("hex") } });
  table("evidenceUploadIntents").set(uploadIntentId, { status: "LINKED", actorId: staffId, actorKind: "user", evidenceType: "sample-monitoring",
    bucket: BUCKET, recordId, objectName });
  table("sampleMonitoringVisits").get(fixture.visitId).sampleAssessments[0].evidenceHistory.push({ revision: 0, location: { latitude: 12.6, longitude: 123.9 },
    privateEvidence: { bucket: BUCKET, objectName, uploadIntentId, sha256: createHash("sha256").update(bytes).digest("hex") } });
}
const audit = fixture => auditFixture({ fixture, db, bucket });

test("H-1 audit: a first-visit run that failed before visit 1 is a valid no-visit / no-evidence result", async () => {
  const fixture = seedFirstVisit();
  const result = await audit(fixture);
  assert.equal(result.monitoringEvidenceAudit, true);
  assert.equal(result.visitCreated, false);
  assert.equal(result.visitId, fixture.visitId);
  assert.deepEqual(result.trees, []);
  assert.equal(result.status, null);
});

test("H-1 audit stays strict: a missing default-mode visit, a stray cohort visit, or a foreign visit still fail", async () => {
  const fixture = seedFirstVisit();
  await assert.rejects(() => audit({ ...fixture, mode: undefined }), /seeded monitoring visit is missing/);
  table("sampleMonitoringVisits").set("VPMV-other-date", { cohortId: fixture.cohortId, createdBy: `${fixture.prefix}-staff` });
  await assert.rejects(() => audit(fixture), /unexpected id/);
  const created = seedFirstVisit({ withVisit: true });
  table("sampleMonitoringVisits").get(created.visitId).createdBy = "intruder";
  await assert.rejects(() => audit(created), assert.AssertionError);
});

test("H-1 audit: a created visit with an empty evidence set is valid; evidence is still verified byte for byte", async () => {
  const fixture = seedFirstVisit({ withVisit: true });
  const empty = await audit(fixture);
  assert.equal(empty.visitCreated, true);
  assert.equal(empty.status, "DRAFT");
  assert.deepEqual(empty.trees, [{ sampleId: "T001", assessmentRevision: 0, evidence: [] }]);
  addEvidence(fixture);
  assert.equal((await audit(fixture)).trees[0].evidence[0].sha256Matches, true);
  const tampered = seedFirstVisit({ withVisit: true }); addEvidence(tampered, { tamper: true });
  await assert.rejects(() => audit(tampered), assert.AssertionError);
  const malformed = seedFirstVisit({ withVisit: true });
  table("sampleMonitoringVisits").get(malformed.visitId).sampleAssessments[0].evidenceHistory.push({ revision: 0 });
  await assert.rejects(() => audit(malformed), /private evidence reference/);
});

test("H-1 cleanup removes a first-visit fixture with no visit (cohort, report, source, site, counters, users) and is repeatable", async () => {
  const fixture = seedFirstVisit();
  const first = await cleanupFixture(fixture.prefix);
  assert.equal(first.verified, true);
  assert.equal(first.usersRemoved, 4);
  assert.equal(users.size, 0);
  for (const [c, id] of [["verifiedPlantingCohorts", fixture.cohortId], ["plantingReports", `${fixture.prefix}-report`],
    ["seedlingRequests", `${fixture.prefix}-source`], ["sites", `${fixture.prefix}-site`], ["counters", `${fixture.prefix}_plantingReports`],
    ["users", `${fixture.prefix}-staff`]]) assert.equal(table(c).has(id), false, `${c}/${id}`);
  assert.equal(table("sites").has("someone-else"), true);
  assert.equal(fs.existsSync(fixturePath), false);
  const second = await cleanupFixture(fixture.prefix);
  assert.deepEqual([second.verified, second.usersRemoved, second.recordsRemoved, second.objectsRemoved], [true, 0, 0, 0]);
});

test("H-1 cleanup removes a first-visit fixture whose visit 1 and plan were created", async () => {
  const fixture = seedFirstVisit({ withVisit: true }); addEvidence(fixture);
  const result = await cleanupFixture(fixture.prefix);
  assert.equal(result.verified, true);
  assert.equal(result.objectsRemoved, 1);
  assert.equal(table("sampleMonitoringVisits").has(fixture.visitId), false);
  assert.equal(table("verifiedPlantingCohorts").has(fixture.cohortId), false);
  assert.equal(objects.size, 0);
});
