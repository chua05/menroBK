// Emulator acceptance (isolated legacy-monitoring topology, fresh dataset) for the target-scoped historical
// Monitoring Lifecycle registration: real Firestore transactions, first counter creation, idempotent repeat,
// concurrent numbering, partial failure with safe retry, duplicate/counter conflict rejection, no unrelated writes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

const integration = validateIntegrationEnvironment();
assert.equal(integration.legacyMonitoringIsolated, true, "requires the isolated legacy-monitoring emulators");
const { db, app } = require("../../src/config/firebase");
const registration = require("../../src/services/monitoringLifecycleRegistration.service");
const { lifecycleId } = require("../../src/utils/monitoringLifecycleId.util");
const { createTargetedRegistration } = require("../../src/services/monitoringLifecycleTargetedRegistration.service");

const RUN = randomUUID();
const YEAR = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric" }).format(new Date()));
const COUNTER = db.collection("counters").doc(`monitoringRecords_${YEAR}`);
const POLICY = { definition: { monitoring: "STAFF_SPOT_CHECK", reporting: "REQUIRED" }, policyVersion: 0 };
const seeded = [];
const mon = (n) => `MON-${YEAR}-${String(n).padStart(3, "0")}`;

async function seedPair(label, extra = {}) {
  const targets = [];
  for (const n of ["a", "b"]) {
    const reportId = `${RUN}-${label}-${n}`, reportNumber = `RPT-${label}-${n}-${RUN.slice(0, 8)}`;
    await db.collection("plantingReports").doc(reportId).set({ reportNumber, participantId: `${RUN}-participant`, eventId: `${RUN}-event-${label}-${n}`, siteId: `${RUN}-site`,
      siteName: "Bical Site", plantingDate: "2026-10-01", acceptedQuantity: 20, verificationStatus: "Completed", reportingProgress: "Completed", reportingPolicy: POLICY,
      history: [{ id: "report-history-entry" }], ...extra });
    seeded.push(reportId); targets.push({ reportId, reportNumber });
  }
  return targets;
}
const service = (targets, options = {}) => createTargetedRegistration({ db, app, targets, ...options });
const lifecyclesOf = async (reportId) => (await db.collection("monitoringRecords").where("plantingReportId", "==", reportId).get()).docs;
async function snapshot() {
  const out = {};
  for (const name of ["plantingReports", "monitoringRecords", "counters", "unrelatedCollection"]) out[name] = Object.fromEntries((await db.collection(name).get()).docs.map(doc => [doc.id, doc.data()]));
  return out;
}

test.before(async () => {
  assert.equal((await COUNTER.get()).exists, false, "requires a fresh emulator: no current-year counter");
  assert.equal((await db.collection("monitoringRecords").limit(1).get()).size, 0, "requires a fresh emulator: no monitoring records");
  await db.collection("unrelatedCollection").doc(`${RUN}-untouched`).set({ value: 1 });
  await db.collection("plantingReports").doc(`${RUN}-unrelated-report`).set({ reportNumber: `RPT-UNRELATED-${RUN}`, verificationStatus: "Completed", reportingPolicy: POLICY });
});

test.after(async () => {
  for (const reportId of [...seeded, `${RUN}-unrelated-report`]) {
    for (const doc of await lifecyclesOf(reportId)) await doc.ref.delete();
    await db.collection("plantingReports").doc(reportId).delete();
  }
  for (const doc of (await db.collection("monitoringRecords").get()).docs) if (doc.id.startsWith(RUN)) await doc.ref.delete();
  await db.collection("unrelatedCollection").doc(`${RUN}-untouched`).delete();
  await COUNTER.delete();
});

