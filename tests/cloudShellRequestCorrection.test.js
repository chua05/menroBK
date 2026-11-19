const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");
const { REQUIRED_READ_PERMISSIONS } = require("../scripts/cloudShellMonitoringPreflight");
const { TARGET_REQUEST_NUMBER, parseCorrectionArguments, runCloudShellRequestCorrection } = require("../scripts/cloudShellRequestCorrection");
const { assess } = require("../src/services/historicalStaffRequestCorrection.service");

const PROJECT = "menrosystem-ddfac", PRINCIPAL = "operator@example.org", ENCODER = "staff-encoder-uid", DOC = "walkin-doc-054";
const ENV = Object.freeze({ NODE_ENV: "production", FIREBASE_PROJECT_ID: PROJECT, GOOGLE_CLOUD_PROJECT: PROJECT });
const BASE = [`--expected-project=${PROJECT}`, `--expected-principal=${PRINCIPAL}`];
const EXECUTE = (digest, id = DOC) => [...BASE, "--execute", `--confirm-project=${PROJECT}`, `--confirm-request-number=${TARGET_REQUEST_NUMBER}`, `--confirm-request-id=${id}`,
  `--confirm-plan=${digest}`, "--confirm-backend-deployed=abc1234", "--reason=Route the pre-fix Staff walk-in to Admin approval"];

// Shape stored by the pre-fix backend for a Staff-encoded walk-in (REQ-2026-054).
const historical = () => ({ requestNumber: TARGET_REQUEST_NUMBER, status: "Pending", requestVersion: 0, participantId: "walkin_abc", participantName: "Walk-in Citizen",
  requesterRole: "walk-in", createdByRole: "staff", totalQuantity: 30, items: [{ inventoryId: "narra", species: "Narra", quantity: 30 }], eventId: "", eventCreated: false,
  inventoryReserved: false, inventoryDeducted: false, inventoryReleased: false, reviewedBy: "", reviewedAt: null,
  eventProposal: { plantingSiteId: "site-1", proposedDate: "2099-03-10", proposedStartTime: "08:00" }, workflow: { siteMode: "existing" },
  walkIn: { encodedBy: ENCODER, encodedByName: "Encoding Staff", citizenHasAccount: false },
  reviewHistory: [{ action: "submitted", actorId: ENCODER, actorName: "Encoding Staff", actorRole: "staff", actionBasis: "STAFF_ENCODED_WALK_IN", citizenRequesterId: "walkin_abc" }] });

function harness({ argv, permissions = [...REQUIRED_READ_PERMISSIONS, "datastore.entities.update"], record = historical() } = {}) {
  const store = createMemoryFirestore({ projectId: PROJECT });
  store.seed("seedlingRequests", DOC, record);
  store.seed("seedlingRequests", "other-doc", { ...historical(), requestNumber: "REQ-2026-055" });
  store.seed("users", ENCODER, { role: "staff", status: "active" });
  let initialized = 0;
  const request = async (method, url, options = {}) => {
    if (url.includes("tokeninfo")) return { status: 200, json: { email: PRINCIPAL, email_verified: "true" } };
    if (url.includes(":testIamPermissions")) return { status: 200, json: { permissions: permissions.filter((p) => options.json.permissions.includes(p)) } };
    if (url.includes("/databases/")) return { status: 200, json: { name: `projects/${PROJECT}/databases/(default)`, type: "FIRESTORE_NATIVE" } };
    throw new Error(url);
  };
  const run = (args = argv) => runCloudShellRequestCorrection({ argv: args, env: ENV, auth: { getProjectId: async () => PROJECT, getAccessToken: async () => "adc-token" }, request,
    initFirestore: async () => { initialized++; return { db: store, app: { options: { projectId: PROJECT } } }; } });
  return { run, store, get initialized() { return initialized; } };
}

test("arguments: dry run by default; --execute needs every exact confirmation including the deployed fixed backend and a reason", () => {
  assert.equal(parseCorrectionArguments(BASE).execute, false);
  assert.equal(parseCorrectionArguments(EXECUTE("0123456789abcdef")).execute, true);
  const drop = (flag) => EXECUTE("0123456789abcdef").filter((arg) => !arg.startsWith(flag));
  for (const argv of [[...BASE, "--execute"], [...BASE, "--confirm-plan=0123456789abcdef"], drop("--confirm-backend-deployed"), drop("--reason"), drop("--confirm-request-id"),
    EXECUTE("0123456789abcdef").map((a) => a.startsWith("--confirm-request-number") ? "--confirm-request-number=REQ-2026-055" : a), [...BASE, "--request-number=REQ-2026-055"]]) {
    assert.throws(() => parseCorrectionArguments(argv), /\[arguments\]/, JSON.stringify(argv));
  }
});

test("dry run under Cloud Shell conditions (no Firebase keys) reports the exact write scope and writes nothing", async () => {
  const h = harness({ argv: BASE, permissions: REQUIRED_READ_PERMISSIONS });
  const dry = await h.run();
  assert.deepEqual([dry.state, dry.blockers, dry.requestId, dry.current.status, dry.current.encodedBy, dry.current.participantName], ["CORRECTABLE", [], DOC, "Pending", ENCODER, "Walk-in Citizen"]);
  assert.deepEqual(dry.writeScope, { document: `seedlingRequests/${DOC}`, status: "Pending -> Reviewed (Awaiting Approval)", submissionPath: "STAFF_DIRECT_TO_ADMIN", staffReviewRequired: false,
    reviewStatus: "Not Required", submittedByUid: ENCODER, submittedByRole: "staff", submittedByName: "Encoding Staff", requestVersion: "0 -> 1", appendedHistory: "routed_to_admin_approval", otherDocumentsWritten: 0 });
  assert.match(dry.next, new RegExp(`--confirm-request-id=${DOC} --confirm-plan=${dry.planDigest}`));
  assert.deepEqual(h.store.appliedWrites, []);
});

