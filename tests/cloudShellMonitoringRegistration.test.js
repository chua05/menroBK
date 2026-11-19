const test = require("node:test");
const assert = require("node:assert/strict");
const { PRODUCTION_PROJECT, PRODUCTION_TARGETS } = require("../src/services/monitoringLifecycleBackfill.service");
const { REQUIRED_READ_PERMISSIONS } = require("../scripts/cloudShellMonitoringPreflight");
const { CONFIRM_REPORTS, REQUIRED_WRITE_PERMISSIONS, parseRegistrationArguments, runCloudShellRegistration } = require("../scripts/cloudShellMonitoringRegistration");
const { assessPlan, planDigest } = require("../src/services/monitoringLifecycleTargetedRegistration.service");

const PRINCIPAL = "operator@example.org";
const BASE = [`--expected-project=${PRODUCTION_PROJECT}`, `--expected-principal=${PRINCIPAL}`];
const EXECUTE = (digest) => [...BASE, "--execute", `--confirm-project=${PRODUCTION_PROJECT}`, `--confirm-reports=${CONFIRM_REPORTS}`, `--confirm-plan=${digest}`];
const ENV = Object.freeze({ NODE_ENV: "production", FIREBASE_PROJECT_ID: PRODUCTION_PROJECT, GOOGLE_CLOUD_PROJECT: PRODUCTION_PROJECT });

// Memory Firestore that only allows read-only transactions: any write transaction fails the test.
function memoryDb({ projectId = PRODUCTION_PROJECT, databaseId = "(default)" } = {}) {
  const data = { plantingReports: new Map(), monitoringRecords: new Map(), counters: new Map() };
  for (const target of PRODUCTION_TARGETS) data.plantingReports.set(target.reportId, { reportNumber: target.reportNumber, participantId: "p", eventId: `e-${target.reportId}`,
    siteId: "s", verificationStatus: "Completed", reportingProgress: "Completed", reportingPolicy: { definition: { monitoring: "STAFF_SPOT_CHECK" } } });
  const snap = (collection, id) => ({ id, exists: data[collection].has(id), data: () => structuredClone(data[collection].get(id)) });
  const query = (collection, filters = [], max = Infinity) => ({ query: true, collection, filters, max,
    where: (f, op, v) => query(collection, [...filters, [f, op, v]], max), select: () => query(collection, filters, max), limit: n => query(collection, filters, n), doc: id => ({ collection, id }) });
  const tx = {
    async getAll(...refs) { if (refs.at(-1)?.fieldMask) refs.pop(); return refs.map(ref => snap(ref.collection, ref.id)); },
    async get(ref) { if (!ref.query) return snap(ref.collection, ref.id);
      return { docs: [...data[ref.collection]].filter(([, v]) => ref.filters.every(([f, op, e]) => op === "==" ? v[f] === e : e.includes(v[f]))).slice(0, ref.max).map(([id]) => snap(ref.collection, id)) }; },
  };
  let writeTransactions = 0;
  const db = { projectId, databaseId, collection: name => query(name),
    async runTransaction(run, options) { if (options?.readOnly !== true) { writeTransactions++; throw new Error("UNEXPECTED WRITE TRANSACTION"); } return run(tx); } };
  return { db, data, get writeTransactions() { return writeTransactions; } };
}

function harness({ argv, env = ENV, email = PRINCIPAL, permissions = [...REQUIRED_READ_PERMISSIONS, ...REQUIRED_WRITE_PERMISSIONS], store = memoryDb(), databaseType = "FIRESTORE_NATIVE" } = {}) {
  let initialized = 0; const calls = [];
  const request = async (method, url, options = {}) => {
    calls.push(url);
    if (url.includes("tokeninfo")) return { status: 200, json: { email, email_verified: "true" } };
    if (url.includes(":testIamPermissions")) return { status: 200, json: { permissions: permissions.filter(p => options.json.permissions.includes(p)) } };
    if (url.includes("/databases/")) return { status: 200, json: { name: `projects/${PRODUCTION_PROJECT}/databases/(default)`, type: databaseType } };
    throw new Error(url);
  };
  const auth = { getProjectId: async () => PRODUCTION_PROJECT, getAccessToken: async () => "adc-token" };
  const initFirestore = async ({ projectId }) => { initialized++; return { db: store.db, app: { options: { projectId } } }; };
  return { run: () => runCloudShellRegistration({ argv, env, auth, request, initFirestore }), store, calls, get initialized() { return initialized; } };
}

test("arguments: dry run by default; --execute requires every exact confirmation; nothing else is accepted", () => {
  assert.deepEqual(parseRegistrationArguments(BASE), { expectedProject: PRODUCTION_PROJECT, expectedPrincipal: PRINCIPAL, execute: false, confirmPlanDigest: null });
  assert.equal(parseRegistrationArguments(EXECUTE("0123456789abcdef")).execute, true);
  assert.equal(CONFIRM_REPORTS, "event_EVT-2026-025,event_EVT-2026-029");
  for (const argv of [[...BASE, "--execute"], [...BASE, "--confirm-plan=0123456789abcdef"], EXECUTE("short"),
    EXECUTE("0123456789abcdef").map(a => a.startsWith("--confirm-project") ? "--confirm-project=other" : a),
    EXECUTE("0123456789abcdef").map(a => a.startsWith("--confirm-reports") ? "--confirm-reports=event_EVT-2026-025" : a),
    [...BASE, "--apply"], [...BASE, "--report-id=x"], [...BASE, "--execute=yes"], [BASE[0]], ["--expected-project=other", BASE[1]]]) {
    assert.throws(() => parseRegistrationArguments(argv), /\[arguments\]/, JSON.stringify(argv));
  }
});

