// Emulator-only acceptance: Participant planting submission -> Staff/Admin View Report.
// Real HTTP app, real Auth/Firestore emulators, real EXIF/GPS validation and
// secure evidence retrieval. Seeds a released request/event the way seedling
// release does (parent report created with zero submissions) and cleans up.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

validateIntegrationEnvironment();
const { auth, db } = require("../../src/config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const app = require("../../src/app");
const { parentForEventInTransaction } = require("../../src/services/parentPlantingReport.service");

const PASSWORD = "Planting-View-Test-Only!2026";
const PREFIX = "planting-view-acceptance";
const USERS = {
  participant: `${PREFIX}-participant`,
  member: `${PREFIX}-member`,
  outsider: `${PREFIX}-outsider`,
  staff: `${PREFIX}-staff`,
  admin: `${PREFIX}-admin`,
};
const SITE_ID = `${PREFIX}-site`;
const REQUEST_ID = `${PREFIX}-request`;
const EVENT_ID = `${PREFIX}-event`;
const REPORT_ID = `event_${EVENT_ID}`;
const INVENTORY_ID = `${PREFIX}-narra`;
let server;
let baseUrl;
const tokens = {};

async function signIn(uid) {
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${uid}@example.test`, password: PASSWORD, returnSecureToken: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.idToken;
}

async function call(role, method, route, body, { form = false } = {}) {
  const headers = { authorization: `Bearer ${tokens[role]}` };
  if (body && !form) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}/api${route}`, {
    method, headers, body: body == null ? undefined : form ? body : JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

async function api(role, method, route, body, options) {
  const { status, payload } = await call(role, method, route, body, options);
  assert.ok(status >= 200 && status < 300 && payload.success !== false,
    `${method} ${route} -> ${status}: ${JSON.stringify(payload)}`);
  return payload.data;
}

async function photo(role, index) {
  const response = await fetch(`${baseUrl}/api/evidence/planting-reports/${encodeURIComponent(REPORT_ID)}/photos/${index}`, {
    headers: { authorization: `Bearer ${tokens[role]}` },
  });
  const bytes = (await response.arrayBuffer()).byteLength;
  return { status: response.status, type: response.headers.get("content-type") || "", bytes };
}

async function submit(role, name, fixture, quantity) {
  const form = new FormData();
  Object.entries({
    distributionId: REQUEST_ID, inventoryId: INVENTORY_ID, siteId: SITE_ID, barangay: "Bical",
    quantityPlanted: String(quantity), plantingDate: "2026-10-01", plantingLocation: "View Report Test Site",
    eventId: EVENT_ID, eventName: "View Report acceptance planting",
    submittedByName: name, submittedBySector: "Organization Member", submittedByContactNumber: "09123456789",
    remarks: "View Report acceptance",
  }).forEach(([key, value]) => form.append(key, value));
  const image = await fs.readFile(path.join(__dirname, "fixtures", fixture));
  form.append("photos", new Blob([image], { type: "image/jpeg" }), fixture);
  return call(role, "POST", "/planting-reports", form, { form: true });
}

async function staffView(role) {
  const listed = (await api(role, "GET", "/planting-reports")).find((item) => item.id === REPORT_ID);
  const single = await api(role, "GET", `/planting-reports/${REPORT_ID}`);
  return { listed, single };
}

async function cleanup() {
  const deletions = [];
  for (const [collection, field] of [["plantingContributions", "reportId"], ["plantingEvidenceHashes", "reportId"],
    ["notifications", "relatedRecordId"], ["verificationLogs", "plantingReportId"]]) {
    const snapshot = await db.collection(collection).where(field, "==", REPORT_ID).get();
    snapshot.docs.forEach((doc) => deletions.push(doc.ref.delete()));
  }
  const evidenceOps = await db.collection("evidenceWorkflowOperations").get();
  evidenceOps.docs.filter((doc) => String(doc.data().targetId || "").startsWith(PREFIX)).forEach((doc) => deletions.push(doc.ref.delete()));
  for (const [collection, id] of [["plantingReports", REPORT_ID], ["events", EVENT_ID],
    ["distributions", REQUEST_ID], ["seedlingRequests", REQUEST_ID], ["sites", SITE_ID]]) {
    deletions.push(db.collection(collection).doc(id).delete());
  }
  Object.values(USERS).forEach((uid) => deletions.push(db.collection("users").doc(uid).delete()));
  await Promise.all(deletions);
}

test.before(async () => {
  await cleanup();
  for (const [role, uid] of Object.entries(USERS)) {
    try { await auth.deleteUser(uid); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    await auth.createUser({ uid, email: `${uid}@example.test`, password: PASSWORD, emailVerified: true });
    await db.collection("users").doc(uid).set({ uid, email: `${uid}@example.test`,
      role: ["staff", "admin"].includes(role) ? role : "participant", fullName: `View ${role}`, username: uid,
      contactNumber: "09123456789", barangay: "Bical", profileComplete: true, status: "active", testFixture: true });
  }
  await db.collection("sites").doc(SITE_ID).set({ siteName: "View Report Test Site", barangay: "Bical",
    latitude: 12.671, longitude: 123.875, coverageRadiusMeters: 100, status: "active", archived: false, testFixture: true });
  const item = { inventoryId: INVENTORY_ID, species: "Narra", requestedQuantity: 25, releasedQuantity: 25, quantity: 25 };
  await db.collection("seedlingRequests").doc(REQUEST_ID).set({ status: "Released", eventId: EVENT_ID,
    participantId: USERS.participant, participantName: "View participant", requestNumber: "REQ-VIEW-1",
    items: [item], testFixture: true });
  await db.collection("distributions").doc(REQUEST_ID).set({ status: "Released", requestId: REQUEST_ID,
    eventId: EVENT_ID, participantId: USERS.participant, participantName: "View participant",
    plantingSiteId: SITE_ID, items: [item], totalQuantityReleased: 25, testFixture: true });
  const event = { name: "View Report acceptance planting", sourceRequestId: REQUEST_ID, plantingSiteId: SITE_ID,
    plantingSiteName: "View Report Test Site", barangay: "Bical", date: "2026-10-01", startTime: "08:00",
    endTime: "11:00", status: "Completed", recordStatus: "Scheduled", allocationReleasedAt: Timestamp.now(),
    seedlingItems: [{ inventoryId: INVENTORY_ID, species: "Narra", quantity: 25 }], seedlingTotalQuantity: 25,
    testFixture: true };
  await db.collection("events").doc(EVENT_ID).set(event);
  // Same call seedling release makes: an "Awaiting Submission" parent shell.
  await db.runTransaction((transaction) => parentForEventInTransaction(transaction, EVENT_ID, event, Timestamp.now()));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const role of Object.keys(USERS)) tokens[role] = await signIn(USERS[role]);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await cleanup();
});

test("Participant submission -> Staff/Admin View Report shows Submitted, details, and secure evidence", async () => {
  // Before any submission: honest Awaiting Submission, no evidence.
  const before = await staffView("staff");
  assert.equal(before.listed.submissionStatus, "Awaiting Submission");
  assert.equal(before.listed.reviewStatus, "Not Submitted");
  assert.equal(before.listed.submissions.length, 0);
  assert.equal((await photo("staff", 0)).status, 404);

  const first = await submit("participant", "View participant", "valid-original.jpg", 10);
  assert.equal(first.status, 201, JSON.stringify(first.payload));
  assert.equal(first.payload.success, true);
  const firstId = first.payload.data.submissions?.[0]?.id;
  assert.ok(firstId);

  for (const role of ["staff", "admin"]) {
    const { listed, single } = await staffView(role);
    for (const view of [listed, single]) {
      assert.equal(view.submissionStatus, "Submitted", `${role}: progress must read Submitted`);
      assert.equal(view.reviewStatus, "Pending Review", `${role}: review must stay Pending Review`);
      assert.equal(view.reportingProgress, "Partial");
      assert.notEqual(view.verificationStatus, "Approved");
      assert.equal(view.submissions.length, 1);
      const saved = view.submissions[0];
      assert.equal(saved.id, firstId);
      assert.equal(saved.species, "Narra");
      assert.equal(saved.quantity, 10);
      assert.equal(saved.staffReviewStatus, "Pending Review");
      assert.ok(saved.recordedAt);
      assert.equal(saved.submittedByName, "View participant");
      assert.equal(saved.submittedByContactNumber, "09123456789", "Staff/Admin view must not be redacted");
      assert.equal(saved.locationVerificationStatus, "site_match");
      assert.equal(saved.photos.length, 1);
      assert.equal(Number(saved.photos[0].latitude).toFixed(3), "12.671");
      assert.equal(Number(saved.photos[0].longitude).toFixed(3), "123.875");
      assert.ok(saved.photos[0].photoCapturedAt);
      assert.equal(view.photos.length, 1);
      assert.equal(view.submittedByName, "View participant");
      assert.equal(view.pendingReviewQuantity, 10);
    }
    const evidence = await photo(role, 0);
    assert.equal(evidence.status, 200, `${role} cannot load evidence`);
    assert.match(evidence.type, /^image\//);
    assert.ok(evidence.bytes > 0);
  }
  assert.equal((await photo("outsider", 0)).status, 403, "unrelated participant must not load evidence");
  assert.equal((await photo("staff", 1)).status, 404, "nonexistent evidence must be reported missing");

  // A second contributor (multiple submissions on one report).
  const second = await submit("member", "View member", "outside-site.jpg", 5);
  assert.equal(second.status, 201, JSON.stringify(second.payload));
  const secondId = second.payload.data.submissions.find((item) => item.id !== firstId)?.id;
  assert.ok(secondId);

  // Page refresh: list and single read agree; chronological history; both photos load.
  const afterSecond = await staffView("staff");
  for (const view of [afterSecond.listed, afterSecond.single]) {
    assert.deepEqual(view.submissions.map((item) => item.id), [firstId, secondId]);
    assert.equal(view.submittedByName, "View member", "latest submitter is the most recent submission");
    assert.equal(view.submissions[1].locationVerificationStatus, "site_mismatch");
    assert.equal(view.photos.length, 2);
    assert.equal(view.reviewStatus, "Pending Review");
    assert.equal(view.pendingReviewQuantity, 15);
  }
  for (const index of [0, 1]) assert.equal((await photo("admin", index)).status, 200);

  // Staged review (main workflow): Staff forwards -> Admin approves; Staff returns the other.
  await api("staff", "PATCH", `/planting-reports/${firstId}/forward`, { remarks: "Evidence reviewed" });
  const forwarded = await staffView("admin");
  assert.equal(forwarded.single.submissions[0].workflowStatus, "Reviewed");
  assert.equal(forwarded.single.reviewStatus, "Pending Review", "second submission still awaits Staff review");
  await api("staff", "PATCH", `/planting-reports/${secondId}/return`, { remarks: "Outside assigned site" });
  const returned = await staffView("staff");
  assert.equal(returned.single.reviewStatus, "Reviewed", "earliest unfinished stage is the forwarded one");
  await api("admin", "PATCH", `/planting-reports/${firstId}/approve`, { remarks: "Approved" });
  const decided = await staffView("admin");
  for (const view of [decided.listed, decided.single]) {
    assert.deepEqual(view.submissions.map((item) => item.workflowStatus), ["Completed", "Returned for Correction"]);
    assert.equal(view.submissionStatus, "Submitted");
    assert.equal(view.reviewStatus, "Returned for Correction");
    assert.equal(view.pendingReviewQuantity, 0);
    assert.equal(view.acceptedQuantity, 10);
    assert.notEqual(view.reportingProgress, "Completed", "10 of 25 accepted is not Completed");
  }
  for (const index of [0, 1]) assert.equal((await photo("staff", index)).status, 200, "historical evidence stays retrievable");

  // Participant redaction is preserved for the participant endpoints.
  const participantView = await api("participant", "GET", `/planting-reports/${REPORT_ID}`);
  assert.equal(participantView.submissions.find((item) => item.id === secondId).submittedByContactNumber, "");
});