test("execute needs Firestore update permission; it stops before Firestore otherwise", async () => {
  const h = harness({ argv: EXECUTE("0123456789abcdef"), permissions: REQUIRED_READ_PERMISSIONS });
  await assert.rejects(h.run(), /\[permissions\]/); assert.equal(h.initialized, 0);
});

test("execute writes exactly one request document, records the operator audit, verifies before/after and is idempotent", async () => {
  const h = harness({ argv: BASE });
  const dry = await h.run();
  await assert.rejects(h.run(EXECUTE("0000000000000000")), /\[confirmation\]/);
  await assert.rejects(h.run(EXECUTE(dry.planDigest, "other-doc")), /\[confirmation\]/);
  assert.deepEqual(h.store.appliedWrites, []);
  const result = await h.run(EXECUTE(dry.planDigest));
  assert.equal(result.status, "CORRECTED"); assert.equal(result.postVerification.ok, true, JSON.stringify(result.postVerification.problems));
  assert.equal(result.verification.principal, PRINCIPAL, "the ADC verification block is kept in the output");
  assert.deepEqual(h.store.appliedWrites, [`update seedlingRequests/${DOC}`]);
  const after = h.store.read("seedlingRequests", DOC);
  assert.deepEqual([after.status, after.submissionPath, after.reviewStatus, after.submittedByUid, after.requestVersion], ["Reviewed", "STAFF_DIRECT_TO_ADMIN", "Not Required", ENCODER, 1]);
  assert.match(after.historicalCorrection.reason, /\(backend abc1234\)$/); assert.equal(after.historicalCorrection.correctedBy, PRINCIPAL);
  assert.deepEqual(after.reviewHistory.at(-1).action, "routed_to_admin_approval"); assert.equal(after.reviewId, undefined);
  assert.deepEqual(after.items, historical().items); assert.deepEqual(after.walkIn, historical().walkIn); assert.equal(after.participantId, "walkin_abc");
  assert.equal(h.store.read("seedlingRequests", "other-doc").status, "Pending", "no other request changes");
  assert.equal((await h.run(EXECUTE(dry.planDigest))).status, "NO_CHANGE");
  assert.deepEqual(h.store.appliedWrites, [`update seedlingRequests/${DOC}`]);
  assert.equal((await h.run(BASE)).state, "ALREADY_CORRECTED");
  assert.equal(Object.keys(require.cache).some((file) => /src[\\/]config[\\/]firebase\.js$/.test(file)), false, "the key-based Firebase app is never loaded");
  assert.equal(Object.keys(require.cache).some((file) => /seedlingRequest\.service\.js$|notification\.service\.js$/.test(file)), false);
});

test("assessment blocks every unsafe state and never treats a genuine review or another path as correctable", () => {
  const now = new Date("2026-11-19T00:00:00Z"), staff = { role: "staff" };
  const blockersFor = (patch) => assess(DOC, { ...historical(), ...patch }, staff, now).blockers;
  assert.deepEqual(assess(DOC, historical(), staff, now).blockers, []);
  assert.ok(blockersFor({ status: "Returned" }).includes("STATUS_RETURNED"));
  assert.ok(blockersFor({ reviewId: "REV-2026-001" }).includes("STAFF_REVIEW_ALREADY_RECORDED"));
  assert.ok(blockersFor({ submissionPath: "PARTICIPANT_STAFF_REVIEW" }).includes("SUBMISSION_PATH_ALREADY_SET"));
  assert.ok(blockersFor({ walkIn: undefined }).includes("NO_PERSISTED_STAFF_ENCODER"));
  assert.ok(blockersFor({ createdByRole: undefined }).includes("NOT_A_STAFF_ENCODED_WALK_IN"));
  assert.ok(blockersFor({ reviewHistory: [{ action: "submitted", actorId: "someone-else", actorRole: "staff", actionBasis: "STAFF_ENCODED_WALK_IN" }] }).includes("SUBMISSION_AUDIT_MISMATCH"));
  assert.ok(blockersFor({ preApprovalSchedule: { status: "AwaitingRequesterConfirmation" } }).includes("SCHEDULE_CONFIRMATION_PENDING"));
  assert.ok(blockersFor({ eventProposal: { proposedDate: "2026-11-19" } }).includes("SCHEDULE_NOT_IN_FUTURE"));
  assert.ok(blockersFor({ eventId: "event-1" }).includes("EVENT_ALREADY_LINKED"));
  assert.ok(blockersFor({ inventoryDeducted: true }).includes("INVENTORY_ALREADY_AFFECTED"));
  assert.ok(assess(DOC, historical(), null, now).blockers.includes("ENCODER_PROFILE_NOT_FOUND"));
  assert.deepEqual(assess(DOC, { ...historical(), workflow: { siteMode: "proposed" } }, { role: "admin" }, now).notes, ["ADMIN_MUST_VERIFY_PROPOSED_SITE_AT_APPROVAL", "ENCODER_CURRENT_ROLE_ADMIN"]);
});