test("successful two-report registration creates the first counter, sequential MON IDs and nothing else", async () => {
  const targets = await seedPair("main");
  const tool = service(targets);
  const dry = await tool.dryRun();
  assert.deepEqual([dry.blockers, dry.preflight.plan.map(row => row.action), dry.preflight.numberIntegrity.counterState], [[], ["REGISTER", "REGISTER"], "ABSENT_FIRST_ALLOCATION"]);
  const before = await snapshot();

  await assert.rejects(tool.execute({ confirmPlanDigest: "0000000000000000" }), /\[confirmation\]/);
  assert.deepEqual(await snapshot(), before, "a wrong digest writes nothing");

  const result = await tool.execute({ confirmPlanDigest: dry.planDigest });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.results.map(row => [row.reportId, row.status, row.monitoringNumber]), [[targets[0].reportId, "REGISTERED", mon(1)], [targets[1].reportId, "REGISTERED", mon(2)]]);
  assert.equal(result.postVerification.ok, true, JSON.stringify(result.postVerification.problems));
  assert.deepEqual([result.postVerification.counterState, result.postVerification.counterLastNumber], ["CONSISTENT", 2]);

  const after = await snapshot();
  // Only the two lifecycles and the new counter differ; reports (policy, history) and unrelated data are unchanged.
  assert.deepEqual(after.plantingReports, before.plantingReports);
  assert.deepEqual(after.unrelatedCollection, before.unrelatedCollection);
  assert.deepEqual(Object.keys(after.monitoringRecords).sort(), targets.map(t => lifecycleId(`${RUN}-participant`, t.reportId, `${RUN}-event-main-${t.reportId.at(-1)}`, `${RUN}-site`)).sort());
  assert.deepEqual(Object.keys(after.counters).filter(id => !(id in before.counters)), [`monitoringRecords_${YEAR}`]);
  assert.deepEqual([after.counters[`monitoringRecords_${YEAR}`].year, after.counters[`monitoringRecords_${YEAR}`].lastNumber], [YEAR, 2]);
  for (const record of Object.values(after.monitoringRecords)) {
    assert.deepEqual([record.monitoringMethod, record.scheduleStatus, record.startMonitoringDate, record.nextMonitoringDate, record.monitoringEndDate, record.history, record.archived],
      ["STAFF_SPOT_CHECK", "AWAITING_MONITORING_POLICY", null, null, null, [], false]);
  }
});

test("repeated execution is NO_CHANGE and allocates nothing", async () => {
  const targets = seeded.slice(0, 2).map(reportId => ({ reportId, reportNumber: `RPT-main-${reportId.at(-1)}-${RUN.slice(0, 8)}` }));
  const tool = service(targets);
  const dry = await tool.dryRun();
  assert.deepEqual(dry.preflight.plan.map(row => row.action), ["KEEP", "KEEP"]);
  const before = await snapshot();
  const result = await tool.execute({ confirmPlanDigest: dry.planDigest });
  assert.deepEqual(result.results.map(row => [row.status, row.monitoringNumber]), [["NO_CHANGE", mon(1)], ["NO_CHANGE", mon(2)]]);
  assert.deepEqual(await snapshot(), before);
});

test("concurrent executions and a concurrent normal verification never share or skip a number", async () => {
  const targets = await seedPair("concurrent");
  const [third] = await seedPair("verification");
  const dry = await service(targets).dryRun();
  const [first, second, normal] = await Promise.all([service(targets).execute({ confirmPlanDigest: dry.planDigest }),
    service(targets).execute({ confirmPlanDigest: dry.planDigest }), registration.registerMonitoringLifecycle({ reportId: third.reportId })]);
  assert.equal(first.status, "COMPLETED"); assert.equal(second.status, "COMPLETED");
  for (const target of [...targets, third]) assert.equal((await lifecyclesOf(target.reportId)).length, 1, target.reportId);
  const numbers = (await db.collection("monitoringRecords").get()).docs.map(doc => doc.data().monitoringNumber).sort();
  assert.deepEqual(numbers, [1, 2, 3, 4, 5].map(mon), "unique and gap-free across concurrent registrations");
  assert.equal((await COUNTER.get()).data().lastNumber, 5);
  assert.equal(normal.status, "REGISTERED");
});

