const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { PRODUCTION_PROJECT, PRODUCTION_TARGETS, createMonitoringLifecycleBackfill } = require("../src/services/monitoringLifecycleBackfill.service");
const registration = require("../src/services/monitoringLifecycleRegistration.service");
const { lifecycleId } = require("../src/services/monitoring.service");
const { parseArguments, runBackfill } = require("../scripts/backfillMonitoringLifecycles");

// Memory-only fixture: production-shaped IDs never reach a Firebase service.
function fixture({ project = PRODUCTION_PROJECT, database = "(default)", targets = PRODUCTION_TARGETS, env = { NODE_ENV: "production", FIREBASE_PROJECT_ID: PRODUCTION_PROJECT }, appProject = project } = {}) {
  const data = { plantingReports: new Map(), monitoringRecords: new Map(), counters: new Map() };
  for (const target of targets) data.plantingReports.set(target.reportId, { reportNumber: target.reportNumber, participantId: "fixture-user", eventId: `fixture-event-${target.reportId}`,
    siteId: "fixture-site", reportingProgress: "Completed", verificationStatus: "Completed", verifiedAt: "2026-11-01T00:00:00Z",
    reportingPolicy: { definition: { monitoring: "STAFF_SPOT_CHECK" } }, participantName: "PRIVATE NAME", photos: ["PRIVATE PHOTO"], latitude: 12.65 });
  let reads = 0, transactions = 0;
  function snapshot(collection, id) { return { id, exists: data[collection].has(id), data: () => structuredClone(data[collection].get(id)) }; }
  function query(collection, filters = [], maximum = Infinity) {
    return { query: true, collection, filters, maximum,
      where(field, op, value) { return query(collection, [...filters, [field, op, value]], maximum); },
      select() { return query(collection, filters, maximum); }, limit(count) { return query(collection, filters, count); }, doc(id) { return { collection, id }; } };
  }
  const tx = { async getAll(...refs) { reads++; if (refs.at(-1)?.fieldMask) refs.pop(); return refs.map(ref => snapshot(ref.collection, ref.id)); },
    async get(ref) { reads++; if (!ref.query) return snapshot(ref.collection, ref.id);
      const entries = [...data[ref.collection]].filter(([, value]) => ref.filters.every(([field, op, expected]) => op === "==" ? value[field] === expected : op === "in" && expected.includes(value[field]))).slice(0, ref.maximum);
      return { docs: entries.map(([id]) => snapshot(ref.collection, id)) }; },
    create() { throw Error("UNEXPECTED WRITE"); }, update() { throw Error("UNEXPECTED WRITE"); }, set() { throw Error("UNEXPECTED WRITE"); }, delete() { throw Error("UNEXPECTED WRITE"); } };
  const db = { projectId: project, databaseId: database, collection: name => query(name), async runTransaction(run, options) { assert.equal(options?.readOnly, true); transactions++; return run(tx); } };
  const service = createMonitoringLifecycleBackfill({ db, app: { options: { projectId: appProject } }, registration, lifecycleId, now: () => new Date("2026-11-18T18:00:00Z"), env });
  const options = { expectedProject: project, ...(project !== PRODUCTION_PROJECT ? { targets } : {}) };
  function canonical(target = targets[0], extra = {}) {
    const report = data.plantingReports.get(target.reportId), id = lifecycleId(report.participantId, target.reportId, report.eventId, report.siteId);
    data.monitoringRecords.set(id, { plantingReportId: target.reportId, participantId: report.participantId, eventId: report.eventId, siteId: report.siteId, monitoringMethod: registration.monitoringMethodOf(report), ...extra }); return id;
  }
  return { data, service, options, canonical, get reads() { return reads; }, get transactions() { return transactions; } };
}

