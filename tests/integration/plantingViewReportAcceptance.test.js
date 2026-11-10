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

// One final Planting Report for the event: every released type, with final
// leftovers (and their reason); the backend computes Final Planted.
async function submit(role, name, fixture, leftoverQuantity, extra = {}) {
  const form = new FormData();
  Object.entries({
    distributionId: REQUEST_ID, siteId: SITE_ID, barangay: "Bical",
    items: JSON.stringify([{ inventoryId: INVENTORY_ID, leftoverQuantity,
      ...(leftoverQuantity > 0 ? { leftoverReason: "Seedlings damaged in transport" } : {}) }]),
    confirmationMode: "final", ...extra, plantingDate: "2026-10-01", plantingLocation: "View Report Test Site",
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

  // 25 released: 15 final leftovers (with reason) -> Final Planted 10.
  const first = await submit("participant", "View participant", "valid-original.jpg", 15);
  assert.equal(first.status, 201, JSON.stringify(first.payload));
  assert.equal(first.payload.success, true);
  const firstId = first.payload.data.submissions?.[0]?.id;
  assert.ok(firstId);

  for (const role of ["staff", "admin"]) {
    const { listed, single } = await staffView(role);
    for (const view of [listed, single]) {
      assert.equal(view.submissionStatus, "Submitted", `${role}: progress must read Submitted`);
      assert.equal(view.reviewStatus, "Pending Review", `${role}: review must stay Pending Review`);
      assert.equal(view.reportingProgress, "Fully Reported — Awaiting Review");
      assert.notEqual(view.verificationStatus, "Approved");
      assert.equal(view.submissions.length, 1);
      const saved = view.submissions[0];
      assert.equal(saved.id, firstId);
      assert.equal(saved.species, "Narra");
      assert.equal(saved.quantity, 10, "Final Planted = Released - Leftovers");
      assert.equal(saved.leftoverQuantity, 15);
      assert.equal(saved.leftoverReason, "Seedlings damaged in transport");
      assert.equal(saved.finalReportId, `FPR-${EVENT_ID}`);
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
      assert.equal(view.pendingReviewQuantity, 10);
      assert.equal(view.declaredLeftoverQuantity, 15);
      assert.equal(view.remainingAvailableQuantity, 0);
    }
    const evidence = await photo(role, 0);
    assert.equal(evidence.status, 200, `${role} cannot load evidence`);
    assert.match(evidence.type, /^image\//);
    assert.ok(evidence.bytes > 0);
  }
  assert.equal((await photo("outsider", 0)).status, 403, "unrelated participant must not load evidence");
  assert.equal((await photo("staff", 1)).status, 404, "nonexistent evidence must be reported missing");

  // One final report per event: a second, independent report is refused.
  const duplicate = await submit("member", "View member", "outside-site.jpg", 0);
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.payload));
  assert.equal((await staffView("staff")).single.submissions.length, 1);

  // Staff returns it; the original submitter corrects it as the next revision.
  await api("staff", "PATCH", `/planting-reports/${firstId}/return`, { remarks: "Leftover count needs checking" });
  const returned = await staffView("staff");
  assert.equal(returned.single.reviewStatus, "Returned for Correction");
  assert.equal(returned.single.pendingReviewQuantity, 0);
  const notOwner = await submit("member", "View member", "outside-site.jpg", 0, { correctionOf: firstId });
  assert.equal(notOwner.status, 409, "only the original submitter may correct it");
  const corrected = await submit("participant", "View participant", "outside-site.jpg", 5, { correctionOf: firstId });
  assert.equal(corrected.status, 201, JSON.stringify(corrected.payload));
  const afterCorrection = await staffView("staff");
  for (const view of [afterCorrection.listed, afterCorrection.single]) {
    assert.equal(view.id, REPORT_ID, "the same report ID");
    assert.equal(view.submissions.length, 2, "the returned revision is kept as history");
    const [old, latest] = view.submissions;
    assert.equal(old.id, firstId); assert.equal(old.workflowStatus, "Returned for Correction"); assert.equal(old.correctedBySubmission, latest.id);
    assert.equal(latest.correctionOf, firstId); assert.equal(latest.finalReportRevision, 1); assert.equal(latest.finalReportId, `FPR-${EVENT_ID}`);
    assert.equal(latest.quantity, 20); assert.equal(latest.leftoverQuantity, 5);
    assert.equal(latest.locationVerificationStatus, "site_mismatch");
    assert.equal(view.reviewStatus, "Pending Review");
    assert.equal(view.photos.length, 2);
  }
  for (const index of [0, 1]) assert.equal((await photo("admin", index)).status, 200, "historical evidence stays retrievable");
  const latestId = afterCorrection.single.submissions[1].id;

  // Staff forwards -> Admin approves: Completed with leftovers.
  assert.equal((await call("admin", "PATCH", `/planting-reports/${latestId}/approve`, { remarks: "Too early" })).status, 409, "Admin cannot approve before Staff review");
  await api("staff", "PATCH", `/planting-reports/${latestId}/forward`, { remarks: "Evidence reviewed" });
  assert.equal((await staffView("admin")).single.reviewStatus, "Reviewed");
  await api("admin", "PATCH", `/planting-reports/${latestId}/approve`, { remarks: "Approved" });
  const decided = await staffView("admin");
  for (const view of [decided.listed, decided.single]) {
    assert.deepEqual(view.submissions.map((item) => item.workflowStatus), ["Returned for Correction", "Completed"]);
    assert.equal(view.submissionStatus, "Submitted");
    assert.equal(view.reviewStatus, "Completed");
    assert.equal(view.reportingProgress, "Completed", "Admin approval completes the final report with leftovers");
    assert.equal(view.acceptedQuantity, 20);
    assert.equal(view.acceptedLeftoverQuantity, 5);
    assert.equal(view.pendingReviewQuantity, 0);
  }

  // Participant endpoints keep their redaction rules.
  const participantView = await api("participant", "GET", `/planting-reports/${REPORT_ID}`);
  assert.equal(participantView.submissions.length, 2);
  assert.equal((await call("outsider", "GET", `/planting-reports/${REPORT_ID}`)).status >= 403, true, "unrelated participants cannot open the report");
});