test("partial failure leaves the failed report untouched and a reviewed retry completes it", async () => {
  const targets = await seedPair("partial");
  let writeTransactions = 0;
  const flaky = { projectId: db.projectId, databaseId: db.databaseId, collection: (...args) => db.collection(...args),
    runTransaction: (run, options) => {
      if (options?.readOnly !== true && ++writeTransactions === 2) return Promise.reject(new Error("simulated network outage"));
      return db.runTransaction(run, options);
    } };
  const dry = await service(targets).dryRun();
  const partial = await createTargetedRegistration({ db: flaky, app, targets }).execute({ confirmPlanDigest: dry.planDigest });
  assert.equal(partial.status, "PARTIAL");
  assert.deepEqual(partial.completed.map(row => [row.reportId, row.status, row.monitoringNumber]), [[targets[0].reportId, "REGISTERED", mon(6)]]);
  assert.deepEqual([partial.failedReportId, partial.notCompleted], [targets[1].reportId, [targets[1].reportId]]);
  assert.match(partial.recovery.join(" "), /re-run the dry run/);
  assert.equal((await lifecyclesOf(targets[1].reportId)).length, 0, "failed report has no lifecycle");
  assert.equal((await COUNTER.get()).data().lastNumber, 6, "failed report consumed no number");

  const tool = service(targets);
  await assert.rejects(tool.execute({ confirmPlanDigest: dry.planDigest }), /\[confirmation\]/, "the old digest no longer matches");
  const retryPlan = await tool.dryRun();
  assert.deepEqual(retryPlan.preflight.plan.map(row => row.action), ["KEEP", "REGISTER"]);
  const retried = await tool.execute({ confirmPlanDigest: retryPlan.planDigest });
  assert.deepEqual(retried.results.map(row => [row.status, row.monitoringNumber]), [["NO_CHANGE", mon(6)], ["REGISTERED", mon(7)]]);
  assert.equal(retried.postVerification.ok, true);
});

test("duplicate lifecycles and counter conflicts are rejected without writes, both at preflight and inside the transaction", async () => {
  const targets = await seedPair("conflict");
  const strayRef = db.collection("monitoringRecords").doc(`${RUN}-noncanonical`);
  await strayRef.set({ plantingReportId: targets[0].reportId, monitoringMethod: "STAFF_SPOT_CHECK" });
  const tool = service(targets);
  let before = await snapshot();
  assert.ok((await tool.dryRun()).blockers.includes("PREFLIGHT_BLOCKED"));
  await assert.rejects(tool.registerTarget(targets[0]), /noncanonical or duplicate lifecycle/);
  assert.deepEqual(await snapshot(), before);
  await strayRef.delete();

  const counter = (await COUNTER.get()).data();
  await COUNTER.update({ lastNumber: 1 });
  before = await snapshot();
  assert.ok((await tool.dryRun()).blockers.includes("NUMBERING:COUNTER_BEHIND_EXISTING_NUMBERS"));
  await assert.rejects(tool.registerTarget(targets[0]), /\[numbering\].*behind/);
  assert.deepEqual(await snapshot(), before);

  await COUNTER.set(counter);
  await db.collection("monitoringRecords").doc(`${RUN}-dup-number`).set({ plantingReportId: `${RUN}-elsewhere`, monitoringNumber: mon(1), archived: true });
  before = await snapshot();
  await assert.rejects(tool.registerTarget(targets[0]), /\[numbering\] Duplicate/);
  assert.deepEqual(await snapshot(), before);
  await db.collection("monitoringRecords").doc(`${RUN}-dup-number`).delete();
});

test("a production project or non-Staff-Spot-Check policy is refused against this dataset", async () => {
  const targets = await seedPair("guard");
  const before = await snapshot();
  await assert.rejects(service(targets, { expectedProject: "menrosystem-ddfac" }).dryRun(), /Refusing preflight/);
  await db.collection("plantingReports").doc(targets[1].reportId).update({ reportingPolicy: { definition: { monitoring: "PERMANENT_SAMPLE" } } });
  const dry = await service(targets).dryRun();
  assert.ok(dry.blockers.includes(`${targets[1].reportId}:METHOD_PERMANENT_SAMPLE`));
  await assert.rejects(service(targets).execute({ confirmPlanDigest: dry.planDigest }), /\[preflight\]/);
  await assert.rejects(service(targets).registerTarget(targets[1]), /not STAFF_SPOT_CHECK/);
  const after = await snapshot();
  delete before.plantingReports[targets[1].reportId]; delete after.plantingReports[targets[1].reportId];
  assert.deepEqual(after, before);
});
