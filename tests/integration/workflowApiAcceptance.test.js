const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

validateIntegrationEnvironment();
const { auth, db } = require("../../src/config/firebase");
const app = require("../../src/app");

const PASSWORD = "Workflow-Test-Only!2026";
const PREFIX = "workflow-api-acceptance";
const USERS = {
  participant: [`${PREFIX}-participant`, `${PREFIX}.participant@example.test`],
  other: [`${PREFIX}-other`, `${PREFIX}.other@example.test`],
  staff: [`${PREFIX}-staff`, `${PREFIX}.staff@example.test`],
  admin: [`${PREFIX}-admin`, `${PREFIX}.admin@example.test`],
};
const SITE_ID = `${PREFIX}-site`;
const created = { requests: [], inventories: [], events: [], reports: [] };
let server;
let baseUrl;
let tokens = {};

async function signIn(email) {
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.idToken;
}

async function api(role, method, route, body, { form = false } = {}) {
  const headers = { authorization: `Bearer ${tokens[role]}` };
  if (!form) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}/api${route}`, {
    method, headers, body: body == null ? undefined : form ? body : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.ok(response.ok, `${method} ${route} -> ${response.status}: ${JSON.stringify(payload)}`);
  return payload.data;
}

async function notices(role, type, recordId) {
  const data = await api(role, "GET", "/notifications?limit=100");
  const rows = Array.isArray(data) ? data : data.notifications || data.items || [];
  return rows.filter((item) => item.type === type && (!recordId || item.relatedRecordId === recordId));
}

async function assertRecipientOnly(role, otherRole, type, recordId) {
  assert.ok((await notices(role, type, recordId)).length > 0, `${role} did not receive ${type}`);
  assert.equal((await notices(otherRole, type, recordId)).length, 0,
    `${otherRole} unexpectedly received ${type}`);
}

function requestPayload(inventoryId, suffix) {
  return {
    items: [{ inventoryId, quantity: 25 }], purpose: `Acceptance ${suffix}`,
    plantingLocation: "Phase 2 Test Site", preferredReleaseDate: "2026-11-10",
    clientSubmissionId: suffix === "approved" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
    identification: { identificationType: "national_id", idNumber: `TEST-${suffix}-1234`, confirmed: true },
    workflow: { sector: "Civic Organization / NGO", requestingAs: "group", siteMode: "existing" },
    eventProposal: { eventName: `Acceptance ${suffix} planting`, barangay: "Bical",
      plantingSiteId: SITE_ID, proposedDate: "2026-11-12", startTime: "09:00", endTime: "11:00",
      eventLocation: "Phase 2 Test Site", latitude: 12.671, longitude: 123.875,
      expectedParticipants: 5, eventDescription: "Authenticated API acceptance" },
  };
}

test.before(async () => {
  for (const [role, [uid, email]] of Object.entries(USERS)) {
    try { await auth.deleteUser(uid); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    await auth.createUser({ uid, email, password: PASSWORD, emailVerified: true });
    await db.collection("users").doc(uid).set({ uid, email, role: role === "other" ? "participant" : role,
      fullName: `Workflow ${role}`, username: uid, contactNumber: "09123456789",
      organization: "MENRO Test Organization", userType: "Organization Member",
      userTypeDetail: "MENRO Test Organization", affiliationName: "MENRO Test Organization",
      barangay: "Bical", profileComplete: true, status: "active", testFixture: true });
  }
  await db.collection("sites").doc(SITE_ID).set({ siteName: "Phase 2 Test Site", barangay: "Bical",
    latitude: 12.671, longitude: 123.875, coverageRadius: 100, status: "Active", archived: false,
    maximumCapacity: 1000, currentTreeCount: 0, testFixture: true });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const [role, [, email]] of Object.entries(USERS)) tokens[role] = await signIn(email);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("authenticated Seedling Request, Event, Inventory, Distribution, and notification APIs", async () => {
  const inventory = await api("staff", "POST", "/inventory", {
    species: "Narra", category: "Native Tree", initialQuantity: 25, stockStatus: "Available",
    sourceType: "MENRO Propagation", dateReceived: "2026-10-01", storageLocation: "MENRO Nursery",
    description: "Workflow API acceptance batch",
  });
  created.inventories.push(inventory.id);

  const approved = await api("participant", "POST", "/seedling-requests", requestPayload(inventory.id, "approved"));
  created.requests.push(approved.id);
  await assertRecipientOnly("staff", "other", "request_submitted_staff", approved.id);
  let request = await api("staff", "PATCH", `/seedling-requests/${approved.id}/review`, {
    items: [{ inventoryId: inventory.id, quantity: 25 }], purpose: "Acceptance approved",
    plantingLocation: "Phase 2 Test Site", preferredReleaseDate: "2026-11-10", expectedVersion: 0,
  });
  assert.equal(request.status, "Reviewed");
  request = await api("admin", "PATCH", `/seedling-requests/${approved.id}/approve`, { expectedVersion: 1 });
  assert.equal(request.status, "Approved");
  created.events.push(request.eventId);
  await assertRecipientOnly("participant", "other", "request_approved", approved.id);

  request = await api("staff", "PATCH", `/seedling-requests/${approved.id}/release`, {
    expectedVersion: 2, availableReleaseDate: "2026-11-10",
    items: [{ inventoryId: inventory.id, releasedQuantity: 25 }],
  });
  assert.equal(request.status, "Released");
  await assertRecipientOnly("participant", "other", "request_released", approved.id);
  const inventoryAfter = await api("staff", "GET", `/inventory/${inventory.id}`);
  assert.equal(inventoryAfter.currentQuantity, 0);
  assert.equal(inventoryAfter.availableQuantity, 0);
  assert.ok((await notices("staff", "inventory_low_stock", inventory.id)).length > 0);
  assert.ok((await notices("admin", "inventory_out_of_stock", inventory.id)).length > 0);

  const replenished = await api("staff", "PATCH", `/inventory/${inventory.id}/stock`, { quantity: 30 });
  assert.equal(replenished.currentQuantity, 30);
  assert.equal(replenished.availableQuantity, 30);
  assert.ok((await notices("admin", "inventory_replenished", inventory.id)).length > 0);

  const returned = await api("participant", "POST", "/seedling-requests", requestPayload(inventory.id, "returned"));
  created.requests.push(returned.id);
  let returnedRequest = await api("staff", "PATCH", `/seedling-requests/${returned.id}/return`, {
    expectedVersion: 0, reason: "Please verify the planting purpose.",
  });
  assert.equal(returnedRequest.status, "Returned");
  const corrected = requestPayload(inventory.id, "returned");
  delete corrected.clientSubmissionId;
  delete corrected.identification;
  returnedRequest = await api("participant", "PATCH", `/seedling-requests/${returned.id}/resubmit`, {
    ...corrected, purpose: "Corrected acceptance purpose", expectedVersion: 1,
  });
  assert.equal(returnedRequest.id, returned.id);
  assert.equal(returnedRequest.status, "Pending");
  assert.ok((await notices("staff", "request_resubmitted_staff", returned.id)).length > 0);
  returnedRequest = await api("staff", "PATCH", `/seedling-requests/${returned.id}/review`, {
    items: [{ inventoryId: inventory.id, quantity: 25 }], purpose: "Corrected acceptance purpose",
    plantingLocation: "Phase 2 Test Site", preferredReleaseDate: "2026-11-10", expectedVersion: 2,
  });
  returnedRequest = await api("admin", "PATCH", `/seedling-requests/${returned.id}/reject`, {
    expectedVersion: 3, reason: "Acceptance rejection branch.",
  });
  assert.equal(returnedRequest.status, "Rejected");
  await assertRecipientOnly("participant", "other", "request_rejected", returned.id);

  const manual = await api("staff", "POST", "/events", { name: "Workflow Manual Event",
    type: "Tree Planting", barangay: "Bical", plantingSiteId: SITE_ID, location: "Phase 2 Test Site",
    date: "2026-11-20", startTime: "08:00", endTime: "10:00", expectedParticipants: 5 });
  created.events.push(manual.id || manual.eventId);
  const manualId = manual.id || manual.eventId;
  assert.ok((await notices("staff", "event_scheduled", manualId)).length > 0);
  const rescheduled = await api("staff", "PUT", `/events/${manualId}`, { ...manual,
    name: "Workflow Manual Event", type: "Tree Planting", barangay: "Bical", plantingSiteId: SITE_ID,
    location: "Phase 2 Test Site", date: "2026-11-21", startTime: "09:00", endTime: "11:00",
    expectedParticipants: 5 });
  assert.equal(rescheduled.date, "2026-11-21");
  assert.ok((await notices("staff", "event_rescheduled", manualId)).length > 0);

  const distribution = await api("staff", "GET", `/distributions/${approved.id}`);
  assert.equal(distribution.requestId, approved.id);
  assert.equal(distribution.totalQuantityReleased, 25);
});

test("actual planting report API validates geotag evidence and creates recipient-scoped notifications", async () => {
  const requestId = created.requests[0];
  const requestDoc = await db.collection("seedlingRequests").doc(requestId).get();
  const request = requestDoc.data();
  const eventId = request.eventId;
  // The committed evidence fixture is dated 2026-10-01. Moving only this isolated
  // synthetic event allows the real date/EXIF validator to evaluate it truthfully.
  await db.collection("events").doc(eventId).update({ date: "2026-10-01", startTime: "08:00", endTime: "11:00" });
  const form = new FormData();
  const fields = { distributionId: requestId, inventoryId: created.inventories[0], siteId: SITE_ID,
    barangay: "Bical", quantityPlanted: "10", plantingDate: "2026-10-01",
    plantingLocation: "Phase 2 Test Site", eventId, eventName: request.eventProposal.eventName,
    submittedByName: "Workflow participant", submittedBySector: "Organization Member",
    submittedByContactNumber: "09123456789", remarks: "API acceptance" };
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  const image = await fs.readFile(path.join(__dirname, "fixtures", "outside-site.jpg"));
  form.append("photos", new Blob([image], { type: "image/jpeg" }), "outside-site.jpg");
  const report = await api("participant", "POST", "/planting-reports", form, { form: true });
  created.reports.push(report.id);
  assert.ok((await notices("participant", "planting_report_submitted", report.id)).length > 0);
  assert.ok((await notices("staff", "planting_report_submitted_staff", report.id)).length > 0);
  assert.ok((await notices("staff", "planting_evidence_flagged", report.id)).length > 0);
  assert.equal((await notices("other", "planting_report_submitted", report.id)).length, 0);
  const submissionId = report.submissions?.[0]?.id;
  assert.ok(submissionId, "The request-backed report did not expose its contribution ID.");
  await api("staff", "PATCH", `/planting-reports/${submissionId}/approve`, {
    remarks: "Authenticated contribution acceptance",
  });
  assert.ok((await notices("participant", "planting_report_accepted", report.id)).length > 0);

  const secondForm = new FormData();
  const secondFields = { ...fields, quantityPlanted: "5", submittedByName: "Other participant" };
  Object.entries(secondFields).forEach(([key, value]) => secondForm.append(key, value));
  const secondImage = await fs.readFile(path.join(__dirname, "fixtures", "early-a.jpg"));
  secondForm.append("photos", new Blob([secondImage], { type: "image/jpeg" }), "early-a.jpg");
  const secondReport = await api("other", "POST", "/planting-reports", secondForm, { form: true });
  const secondSubmissionId = secondReport.submissions?.find((item) => item.id !== submissionId)?.id;
  assert.ok(secondSubmissionId, "The second contributor did not receive a distinct immutable submission ID.");
  assert.notEqual(secondSubmissionId, submissionId);
  assert.ok((await notices("other", "planting_report_submitted", report.id)).length > 0);
  const staffSubmissionNotices = await notices("staff", "planting_report_submitted_staff", report.id);
  assert.ok(staffSubmissionNotices.length >= 2);
  assert.equal(new Set(staffSubmissionNotices.map((item) => item.id)).size, staffSubmissionNotices.length);
  await api("staff", "PATCH", `/planting-reports/${secondSubmissionId}/reject`, {
    remarks: "Authenticated second-contributor rejection branch",
  });
  assert.ok((await notices("other", "planting_report_rejected", report.id)).length > 0);
});