test("project, default-database and contradictory declaration checks reject before any read", async () => {
  for (const [setup, options] of [[{}, {}], [{}, { expectedProject: "other-project" }], [{ database: "other" }, { expectedProject: PRODUCTION_PROJECT }],
    [{ appProject: "wrong" }, { expectedProject: PRODUCTION_PROJECT }], [{ env: { FIREBASE_PROJECT_ID: "wrong" } }, { expectedProject: PRODUCTION_PROJECT }],
    [{ env: {} }, { expectedProject: PRODUCTION_PROJECT }],
    [{ env: { NODE_ENV: "production", FIREBASE_PROJECT_ID: PRODUCTION_PROJECT, MENRO_PHASE3C_BROWSER_ACCEPTANCE: "true" } }, { expectedProject: PRODUCTION_PROJECT }],
    [{ env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8281" } }, { expectedProject: PRODUCTION_PROJECT }]]) {
    const f = fixture(setup); await assert.rejects(f.service.plan(options), /Refusing preflight/); assert.equal(f.reads, 0); assert.equal(f.transactions, 0);
  }
});

test("production scope accepts only the exact two approved document/number pairs", async () => {
  for (const targets of [[PRODUCTION_TARGETS[0]], [{ ...PRODUCTION_TARGETS[0], reportNumber: "RPT-OTHER" }, PRODUCTION_TARGETS[1]], [...PRODUCTION_TARGETS, { reportId: "third", reportNumber: "RPT-THIRD" }]]) {
    const f = fixture(); await assert.rejects(f.service.plan({ ...f.options, targets }), /restricted/); assert.equal(f.reads, 0);
  }
});

test("nested historical policy plan changes nothing, plans only targets and omits personal fields and allocated IDs", async () => {
  const f = fixture(); f.data.plantingReports.set("unrelated", { reportNumber: "RPT-UNRELATED", verificationStatus: "Approved" });
  const before = structuredClone(f.data), result = await f.service.plan(f.options);
  assert.deepEqual(result.plan.map(row => [row.reportId, row.action, row.monitoringMethod]), PRODUCTION_TARGETS.map(target => [target.reportId, "REGISTER", "STAFF_SPOT_CHECK"]));
  assert.equal(result.mode, "dry-run"); assert.equal(result.readOnly, true); assert.equal(result.targetCount, 2); assert.equal(result.proposedChangeCount, 2);
  assert.equal(result.otherReportsPlanned, 0); assert.equal(result.blocked, false); assert.ok(result.plan.every(row => row.scheduleEffect === "AWAITING_MONITORING_POLICY_NO_DATES"));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE NAME|PRIVATE PHOTO|fixture-user|fixture-site|RPT-UNRELATED/);
  assert.deepEqual(f.data, before); assert.equal(f.data.counters.size, 0); assert.deepEqual(await f.service.plan(f.options), result);
});

test("canonical lifecycles are KEEP or ASSIGN_NUMBER without changing history or dates", async () => {
  const f = fixture(); f.canonical(PRODUCTION_TARGETS[0], { monitoringNumber: "MON-2026-005", history: [{ id: "old" }], startMonitoringDate: "2026-11-04" });
  f.canonical(PRODUCTION_TARGETS[1], { history: [{ id: "original" }], nextMonitoringDate: "2026-12-01" }); f.data.counters.set("monitoringRecords_2026", { year: 2026, lastNumber: 5 });
  const before = structuredClone(f.data), result = await f.service.plan(f.options);
  assert.deepEqual(result.plan.map(row => row.action), ["KEEP", "ASSIGN_NUMBER"]); assert.equal(result.plan[0].lifecycles[0].monitoringNumber, "MON-2026-005");
  assert.equal(result.plan[1].lifecycles[0].nextMonitoringDate, "2026-12-01"); assert.deepEqual(f.data, before);
});

test("archived, duplicate, noncanonical and mismatched lifecycle relationships block", async () => {
  for (const [setup, reason] of [[f => f.canonical(undefined, { archived: true }), "LIFECYCLE_ARCHIVED"],
    [f => f.data.monitoringRecords.set("old-document", { plantingReportId: PRODUCTION_TARGETS[0].reportId }), "NONCANONICAL_LIFECYCLE"],
    [f => { f.canonical(); f.data.monitoringRecords.set("second", { plantingReportId: PRODUCTION_TARGETS[0].reportId }); }, "DUPLICATE_LIFECYCLES"],
    [f => f.canonical(undefined, { siteId: "wrong-site" }), "LIFECYCLE_RELATIONSHIP_MISMATCH"]]) {
    const f = fixture(); setup(f); const result = await f.service.plan(f.options); assert.equal(result.plan[0].action, "BLOCKED"); assert.ok(result.plan[0].reasons.includes(reason), reason);
  }
});

test("duplicate report numbers, missing/archived/unverified reports and conflicting policies block", async () => {
  for (const [setup, reason] of [[f => f.data.plantingReports.delete(PRODUCTION_TARGETS[0].reportId), "REPORT_NOT_FOUND"],
    [f => f.data.plantingReports.set("another", { reportNumber: PRODUCTION_TARGETS[0].reportNumber }), "REPORT_NUMBER_NOT_UNIQUE_OR_MISMATCHED"],
    [f => { f.data.plantingReports.get(PRODUCTION_TARGETS[0].reportId).archived = true; }, "REPORT_ARCHIVED"],
    [f => { Object.assign(f.data.plantingReports.get(PRODUCTION_TARGETS[0].reportId), { verificationStatus: "Pending", reportingProgress: "Awaiting Submission" }); }, "REPORT_NOT_ELIGIBLE"],
    [f => { f.data.plantingReports.get(PRODUCTION_TARGETS[0].reportId).reportingPolicy.monitoring = "NONE"; }, "MONITORING_POLICY_CONFLICT"],
    [f => { f.data.plantingReports.get(PRODUCTION_TARGETS[0].reportId).reportingPolicy.definition.monitoring = "NONE"; }, "REPORT_NOT_ELIGIBLE"]]) {
    const f = fixture(); setup(f); const result = await f.service.plan(f.options); assert.equal(result.plan[0].action, "BLOCKED"); assert.ok(result.plan[0].reasons.includes(reason), reason);
  }
});

test("existing lifecycle policy mismatch blocks instead of relabeling or changing stored evidence and dates", async () => {
  for (const monitoringMethod of [undefined, "UNSPECIFIED", "LEGACY", "PERMANENT_SAMPLE"]) {
    const f = fixture(); f.canonical(undefined, { monitoringMethod, monitoringNumber: "MON-2026-005", history: [{ id: "historical" }], nextMonitoringDate: "2026-12-01" });
    f.data.counters.set("monitoringRecords_2026", { year: 2026, lastNumber: 5 });
    const before = structuredClone(f.data), result = await f.service.plan(f.options);
    assert.equal(result.plan[0].action, "BLOCKED"); assert.ok(result.plan[0].reasons.includes("LIFECYCLE_POLICY_MISMATCH")); assert.deepEqual(f.data, before);
  }
  const legacy = fixture(); delete legacy.data.plantingReports.get(PRODUCTION_TARGETS[0].reportId).reportingPolicy;
  legacy.canonical(undefined, { monitoringMethod: undefined });
  assert.equal((await legacy.service.plan(legacy.options)).plan[0].action, "ASSIGN_NUMBER", "a historical aggregate lifecycle need not carry a new method field");
});

test("unspecified and unrecognized report policies block without inventing requirements", async () => {
  for (const policy of [{}, { definition: { monitoring: "FUTURE_UNAPPROVED_METHOD" } }, { monitoring: " " }]) {
    const f = fixture(); f.data.plantingReports.get(PRODUCTION_TARGETS[0].reportId).reportingPolicy = policy;
    const before = structuredClone(f.data), result = await f.service.plan(f.options);
    assert.equal(result.plan[0].action, "BLOCKED"); assert.ok(result.plan[0].reasons.includes("UNRECOGNIZED_MONITORING_POLICY")); assert.deepEqual(f.data, before);
  }
});

test("global integrity detects malformed and duplicate MONs including unrelated archived records", async () => {
  for (const [values, reason] of [[["MON-NOT-VALID"], "MALFORMED_MONITORING_NUMBERS"], [["MON-0000-001"], "MALFORMED_MONITORING_NUMBERS"],
    [["MON-2026-005", "mon-2026-005"], "DUPLICATE_MONITORING_NUMBERS"], [["MON-2026-005", "MON-2026-0005"], "DUPLICATE_MONITORING_NUMBERS"]]) {
    const f = fixture(); values.forEach((monitoringNumber, i) => f.data.monitoringRecords.set(`unrelated-${i}`, { monitoringNumber, archived: true }));
    f.data.counters.set("monitoringRecords_2026", { year: 2026, lastNumber: 5 }); const result = await f.service.plan(f.options);
    assert.ok(result.numberIntegrity.reasons.includes(reason)); assert.ok(result.plan.every(row => row.action === "BLOCKED")); assert.equal(result.otherReportsPlanned, 0);
  }
});

test("missing, stale, wrong-year, coerced and exhausted counters block without allocation", async () => {
  for (const [counter, reason] of [[null, "COUNTER_MISSING_WITH_EXISTING_NUMBERS"], [{ year: 2026, lastNumber: 2 }, "COUNTER_BEHIND_EXISTING_NUMBERS"],
    [{ year: 2025, lastNumber: 8 }, "INVALID_COUNTER"], [{ year: 2026, lastNumber: "8" }, "INVALID_COUNTER"], [{ year: 2026, lastNumber: Number.MAX_SAFE_INTEGER }, "COUNTER_EXHAUSTED"]]) {
    const f = fixture(); f.data.monitoringRecords.set("historical", { monitoringNumber: "MON-2026-005" }); if (counter) f.data.counters.set("monitoringRecords_2026", counter);
    const before = structuredClone(f.data), result = await f.service.plan(f.options); assert.ok(result.numberIntegrity.reasons.includes(reason), reason); assert.equal(result.blocked, true); assert.deepEqual(f.data, before);
  }
});

test("invalid legacy planting date is blocked instead of promising successful registration", async () => {
  const f = fixture(); delete f.data.plantingReports.get(PRODUCTION_TARGETS[0].reportId).reportingPolicy;
  assert.ok((await f.service.plan(f.options)).plan[0].reasons.includes("LEGACY_PLANTING_DATE_INVALID"));
});

test("UUID custom targets require the complete credential-free isolated demo topology", async () => {
  const project = "demo-menro-phase3c-isolated", targets = [{ reportId: `backfill-${randomUUID()}`, reportNumber: "RPT-FIXTURE" }];
  const env = { NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", MENRO_PHASE3C_ISOLATED_EMULATORS: "true", FIREBASE_PROJECT_ID: project, GCLOUD_PROJECT: project,
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8281", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9299", FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9298", FIREBASE_STORAGE_BUCKET: `${project}.firebasestorage.app` };
  const allowed = fixture({ project, targets, env }); assert.equal((await allowed.service.plan(allowed.options)).plan[0].action, "REGISTER");
  for (const changed of [{ ...env, MENRO_PHASE3C_ISOLATED_EMULATORS: undefined }, { ...env, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" }, { ...env, GOOGLE_APPLICATION_CREDENTIALS: "forbidden" }]) {
    const denied = fixture({ project, targets, env: changed }); await assert.rejects(denied.service.plan(denied.options)); assert.equal(denied.reads, 0);
  }
  const denied = fixture({ project, targets: PRODUCTION_TARGETS, env }); await assert.rejects(denied.service.plan(denied.options)); assert.equal(denied.reads, 0);
});

test("CLI and wrappers reject all write/global flags before Firebase initialization", async () => {
  for (const args of [[], ["--apply"], [`--expected-project=${PRODUCTION_PROJECT}`, "--apply"], ["--expected-project=wrong"], [`--expected-project=${PRODUCTION_PROJECT}`, "--report-id=third"]]) assert.throws(() => parseArguments(args), /Read-only/);
  assert.deepEqual(parseArguments([`--expected-project=${PRODUCTION_PROJECT}`]), { expectedProject: PRODUCTION_PROJECT, expectedDatabaseId: "(default)" });
  await assert.rejects(runBackfill({ apply: true, expectedProject: PRODUCTION_PROJECT }), /read-only/);
  await assert.rejects(runBackfill({ confirmProject: PRODUCTION_PROJECT, expectedProject: PRODUCTION_PROJECT }), /read-only/);
  await assert.rejects(runBackfill(), /before Firebase initialization/);
  await assert.rejects(runBackfill({ expectedProject: PRODUCTION_PROJECT }), /before Firebase initialization/);
  await assert.rejects(runBackfill({ expectedProject: "wrong-project" }), /isolated test environment before Firebase initialization/);
});
