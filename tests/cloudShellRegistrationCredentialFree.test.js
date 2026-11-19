// Regression for the failed production registration (19 November 2026): in Cloud Shell (NODE_ENV=production,
// ADC, no FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY), lifecycleDocument() loaded monitoring.service, whose
// import of the key-based Firebase app threw; the error was swallowed and reported as "registration was not
// applicable after revalidation". These tests reproduce those exact conditions in a child process.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");
const registration = require("../src/services/monitoringLifecycleRegistration.service");
const { sanitizeError } = require("../src/services/monitoringLifecycleTargetedRegistration.service");

const YEAR = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric" }).format(new Date());
const MON = (n) => `MON-${YEAR}-${String(n).padStart(3, "0")}`;

function runCloudShellConditions(scenario) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "production", FIREBASE_PROJECT_ID: "menrosystem-ddfac" };
  const result = spawnSync(process.execPath, [path.join(__dirname, "helpers", "credentialFreeRegistrationRun.js"), scenario], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const json = result.stdout.slice(result.stdout.indexOf("{"));
  const out = JSON.parse(json);
  assert.deepEqual(out.env, { NODE_ENV: "production", hasClientEmail: false, hasPrivateKey: false }, "reproduces the Cloud Shell environment");
  return out;
}

test("both historical reports register under Cloud Shell conditions without the key-based Firebase app", () => {
  const out = runCloudShellConditions("full");
  assert.deepEqual(out.dry, { executable: true, blockers: [], actions: ["REGISTER", "REGISTER"], counterState: "ABSENT_FIRST_ALLOCATION", writesAfterDryRun: 0 });
  assert.equal(out.first.status, "COMPLETED", out.first.error);
  assert.deepEqual(out.first.results.map(([reportId, status, number]) => [reportId, status, number]),
    [["event_EVT-2026-025", "REGISTERED", MON(1)], ["event_EVT-2026-029", "REGISTERED", MON(2)]]);
  assert.equal(out.first.post.ok, true, JSON.stringify(out.first.post.problems));
  for (const lifecycle of out.lifecycles) {
    assert.deepEqual([lifecycle.monitoringMethod, lifecycle.scheduleStatus, lifecycle.dates, lifecycle.history, lifecycle.archived],
      ["STAFF_SPOT_CHECK", "AWAITING_MONITORING_POLICY", [null, null, null], [], false]);
  }
  // First counter allocation, then one update; only lifecycles and the counter are written.
  assert.deepEqual([out.counter.year, out.counter.lastNumber], [Number(YEAR), 2]);
  assert.deepEqual(out.writes.map(w => w.replace(/MON-[0-9a-f]{20}/, "<lifecycle>")),
    [`create counters/monitoringRecords_${YEAR}`, "create monitoringRecords/<lifecycle>", `update counters/monitoringRecords_${YEAR}`, "create monitoringRecords/<lifecycle>"]);
  // Idempotent repeat.
  assert.deepEqual(out.repeat, { actions: ["KEEP", "KEEP"], results: [["NO_CHANGE", MON(1)], ["NO_CHANGE", MON(2)]], writesTotal: 4 });
  assert.equal(out.reportsUnchanged, true); assert.equal(out.unrelatedUntouched, true);
  assert.equal(out.loadedConfigFirebase, false, "src/config/firebase.js must never load on the Cloud Shell path");
  assert.equal(out.loadedMonitoringService, false, "monitoring.service must not load for STAFF_SPOT_CHECK");
});

test("partial failure under Cloud Shell conditions is reported, consumes no number, and a reviewed retry completes", () => {
  const out = runCloudShellConditions("partial");
  assert.equal(out.partial.status, "PARTIAL");
  assert.deepEqual(out.partial.completed, [["event_EVT-2026-025", "REGISTERED", MON(1)]]);
  assert.equal(out.partial.failedReportId, "event_EVT-2026-029");
  assert.match(out.partial.error, /^\[transaction\] event_EVT-2026-029: simulated commit failure/);
  assert.doesNotMatch(out.partial.error, /not applicable/);
  assert.equal(out.partial.lifecycleIds.length, 1); assert.equal(out.partial.counter, 1);
  assert.match(out.retry.staleDigestError, /^\[confirmation\]/);
  assert.deepEqual(out.retry.actions, ["KEEP", "REGISTER"]);
  assert.deepEqual(out.retry.results, [["NO_CHANGE", MON(1)], ["REGISTERED", MON(2)]]);
  assert.equal(out.retry.post, true); assert.equal(out.retry.counter, 2);
  assert.equal(out.reportsUnchanged, true); assert.equal(out.loadedConfigFirebase, false);
});

test("strict prepare surfaces a lifecycle build failure; default prepare keeps Admin verification non-blocking", async () => {
  const db = createMemoryFirestore({ projectId: "unit" });
  // LEGACY report without a valid planting date: baseLifecycle throws.
  const report = { reportNumber: "RPT-L", participantId: "p", eventId: "e", siteId: "s", verificationStatus: "Completed" };
  await db.runTransaction(async (tx) => {
    assert.equal(await registration.prepareLifecycleRegistrationInTransaction(tx, { reportId: "legacy-no-date", report, db }), null);
    await assert.rejects(registration.prepareLifecycleRegistrationInTransaction(tx, { reportId: "legacy-no-date", report, db, strict: true }),
      (error) => error instanceof registration.LifecycleRegistrationError && error.code === "LIFECYCLE_DOCUMENT_UNAVAILABLE" && Boolean(error.cause));
  });
  // LEGACY with a valid date still builds through monitoring.service.baseLifecycle (behavior preserved).
  await db.runTransaction(async (tx) => {
    const plan = await registration.prepareLifecycleRegistrationInTransaction(tx, { reportId: "legacy-ok", report: { ...report, plantingDate: "2026-10-01" }, db, strict: true });
    assert.equal(plan.candidate.monitoringMethod, "LEGACY");
    assert.equal(plan.candidate.startMonitoringDate, "2026-10-15");
  });
});

test("operator errors are sanitized and keep the actionable cause", () => {
  const error = new Error("The monitoring lifecycle document could not be prepared.", { cause: new Error("Missing Firebase environment variables: FIREBASE_CLIENT_EMAIL\n    at stack") });
  assert.equal(sanitizeError(error), "The monitoring lifecycle document could not be prepared. <- Missing Firebase environment variables: FIREBASE_CLIENT_EMAIL");
  assert.equal(sanitizeError(new Error("x -----BEGIN PRIVATE KEY-----abc\ndef-----END PRIVATE KEY----- token ya29.abc.def")), "x [redacted key]");
});