test("wrong environment, account, permissions or database stop before Firestore is initialized", async () => {
  for (const [setup, step] of [[{ env: { ...ENV, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" } }, "environment"], [{ env: { ...ENV, NODE_ENV: "test" } }, "environment"],
    [{ env: { ...ENV, GOOGLE_APPLICATION_CREDENTIALS: "/key.json" } }, "environment"], [{ email: "other@example.org" }, "identity"],
    [{ argv: EXECUTE("0123456789abcdef"), permissions: REQUIRED_READ_PERMISSIONS }, "permissions"], [{ databaseType: "DATASTORE_MODE" }, "database"]]) {
    const h = harness({ argv: BASE, ...setup });
    await assert.rejects(h.run(), error => error.message.startsWith(`[${step}]`), JSON.stringify(setup));
    assert.equal(h.initialized, 0);
  }
  const wrongDb = harness({ argv: BASE, store: memoryDb({ projectId: "other-project" }) });
  await assert.rejects(wrongDb.run(), /\[database\]/);
});

test("dry run needs only read permissions, writes nothing and prints an executable plan with its digest", async () => {
  const h = harness({ argv: BASE, permissions: REQUIRED_READ_PERMISSIONS });
  const result = await h.run();
  assert.equal(result.mode, "dry-run");
  assert.equal(result.executable, true);
  assert.deepEqual(result.blockers, []);
  assert.match(result.planDigest, /^[0-9a-f]{16}$/);
  assert.match(result.next, new RegExp(`--confirm-plan=${result.planDigest}$`));
  assert.deepEqual(result.preflight.plan.map(row => row.action), ["REGISTER", "REGISTER"]);
  assert.equal(h.store.writeTransactions, 0);
});

test("execute with a stale or wrong digest stops before any write transaction", async () => {
  const h = harness({ argv: EXECUTE("0123456789abcdef") });
  await assert.rejects(h.run(), error => /\[confirmation\]/.test(error.message) && /^[0-9a-f]{16}$/.test(error.details.planDigest));
  assert.equal(h.store.writeTransactions, 0);
});

test("execute refuses a blocked or non-Staff-Spot-Check plan even with the matching digest", async () => {
  const store = memoryDb();
  store.data.plantingReports.get(PRODUCTION_TARGETS[1].reportId).reportingPolicy = { definition: { monitoring: "PERMANENT_SAMPLE" } };
  const dry = await harness({ argv: BASE, store }).run();
  assert.equal(dry.executable, false);
  assert.ok(dry.blockers.includes(`${PRODUCTION_TARGETS[1].reportId}:METHOD_PERMANENT_SAMPLE`));
  const h = harness({ argv: EXECUTE(dry.planDigest), store });
  await assert.rejects(h.run(), /\[preflight\]/);
  assert.equal(store.writeTransactions, 0);
});

test("plan digest changes whenever reviewed state changes", () => {
  const base = { projectId: "p", databaseId: "(default)", monitoringRecordsScanned: 0, readOnly: true, blocked: false,
    numberIntegrity: { year: 2026, counterExists: false, counterLastNumber: null, counterState: "ABSENT_FIRST_ALLOCATION", maximumExistingSequence: 0, reasons: [] },
    plan: [{ reportId: "a", reportNumber: "RPT-1", action: "REGISTER", monitoringMethod: "STAFF_SPOT_CHECK", canonicalLifecycleId: "MON-x", lifecycles: [] }] };
  const digest = planDigest(base);
  assert.equal(planDigest(structuredClone(base)), digest);
  assert.notEqual(planDigest({ ...base, monitoringRecordsScanned: 1 }), digest);
  assert.notEqual(planDigest({ ...base, numberIntegrity: { ...base.numberIntegrity, counterExists: true, counterLastNumber: 3 } }), digest);
  assert.notEqual(planDigest({ ...base, plan: [{ ...base.plan[0], action: "KEEP" }] }), digest);
  assert.deepEqual(assessPlan(base, "STAFF_SPOT_CHECK"), []);
  assert.deepEqual(assessPlan({ ...base, blocked: true, numberIntegrity: { ...base.numberIntegrity, reasons: ["DUPLICATE_MONITORING_NUMBERS"] } }, "STAFF_SPOT_CHECK"),
    ["PREFLIGHT_BLOCKED", "NUMBERING:DUPLICATE_MONITORING_NUMBERS"]);
});

test("loading the Cloud Shell tools never loads the backend's key-based Firebase configuration", () => {
  // Fresh process: the unit suite itself may have loaded src/config/firebase.js in test mode.
  const script = "require('./scripts/cloudShellMonitoringRegistration.js'); require('./scripts/cloudShellMonitoringPreflight.js');" +
    "process.stdout.write(String(Object.keys(require.cache).some(p => /config[\\\\/]firebase\\.js$/.test(p))));";
  const result = require("node:child_process").spawnSync(process.execPath, ["-e", script], { cwd: require("node:path").join(__dirname, ".."), encoding: "utf8",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "false");
});
