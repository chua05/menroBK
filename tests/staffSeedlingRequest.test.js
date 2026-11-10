const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const { queryMemory } = require("./helpers/queryMemory");

// Only the database and verified identity boundary are replaced. The real
// routes, role middleware, controllers, transactions and inventory rules run.
const memory = queryMemory();
const collection = memory.db.collection.bind(memory.db);
function realisticQuery(query) {
  const wrapped = { ...query };
  wrapped.doc = (id = randomUUID()) => {
    const reference = query.doc(id);
    return { ...reference, update: async value => memory.records(reference.collection).set(id, { ...memory.records(reference.collection).get(id), ...value }) };
  };
  for (const method of ["where", "orderBy", "limit", "startAfter", "select"]) {
    if (query[method]) wrapped[method] = (...args) => realisticQuery(query[method](...args));
  }
  wrapped.get = async () => { const snapshot = await query.get(); return { ...snapshot, empty: snapshot.docs.length === 0, size: snapshot.docs.length }; };
  return wrapped;
}
memory.db.collection = name => realisticQuery(collection(name));
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: memory.db, auth: {} } };
const identities = {
  staff: { uid: "staff-owner", role: "staff", fullName: "Staff Requester", contactNumber: "09123456789", organization: "" },
  officer: { uid: "staff-officer", role: "staff", fullName: "Independent Officer", contactNumber: "09123456789" },
  participant: { uid: "participant-owner", role: "participant", fullName: "Participant Requester", contactNumber: "09123456789", organization: "Resident" },
  admin: { uid: "admin-officer", role: "admin", fullName: "Independent Admin" },
  promotedOwner: { uid: "staff-owner", role: "admin", fullName: "Staff Requester" },
};
const authPath = require.resolve("../src/middleware/auth.middleware");
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
  verifyToken(req, res, next) {
    req.user = identities[req.headers.authorization?.replace("Bearer ", "")];
    return req.user ? next() : res.status(401).json({ success: false });
  },
} };
const service = require("../src/services/seedlingRequest.service");
const routes = require("../src/routes/seedlingRequest.routes");
const inventoryRoutes = require("../src/routes/inventory.routes");
let server, base;
test.before(async () => {
  process.env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  memory.records("seedlingInventory").set("narra", { species: "Narra", availableQuantity: 100, currentQuantity: 100, reservedQuantity: 0, distributedQuantity: 0 });
  memory.records("sites").set("site-1", { siteName: "Existing Site", barangay: "Bical", status: "active", maximumCapacity: 1000, planted: 0, latitude: 12.65, longitude: 123.91, areaHectares: 1.75 });
  for (const user of Object.values(identities)) memory.records("users").set(user.uid, { ...user, status: "active" });
  memory.records("users").set(identities.staff.uid, { ...identities.staff, status: "active" });
  const app = express(); app.use(express.json()); app.use("/api/seedling-requests", routes); app.use("/api/inventory", inventoryRoutes);
  server = app.listen(0, "127.0.0.1"); await once(server, "listening"); base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => { delete process.env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY; if (server) await new Promise(resolve => server.close(resolve)); });
async function http(path, role = "staff", method = "GET", body) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(role ? { authorization: `Bearer ${role}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...(await response.json()) };
}
function payload() {
  return {
    clientSubmissionId: randomUUID(), items: [{ inventoryId: "narra", quantity: 2 }], purpose: "Backyard / Home Planting",
    plantingLocation: "Bical, Bulan", preferredReleaseDate: "2099-01-01",
    workflow: { sector: "Resident / Individual", effectiveRequestType: "individual", purpose: "Backyard / Home Planting", addressProvince: "Sorsogon", addressMunicipality: "Bulan", addressBarangay: "Bical", street: "Fixture street", siteBarangay: "Bical", siteMode: "existing", existingSiteId: "site-1", areaChoice: "Other / Exact Area", exactArea: "0.5", releaseMethod: "Pick-up", caretaker: "Requester", carePlan: "Water weekly", monitoringFrequency: "Weekly" },
    identification: { identificationType: "national_id", idNumber: "1234-5678-9012-3456", confirmed: true },
    eventProposal: { eventName: "Individual planting schedule", barangay: "Bical", plantingSiteId: "site-1", proposedDate: "2099-01-02", proposedStartTime: "08:00", proposedEndTime: "", eventLocation: "Bical, Bulan", latitude: 12.65, longitude: 123.91, expectedParticipants: 1 },
  };
}
async function submit(role = "staff", body = payload()) {
  const response = await http("/seedling-requests", role, "POST", body);
  assert.equal(response.status, 201, JSON.stringify(response)); return response.data;
}
function unchangedSnapshot() {
  return JSON.stringify(["seedlingRequests", "notifications", "counters", "seedlingInventory", "events", "distributions", "sites"].map(name => [...memory.records(name)]));
}

test("Staff submits with verified identity, Pending status, canonical inventory and Staff audit; retries are idempotent", async () => {
  const body = payload(); body.participantId = "citizen"; body.participantName = "Forged"; body.status = "Approved";
  body.workflow.fullName = "Forged"; body.workflow.contactNumber = "000";
  const request = await submit("staff", body);
  assert.equal(request.participantId, identities.staff.uid); assert.equal(request.participantName, identities.staff.fullName);
  assert.equal(request.workflow.fullName, identities.staff.fullName); assert.equal(request.workflow.contactNumber, identities.staff.contactNumber);
  assert.equal(request.requesterRole, "staff"); assert.equal(request.reviewHistory[0].actorRole, "staff"); assert.equal(request.status, "Pending");
  assert.equal(request.items[0].species, "Narra"); assert.equal(request.workflow.areaHectares, 1.75, "an existing site uses its registered area, not the submitted 0.5");
  assert.equal(request.processingEstimate.workingDaysMinimum, 5); assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, 100);
  assert.equal((await submit("staff", body)).id, request.id);
  const notices = [...memory.records("notifications").values()].filter(n => n.relatedRecordId === request.id);
  assert.ok(notices.some(n => n.type === "request_submitted" && n.recipientUserId === identities.staff.uid));
  assert.ok(notices.some(n => n.type === "request_submitted_staff" && n.recipientUserId === identities.officer.uid));
  assert.ok(!notices.some(n => n.type === "request_submitted_staff" && n.recipientUserId === identities.staff.uid));
});

test("Participant submission stays accepted; Admin and unauthenticated submission are denied", async () => {
  const participant = await submit("participant"); assert.equal(participant.participantId, identities.participant.uid); assert.equal(participant.reviewHistory[0].actorRole, "participant");
  assert.equal((await http("/seedling-requests", "admin", "POST", payload())).status, 403);
  assert.equal((await http("/seedling-requests", null, "POST", payload())).status, 401);
  for (const role of ["staff", "participant"]) assert.equal((await http("/inventory/available", role)).status, 200);
});

test("Staff uses unchanged conditional area and ID validation; invalid submissions create nothing", async () => {
  for (const value of ["", "-1", "Infinity", "NaN"]) {
    const body = payload();
    // Requester area is only collected (optionally) for a proposed site.
    Object.assign(body.workflow, { siteMode: "proposed", existingSiteId: "", siteName: "Proposed Site", specificLocation: "Purok 3", latitude: "12.65", longitude: "123.91", niyogan: "no", landType: "Residential / Private Property", currentCondition: "Open lot", exactArea: value });
    body.eventProposal.plantingSiteId = "PROPOSED";
    const before = unchangedSnapshot(); const response = await http("/seedling-requests", "staff", "POST", body);
    assert.equal(response.status, 400); assert.ok(response.fieldErrors.exactArea); assert.equal(unchangedSnapshot(), before);
  }
  const body = payload(); body.identification.idNumber = "invalid";
  assert.equal((await http("/seedling-requests", "staff", "POST", body)).status, 400);
});

test("service rejects mismatched requester UID, Admin actors and unverified Staff designation", async () => {
  for (const actor of [{ uid: "wrong", role: "staff" }, { uid: "staff-owner", role: "admin" }, null]) {
    await assert.rejects(service.createSeedlingRequest({ participantId: "staff-owner", requesterRole: "staff" }, null, actor), error => error.status === 403);
  }
});

test("owner cannot review, return, approve, reject, coordinate or release; promoted owner is still forbidden", async () => {
  const request = await submit(); const before = unchangedSnapshot();
  const cases = [
    ["review", "staff", { items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate }], ["return", "staff", { reason: "Correct the care plan" }],
    ["approve", "promotedOwner", {}], ["reject", "promotedOwner", { reason: "A valid decision reason" }],
    ["pre-approval-schedule", "staff", {}], ["release", "staff", { availableReleaseDate: "2099-01-01", items: [{ inventoryId: "narra", releasedQuantity: 2 }] }],
    ["late-release-conflict", "staff", {}], ["late-release-rescheduling/approve", "staff", {}], ["late-release-rescheduling/return", "staff", { reason: "Correction needed" }],
  ];
  for (const [action, role, body] of cases) {
    const response = await http(`/seedling-requests/${request.id}/${action}`, role, "PATCH", { expectedVersion: 0, ...body });
    assert.equal(response.status, 403, `${action}: ${JSON.stringify(response)}`); assert.equal(response.code, "REQUEST_SELF_PROCESSING_FORBIDDEN");
    assert.equal(unchangedSnapshot(), before, `${action} wrote data`);
  }
});

test("another Staff reviews, Admin approves and independent Staff releases once with calendar and notifications intact", async () => {
  const request = await submit();
  const reviewed = await http(`/seedling-requests/${request.id}/review`, "officer", "PATCH", { expectedVersion: 0, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed)); assert.equal(reviewed.data.status, "Reviewed");
  const approved = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: reviewed.data.requestVersion });
  assert.equal(approved.status, 200, JSON.stringify(approved)); assert.equal(approved.data.status, "Approved");
  const event = memory.records("events").get(approved.data.eventId); assert.equal(event.sourceRequestId, request.id); assert.equal(event.date, "2099-01-02");
  assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, 100);
  const release = { expectedVersion: approved.data.requestVersion, availableReleaseDate: "2099-01-01", items: [{ inventoryId: "narra", releasedQuantity: 2 }] };
  assert.equal((await http(`/seedling-requests/${request.id}/release`, "staff", "PATCH", release)).status, 403);
  const released = await http(`/seedling-requests/${request.id}/release`, "officer", "PATCH", release);
  assert.equal(released.status, 200, JSON.stringify(released)); assert.equal(released.data.status, "Released");
  assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, 98); assert.equal(memory.records("distributions").get(request.id).participantId, identities.staff.uid);
  assert.notEqual((await http(`/seedling-requests/${request.id}/release`, "officer", "PATCH", release)).status, 200);
  assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, 98);
  assert.ok([...memory.records("notifications").values()].some(n => n.type === "request_released" && n.relatedRecordId === request.id && n.recipientUserId === identities.staff.uid));
});

test("Staff owns only their requester list and can revise returned requests with preserved identity/history", async () => {
  const request = await submit();
  const mine = await http("/seedling-requests/my", "staff"); assert.equal(mine.status, 200); assert.ok(mine.data.some(row => row.id === request.id)); assert.ok(mine.data.every(row => row.participantId === identities.staff.uid));
  const returned = await http(`/seedling-requests/${request.id}/return`, "officer", "PATCH", { expectedVersion: 0, reason: "Please clarify care plan" });
  assert.equal(returned.status, 200, JSON.stringify(returned));
  const body = { ...payload(), expectedVersion: returned.data.requestVersion }; body.workflow.carePlan = "Water daily and protect seedlings";
  assert.notEqual((await http(`/seedling-requests/${request.id}/resubmit`, "officer", "PATCH", body)).status, 200);
  const updated = await http(`/seedling-requests/${request.id}/resubmit`, "staff", "PATCH", body);
  assert.equal(updated.status, 200, JSON.stringify(updated)); assert.equal(updated.data.id, request.id); assert.equal(updated.data.status, "Pending");
  assert.equal(updated.data.participantId, identities.staff.uid); assert.equal(updated.data.reviewHistory.at(-1).actorRole, "staff");
  assert.equal(updated.data.resubmissionProcessingEstimate.workingDaysMinimum, 5);
  assert.equal((await http(`/seedling-requests/${request.id}/resubmit`, "staff", "PATCH", body)).status, 409);
});

test("only the Staff requester confirms another officer's coordinated schedule, preserving Staff audit", async () => {
  const request = await submit();
  const coordinated = await http(`/seedling-requests/${request.id}/pre-approval-schedule`, "officer", "PATCH", { expectedVersion: 0, plantingDate: "2099-01-03", startTime: "09:00", adjustmentReason: "Coordinate available schedule" });
  assert.equal(coordinated.status, 200, JSON.stringify(coordinated));
  const body = { expectedVersion: coordinated.data.requestVersion, proposalVersion: coordinated.data.preApprovalSchedule.proposalVersion };
  assert.notEqual((await http(`/seedling-requests/${request.id}/pre-approval-schedule/confirm`, "officer", "PATCH", body)).status, 200);
  const confirmed = await http(`/seedling-requests/${request.id}/pre-approval-schedule/confirm`, "staff", "PATCH", body);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed)); assert.equal(confirmed.data.preApprovalSchedule.status, "Confirmed");
  assert.equal(confirmed.data.scheduleHistory.at(-1).actorRole, "staff");
});

test("Staff requester proposes late-release rescheduling; another officer decides and the linked calendar updates", async () => {
  const request = await submit();
  const reviewed = await http(`/seedling-requests/${request.id}/review`, "officer", "PATCH", { expectedVersion: 0, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate });
  const approved = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: reviewed.data.requestVersion });
  assert.equal(approved.status, 200);
  const conflict = await http(`/seedling-requests/${request.id}/late-release-conflict`, "officer", "PATCH", { expectedVersion: approved.data.requestVersion, availableReleaseDate: "2099-01-04", reason: "Later seedling availability" });
  assert.equal(conflict.status, 200, JSON.stringify(conflict));
  const proposalBody = { expectedVersion: conflict.data.requestVersion, reschedulingVersion: conflict.data.lateReleaseRescheduling.version, plantingDate: "2099-01-05", startTime: "08:00" };
  assert.equal((await http(`/seedling-requests/${request.id}/late-release-rescheduling/proposal`, "officer", "PATCH", proposalBody)).status, 403);
  const proposed = await http(`/seedling-requests/${request.id}/late-release-rescheduling/proposal`, "staff", "PATCH", proposalBody);
  assert.equal(proposed.status, 200, JSON.stringify(proposed)); assert.equal(proposed.data.scheduleHistory.at(-1).actorRole, "staff");
  const decision = { expectedVersion: proposed.data.requestVersion, reschedulingVersion: proposed.data.lateReleaseRescheduling.version, proposalVersion: proposed.data.lateReleaseRescheduling.requesterProposal.proposalVersion };
  assert.equal((await http(`/seedling-requests/${request.id}/late-release-rescheduling/approve`, "staff", "PATCH", decision)).status, 403);
  const result = await http(`/seedling-requests/${request.id}/late-release-rescheduling/approve`, "officer", "PATCH", decision);
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.lateReleaseRescheduling.status, "Approved");
  assert.equal(memory.records("events").get(approved.data.eventId).date, "2099-01-05");
  assert.equal(memory.records("events").get(approved.data.eventId).sourceRequestId, request.id);
});

test("Other purpose requires a reasoned Staff proposal and explicit Admin decision; approved policy is snapshotted", async () => {
  const body = payload(); body.purpose = "Community special planting";
  body.workflow = { ...body.workflow, requestContractVersion: 2, purpose: "Other", purposeOther: body.purpose };
  const request = await submit("staff", body);
  const review = { expectedVersion: 0, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate,
    policyProposal: { reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE", reason: "Documented reforestation activity" } };
  const reviewed = await http(`/seedling-requests/${request.id}/review`, "officer", "PATCH", review); assert.equal(reviewed.status, 200, JSON.stringify(reviewed));
  assert.equal(reviewed.data.staffPolicyProposal.actorId, identities.officer.uid);
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "staff", "PATCH", { expectedVersion: 1 })).status, 403);
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: 1 })).status, 409);
  const result = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: 1,
    policyDecision: { reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE", reason: "Admin confirms the applicable reporting and sampling requirement", expectedPolicyVersion: 0 } });
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.approvedPurposePolicy.approvedBy, identities.admin.uid);
  assert.equal(result.data.approvedPurposePolicy.definition.reporting, "REQUIRED");
});

test("walk-in multipart encoding separates citizen and Staff, links a private signed acknowledgement and preserves release approval", async t => {
  const letters = require("../src/services/requestLetterStorage.service");
  const { createHash } = require("node:crypto");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQkAAAAASUVORK5CYII=", "base64");
  // Only private Storage I/O is replaced; actual document validation and real
  // request/identification/transaction services remain in use.
  t.mock.method(letters, "uploadRequestLetter", async ({ requestId, participantId, file, clientSubmissionId }) => {
    const validated = await letters.validateRequestLetterFile(file);
    const intent = createHash("sha256").update(clientSubmissionId).digest("hex");
    memory.records("requestLetterUploadIntents").set(intent, { requestId, participantId, sha256: validated.sha256, status: "UPLOADED" });
    return { uploadIntentId: intent, ...validated, bytes: undefined, objectName: `private-test/${requestId}`, bucket: "demo-only", generation: "1" };
  });
  const body = payload(); body.workflow.requestContractVersion = 2; body.workflow.purpose = "Household / Backyard"; body.purpose = "Household / Backyard";
  body.citizen = { fullName: "Actual Walk-in Citizen", contactNumber: "(056) 211-1234", assistedByName: "  Maria Santos ", receiptReference: "WALKIN-ACK-001", encodedBy: "spoofed-staff", encodedByName: "Spoofed name" };
  async function send(role, acknowledgement = true, path = "/walk-in", method = "POST") {
    const form = new FormData(); form.append("request", JSON.stringify(body));
    if (acknowledgement) form.append("acknowledgement", new Blob([image], { type: "image/png" }), "signed-acknowledgement.png");
    const response = await fetch(`${base}/seedling-requests${path}`, { method, headers: { ...(role ? { authorization: `Bearer ${role}` } : {}) }, body: form });
    return { status: response.status, ...(await response.json()) };
  }
  assert.equal((await send(null)).status, 401); assert.equal((await send("participant")).status, 403);
  body.citizen.assistedByName = "   "; const unnamed = await send("staff"); assert.equal(unnamed.status, 400); assert.ok(unnamed.fieldErrors.assistedByName);
  body.citizen.assistedByName = "x".repeat(161); assert.ok((await send("staff")).fieldErrors.assistedByName);
  body.citizen.assistedByName = "  Maria Santos ";
  const result = await send("staff"); assert.equal(result.status, 201, JSON.stringify(result)); const request = result.data;
  assert.equal(request.participantName, "Actual Walk-in Citizen"); assert.notEqual(request.participantId, identities.staff.uid);
  assert.equal(request.walkIn.encodedBy, identities.staff.uid); assert.equal(request.walkIn.encodedByName, identities.staff.fullName); assert.equal(request.walkIn.assistedByName, "Maria Santos"); assert.equal(request.walkIn.citizenHasAccount, false);
  for (const [action, body] of [["review", { items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate, expectedVersion: 0 }], ["return", { reason: "Encoder cannot decide", expectedVersion: 0 }], ["release", { expectedVersion: 0, availableReleaseDate: "2099-01-01", items: [{ inventoryId: "narra", releasedQuantity: 2 }] }]]) {
    const denied = await http(`/seedling-requests/${request.id}/${action}`, "staff", "PATCH", body);
    assert.equal(denied.status, 403); assert.equal(denied.code, "REQUEST_SELF_PROCESSING_FORBIDDEN");
  }
  assert.equal(request.reviewHistory[0].actorId, identities.staff.uid); assert.equal(request.status, "Pending");
  assert.equal(request.walkIn.receiptReference, "WALKIN-ACK-001"); assert.equal(JSON.stringify(result).includes("private-test/"), false);
  assert.ok(memory.records("walkInAcknowledgements").has(request.id));
  assert.equal((await send("staff")).data.id, request.id);
  assert.equal((await http(`/seedling-requests/${request.id}/acknowledgement`, "participant")).status, 403);
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "staff", "PATCH", { expectedVersion: 0 })).status, 403);
  assert.ok(![...memory.records("notifications").values()].some(n => n.recipientUserId === request.participantId));
  assert.equal(memory.records("users").has(request.participantId), false);
  const returned = await http(`/seedling-requests/${request.id}/return`, "officer", "PATCH", { expectedVersion: 0, reason: "Clarify the signed care plan" });
  assert.equal(returned.status, 200, JSON.stringify(returned));
  body.expectedVersion = returned.data.requestVersion; body.citizen.receiptReference = "WALKIN-CORRECTION-002";
  body.workflow.carePlan = "Corrected signed citizen plan"; body.citizen.assistedByName = "Jose Reyes";
  assert.equal((await send("officer", true, `/walk-in/${request.id}/resubmit`, "PATCH")).status, 404);
  const corrected = await send("staff", true, `/walk-in/${request.id}/resubmit`, "PATCH");
  assert.equal(corrected.status, 200, JSON.stringify(corrected)); assert.equal(corrected.data.id, request.id);
  assert.equal(corrected.data.walkIn.assistedByName, "Jose Reyes"); assert.equal(corrected.data.walkIn.encodedBy, identities.staff.uid);
  assert.equal(corrected.data.participantId, request.participantId); assert.equal(corrected.data.reviewHistory.at(-1).actorRole, "staff");
  assert.equal(memory.records("walkInAcknowledgements").get(request.id).history.length, 1);
  assert.equal(JSON.stringify(corrected).includes("private-test/"), false);
  assert.equal((await send("staff", true, `/walk-in/${request.id}/resubmit`, "PATCH")).status, 409);
  const coordinated = await http(`/seedling-requests/${request.id}/pre-approval-schedule`, "officer", "PATCH", { expectedVersion: corrected.data.requestVersion, plantingDate: "2099-01-03", startTime: "09:00", adjustmentReason: "Citizen coordinated the updated schedule" });
  assert.equal(coordinated.status, 200, JSON.stringify(coordinated));
  body.expectedVersion = coordinated.data.requestVersion; body.proposalVersion = coordinated.data.preApprovalSchedule.proposalVersion;
  body.action = "confirm"; body.plantingDate = "2099-01-03"; body.startTime = "09:00"; body.receiptReference = "SIGNED-SCHEDULE-003";
  assert.equal((await send("officer", true, `/walk-in/${request.id}/schedule`, "PATCH")).status, 404);
  assert.equal((await send("staff", false, `/walk-in/${request.id}/schedule`, "PATCH")).status, 400);
  const confirmed = await send("staff", true, `/walk-in/${request.id}/schedule`, "PATCH"); assert.equal(confirmed.status, 200, JSON.stringify(confirmed));
  assert.equal(confirmed.data.preApprovalSchedule.confirmedBy, identities.staff.uid); assert.equal(confirmed.data.scheduleHistory.at(-1).actorRole, "staff");
  assert.equal(memory.records("walkInAcknowledgements").get(request.id).history.length, 2);
  const reviewed = await http(`/seedling-requests/${request.id}/review`, "officer", "PATCH", { expectedVersion: confirmed.data.requestVersion, items: request.items, purpose: body.purpose, plantingLocation: body.plantingLocation, preferredReleaseDate: body.preferredReleaseDate });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed));
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "promotedOwner", "PATCH", { expectedVersion: reviewed.data.requestVersion })).status, 403);
  const approved = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: reviewed.data.requestVersion }); assert.equal(approved.status, 200, JSON.stringify(approved));
  const conflict = await http(`/seedling-requests/${request.id}/late-release-conflict`, "officer", "PATCH", { expectedVersion: approved.data.requestVersion, availableReleaseDate: "2099-01-04", reason: "Later seedling availability" }); assert.equal(conflict.status, 200, JSON.stringify(conflict));
  body.action = "late-proposal"; body.expectedVersion = conflict.data.requestVersion; body.reschedulingVersion = conflict.data.lateReleaseRescheduling.version; body.plantingDate = "2099-01-05"; body.receiptReference = "SIGNED-LATE-SCHEDULE-004";
  const proposed = await send("staff", true, `/walk-in/${request.id}/schedule`, "PATCH"); assert.equal(proposed.status, 200, JSON.stringify(proposed));
  assert.equal(proposed.data.lateReleaseRescheduling.requesterProposal.submittedBy, identities.staff.uid);
  assert.equal((await http(`/seedling-requests/${request.id}/late-release-rescheduling/approve`, "staff", "PATCH", { expectedVersion: proposed.data.requestVersion })).status, 403);
  const decided = await http(`/seedling-requests/${request.id}/late-release-rescheduling/approve`, "officer", "PATCH", { expectedVersion: proposed.data.requestVersion, reschedulingVersion: proposed.data.lateReleaseRescheduling.version, proposalVersion: proposed.data.lateReleaseRescheduling.requesterProposal.proposalVersion }); assert.equal(decided.status, 200, JSON.stringify(decided));
  const released = await http(`/seedling-requests/${request.id}/release`, "officer", "PATCH", { expectedVersion: decided.data.requestVersion, availableReleaseDate: "2099-01-04", items: [{ inventoryId: "narra", releasedQuantity: 2 }] });
  assert.equal(released.status, 200, JSON.stringify(released)); assert.equal(released.data.reportingPolicy.reporting, "NOT_REQUIRED");
  assert.equal(memory.records("walkInAcknowledgements").get(request.id).history.length, 3);
  assert.ok(![...memory.records("notifications").values()].some(n => n.recipientUserId === request.participantId));
  assert.equal(memory.records("distributions").get(request.id).reportingPolicy.reportingOverdueApplicable, false);

  const useBody = extra => { for (const key of Object.keys(body)) delete body[key]; Object.assign(body, payload(), { purpose: "Household / Backyard" }, extra); body.workflow.requestContractVersion = 2; body.workflow.purpose = "Household / Backyard"; };
  const citizen = { fullName: "Plain Walk-in Citizen", contactNumber: "09171234567", assistedByName: "Maria Santos" };
  useBody({ citizen: { ...citizen } });
  const plain = await send("staff", false); assert.equal(plain.status, 201, JSON.stringify(plain));
  assert.equal(plain.data.walkIn.acknowledgement, null); assert.equal(plain.data.walkIn.receiptReference, "");
  assert.equal(memory.records("walkInAcknowledgements").get(plain.data.id).descriptor, null);
  assert.equal((await http(`/seedling-requests/${plain.data.id}/acknowledgement`, "officer")).status, 404);
  const plainReturned = await http(`/seedling-requests/${plain.data.id}/return`, "officer", "PATCH", { expectedVersion: plain.data.requestVersion, reason: "Clarify the site" });
  assert.equal(plainReturned.status, 200, JSON.stringify(plainReturned));
  body.expectedVersion = plainReturned.data.requestVersion;
  const plainResubmitted = await send("staff", false, `/walk-in/${plain.data.id}/resubmit`, "PATCH");
  assert.equal(plainResubmitted.status, 200, JSON.stringify(plainResubmitted)); assert.equal(plainResubmitted.data.walkIn.acknowledgement, null);

  useBody({ citizen: { ...citizen, fullName: "Earlier Walk-in Citizen", receiptReference: "OLD-RECEIPT-1" } });
  const earlier = await send("staff", true); assert.equal(earlier.status, 201, JSON.stringify(earlier));
  const earlierReturned = await http(`/seedling-requests/${earlier.data.id}/return`, "officer", "PATCH", { expectedVersion: earlier.data.requestVersion, reason: "Clarify the site" });
  body.expectedVersion = earlierReturned.data.requestVersion; delete body.citizen.receiptReference;
  const earlierResubmitted = await send("staff", false, `/walk-in/${earlier.data.id}/resubmit`, "PATCH");
  assert.equal(earlierResubmitted.status, 200, JSON.stringify(earlierResubmitted));
  assert.equal(earlierResubmitted.data.walkIn.receiptReference, "OLD-RECEIPT-1");
  assert.equal(earlierResubmitted.data.walkIn.acknowledgement.originalName, earlier.data.walkIn.acknowledgement.originalName);
  assert.equal(earlierResubmitted.data.walkIn.acknowledgementStatus, "RECEIVED_PENDING_MANUAL_REVIEW");

});

test("citizen and encoder remain unable to process an assisted request after a role change", () => {
  const { assertIndependentRequestAction } = require("../src/utils/requestSeparation.util");
  const historic = { participantId: "citizen", walkIn: { encodedBy: "encoder" }, status: "Pending", requestVersion: 0 };
  const before = JSON.stringify(historic);
  for (const uid of ["citizen", "encoder"]) assert.throws(() => assertIndependentRequestAction(historic, uid), error => error.code === "REQUEST_SELF_PROCESSING_FORBIDDEN");
  assert.doesNotThrow(() => assertIndependentRequestAction(historic, "independent-officer"));
  assert.equal(JSON.stringify(historic), before);
});
