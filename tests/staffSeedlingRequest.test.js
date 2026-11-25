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
    // Like Firestore update(): dotted field paths ("eventProposal.plantingSiteId") write nested fields.
    return { ...reference, update: async value => {
      const next = structuredClone(memory.records(reference.collection).get(id) || {});
      for (const [path, fieldValue] of Object.entries(value)) {
        const keys = path.split("."); let target = next;
        for (const key of keys.slice(0, -1)) target = target[key] = { ...(target[key] || {}) };
        target[keys.at(-1)] = fieldValue;
      }
      memory.records(reference.collection).set(id, next);
    } };
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
// Simulates a request stored before the Staff-direct fix (e.g. REQ-2026-054): Pending, no submission path.
function makeHistoricalPending(id) {
  const record = { ...memory.records("seedlingRequests").get(id), status: "Pending" };
  for (const key of ["submissionPath", "staffReviewRequired", "reviewStatus", "submittedByUid", "submittedByRole", "submittedByName", "routedToAdminAt"]) delete record[key];
  memory.records("seedlingRequests").set(id, record);
  return record;
}
const noFabricatedReview = (request) => { assert.equal(request.reviewId || "", ""); assert.equal(request.reviewedBy || "", ""); assert.equal(request.reviewedByName || "", ""); assert.equal(request.reviewedAt || null, null); };
function unchangedSnapshot() {
  return JSON.stringify(["seedlingRequests", "notifications", "counters", "seedlingInventory", "events", "distributions", "sites"].map(name => [...memory.records(name)]));
}

test("Staff submits with verified identity directly to Admin approval (Awaiting Approval), canonical inventory and Staff audit; retries are idempotent", async () => {
  const body = payload(); body.participantId = "citizen"; body.participantName = "Forged"; body.status = "Approved";
  Object.assign(body, { submissionPath: "PARTICIPANT_STAFF_REVIEW", staffReviewRequired: true, submittedByUid: "forged", reviewId: "REV-2026-999" });
  body.workflow.fullName = "Forged"; body.workflow.contactNumber = "000";
  const request = await submit("staff", body);
  assert.equal(request.participantId, identities.staff.uid); assert.equal(request.participantName, identities.staff.fullName);
  assert.equal(request.workflow.fullName, identities.staff.fullName); assert.equal(request.workflow.contactNumber, identities.staff.contactNumber);
  assert.equal(request.requesterRole, "staff"); assert.equal(request.reviewHistory[0].actorRole, "staff"); assert.equal(request.status, "Reviewed");
  assert.deepEqual([request.submissionPath, request.staffReviewRequired, request.reviewStatus, request.submittedByUid, request.submittedByRole],
    ["STAFF_DIRECT_TO_ADMIN", false, "Not Required", identities.staff.uid, "staff"]);
  assert.deepEqual([request.reviewHistory[0].routedTo, request.reviewHistory[0].actionBasis], ["ADMIN_APPROVAL", "STAFF_SUBMITTED"]);
  assert.equal(request.reviewHistory.some(entry => entry.action === "reviewed"), false, "no Staff review is recorded");
  noFabricatedReview(request);
  assert.equal(request.items[0].species, "Narra"); assert.equal(request.workflow.areaHectares, 1.75, "an existing site uses its registered area, not the submitted 0.5");
  assert.equal(request.processingEstimate.workingDaysMinimum, 5); assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, 100);
  assert.equal((await submit("staff", body)).id, request.id);
  const notices = [...memory.records("notifications").values()].filter(n => n.relatedRecordId === request.id);
  assert.ok(notices.some(n => n.type === "request_submitted" && n.recipientUserId === identities.staff.uid));
  assert.ok(notices.some(n => n.type === "request_awaiting_admin_approval" && n.recipientUserId === identities.admin.uid));
  assert.ok(!notices.some(n => n.type === "request_submitted_staff"), "no Staff review notification for a Staff submission");
  // Reads never invent a Staff review for a direct-to-Admin request.
  noFabricatedReview((await http(`/seedling-requests/${request.id}`, "admin")).data);
  noFabricatedReview((await http("/seedling-requests", "admin")).data.find(row => row.id === request.id));
});

test("Participant submission stays Pending Review for Staff review even with forged Staff path fields; Admin and unauthenticated submission are denied", async () => {
  const body = payload(); Object.assign(body, { status: "Reviewed", submissionPath: "STAFF_DIRECT_TO_ADMIN", staffReviewRequired: false, requesterRole: "staff", submittedByUid: identities.staff.uid });
  const participant = await submit("participant", body); assert.equal(participant.participantId, identities.participant.uid); assert.equal(participant.reviewHistory[0].actorRole, "participant");
  assert.deepEqual([participant.status, participant.submissionPath, participant.staffReviewRequired, participant.submittedByUid], ["Pending", "PARTICIPANT_STAFF_REVIEW", true, undefined]);
  assert.equal(participant.reviewHistory[0].routedTo, "STAFF_REVIEW");
  const notices = [...memory.records("notifications").values()].filter(n => n.relatedRecordId === participant.id);
  assert.ok(notices.some(n => n.type === "request_submitted_staff" && n.recipientUserId === identities.staff.uid));
  assert.ok(!notices.some(n => n.type === "request_awaiting_admin_approval"));
  assert.equal((await http(`/seedling-requests/${participant.id}/approve`, "admin", "PATCH", { expectedVersion: 0 })).status, 400, "Admin cannot approve before Staff review");
  assert.equal((await http("/seedling-requests", "admin", "POST", payload())).status, 403);
  assert.equal((await http("/seedling-requests", null, "POST", payload())).status, 401);
  for (const role of ["staff", "participant"]) assert.equal((await http("/inventory/available", role)).status, 200);
});

test("Participant path: Staff reviews, then Admin approves; Staff cannot approve and duplicate or stale decisions are refused", async () => {
  const request = await submit("participant");
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "staff", "PATCH", { expectedVersion: 0 })).status, 403);
  const reviewed = await http(`/seedling-requests/${request.id}/review`, "officer", "PATCH", { expectedVersion: 0, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed)); assert.equal(reviewed.data.status, "Reviewed"); assert.match(reviewed.data.reviewId, /^REV-\d{4}-\d{3,}$/);
  const approved = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: reviewed.data.requestVersion });
  assert.equal(approved.status, 200, JSON.stringify(approved)); assert.equal(approved.data.status, "Approved");
  const before = unchangedSnapshot();
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: reviewed.data.requestVersion })).status, 409, "stale duplicate approval");
  assert.notEqual((await http(`/seedling-requests/${request.id}/reject`, "admin", "PATCH", { expectedVersion: approved.data.requestVersion, reason: "Too late to reject" })).status, 200);
  assert.equal(unchangedSnapshot(), before);
  assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, 100, "approval never deducts inventory");
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

test("Staff request goes directly to Admin: no Staff review, Admin approves and independent Staff releases once with calendar and notifications intact", async () => {
  const request = await submit();
  const before = unchangedSnapshot();
  const review = await http(`/seedling-requests/${request.id}/review`, "officer", "PATCH", { expectedVersion: 0, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate });
  assert.equal(review.status, 409, JSON.stringify(review)); assert.equal(review.code, "STAFF_REVIEW_NOT_REQUIRED");
  assert.equal(unchangedSnapshot(), before, "a refused review writes nothing");
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "officer", "PATCH", { expectedVersion: 0 })).status, 403, "Staff never make the final decision");
  const approved = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: 0 });
  assert.equal(approved.status, 200, JSON.stringify(approved)); assert.equal(approved.data.status, "Approved");
  assert.equal(approved.data.reviewHistory.some(entry => entry.action === "reviewed"), false); noFabricatedReview(approved.data);
  const event = memory.records("events").get(approved.data.eventId); assert.equal(event.sourceRequestId, request.id); assert.equal(event.date, "2099-01-02");
  assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, 100);
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: 0 })).status, 409, "duplicate approval with a stale version is refused");
  const release = { expectedVersion: approved.data.requestVersion, availableReleaseDate: "2099-01-01", items: [{ inventoryId: "narra", releasedQuantity: 2 }] };
  assert.equal((await http(`/seedling-requests/${request.id}/release`, "staff", "PATCH", release)).status, 403);
  const released = await http(`/seedling-requests/${request.id}/release`, "officer", "PATCH", release);
  assert.equal(released.status, 200, JSON.stringify(released)); assert.equal(released.data.status, "Released");
  assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, 98); assert.equal(memory.records("distributions").get(request.id).participantId, identities.staff.uid);
  assert.equal(memory.records("distributions").get(request.id).reviewedBy, "", "release records no invented reviewer");
  assert.notEqual((await http(`/seedling-requests/${request.id}/release`, "officer", "PATCH", release)).status, 200);
  assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, 98);
  assert.ok([...memory.records("notifications").values()].some(n => n.type === "request_released" && n.relatedRecordId === request.id && n.recipientUserId === identities.staff.uid));
});

test("Admin rejects a Staff request directly with a reason; finalized requests offer no further decision", async () => {
  const request = await submit();
  assert.equal((await http(`/seedling-requests/${request.id}/reject`, "admin", "PATCH", { expectedVersion: 0 })).status, 400, "a reason is required");
  const rejected = await http(`/seedling-requests/${request.id}/reject`, "admin", "PATCH", { expectedVersion: 0, reason: "Requested species unavailable this season" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected)); assert.equal(rejected.data.status, "Rejected"); noFabricatedReview(rejected.data);
  const stock = memory.records("seedlingInventory").get("narra").availableQuantity;
  assert.notEqual((await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: rejected.data.requestVersion })).status, 200);
  assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, stock, "rejection and refused approval never change inventory");
});

test("Staff My Requests lists only their own and Staff-created requests; a historical returned Staff request is corrected straight to Admin", async () => {
  const request = await submit();
  const officerOwn = await submit("officer");
  const mine = await http("/seedling-requests/my", "staff"); assert.equal(mine.status, 200);
  assert.ok(mine.data.some(row => row.id === request.id));
  assert.ok(!mine.data.some(row => row.id === officerOwn.id), "another Staff member's request is not My Request");
  assert.ok(mine.data.every(row => row.participantId === identities.staff.uid || row.walkIn?.encodedBy === identities.staff.uid || row.submittedByUid === identities.staff.uid));
  assert.ok(!(await http("/seedling-requests/my", "officer")).data.some(row => row.id === request.id));
  const participantMine = await http("/seedling-requests/my", "participant");
  assert.ok(participantMine.data.every(row => row.participantId === identities.participant.uid));
  // A direct-to-Admin request cannot be returned by Staff.
  assert.notEqual((await http(`/seedling-requests/${request.id}/return`, "officer", "PATCH", { expectedVersion: 0, reason: "Please clarify care plan" })).status, 200);
  // Historical (pre-fix) Pending Staff request: still returnable by another officer; the correction goes to Admin.
  makeHistoricalPending(request.id);
  const returned = await http(`/seedling-requests/${request.id}/return`, "officer", "PATCH", { expectedVersion: 0, reason: "Please clarify care plan" });
  assert.equal(returned.status, 200, JSON.stringify(returned));
  const body = { ...payload(), expectedVersion: returned.data.requestVersion }; body.workflow.carePlan = "Water daily and protect seedlings";
  assert.notEqual((await http(`/seedling-requests/${request.id}/resubmit`, "officer", "PATCH", body)).status, 200);
  const updated = await http(`/seedling-requests/${request.id}/resubmit`, "staff", "PATCH", body);
  assert.equal(updated.status, 200, JSON.stringify(updated)); assert.equal(updated.data.id, request.id);
  assert.deepEqual([updated.data.status, updated.data.submissionPath, updated.data.reviewStatus], ["Reviewed", "STAFF_DIRECT_TO_ADMIN", "Not Required"]);
  assert.match(updated.message, /Admin approval/);
  assert.equal(updated.data.participantId, identities.staff.uid); assert.equal(updated.data.reviewHistory.at(-1).actorRole, "staff"); assert.equal(updated.data.reviewHistory.at(-1).routedTo, "ADMIN_APPROVAL");
  assert.equal(updated.data.resubmissionProcessingEstimate.workingDaysMinimum, 5); noFabricatedReview(updated.data);
  assert.equal((await http(`/seedling-requests/${request.id}/resubmit`, "staff", "PATCH", body)).status, 409);
  assert.ok([...memory.records("notifications").values()].some(n => n.type === "request_awaiting_admin_approval" && n.relatedRecordId === request.id && /corrected/.test(n.message)));
});

test("pre-approval schedule coordination is not offered on direct-to-Admin requests; historical Pending Staff requests keep it", async () => {
  const request = await submit();
  const refused = await http(`/seedling-requests/${request.id}/pre-approval-schedule`, "officer", "PATCH", { expectedVersion: 0, plantingDate: "2099-01-03", startTime: "09:00", adjustmentReason: "Coordinate available schedule" });
  assert.notEqual(refused.status, 200);
  makeHistoricalPending(request.id);
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
  const approved = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: 0 });
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

// Participant "Other" purpose: Staff review records a policy proposal for reference.
async function reviewedOtherRequest() {
  const body = payload(); body.purpose = "Community special planting";
  body.workflow = { ...body.workflow, requestContractVersion: 2, purpose: "Other", purposeOther: body.purpose };
  const request = await submit("participant", body);
  const review = { expectedVersion: 0, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate,
    policyProposal: { reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE", reason: "Documented reforestation activity" } };
  const reviewed = await http(`/seedling-requests/${request.id}/review`, "officer", "PATCH", review); assert.equal(reviewed.status, 200, JSON.stringify(reviewed));
  assert.equal(reviewed.data.staffPolicyProposal.actorId, identities.officer.uid);
  return request;
}
test("Other purpose without an Admin decision is approved with its policy recorded as pending MENRO policy", async () => {
  const request = await reviewedOtherRequest();
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "staff", "PATCH", { expectedVersion: 1 })).status, 403);
  const result = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: 1 });
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.status, "Approved");
  const snapshot = result.data.approvedPurposePolicy;
  assert.equal(snapshot.approvedBy, identities.admin.uid); assert.equal(snapshot.policyStatus, "PENDING_MENRO_POLICY");
  assert.equal(snapshot.definition.reporting, "PENDING_MENRO_POLICY"); assert.equal(snapshot.definition.monitoring, "PENDING_MENRO_POLICY");
  assert.equal(snapshot.override, null); assert.equal(snapshot.staffProposal.reporting, "REQUIRED", "the Staff proposal is kept but not adopted");
});
test("Other purpose with an explicit Admin decision is validated and snapshotted as resolved", async () => {
  const request = await reviewedOtherRequest();
  const invalid = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: 1, policyDecision: { reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE" } });
  assert.equal(invalid.status, 400, JSON.stringify(invalid));
  const result = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: 1,
    policyDecision: { reporting: "REQUIRED", monitoring: "PERMANENT_SAMPLE", reason: "Admin confirms the applicable reporting and sampling requirement", expectedPolicyVersion: 0 } });
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.approvedPurposePolicy.approvedBy, identities.admin.uid);
  assert.equal(result.data.approvedPurposePolicy.definition.reporting, "REQUIRED"); assert.equal(result.data.approvedPurposePolicy.policyStatus, "RESOLVED");
});
test("Staff-submitted Other purpose goes directly to Admin; a pending MENRO policy does not block approval", async () => {
  const body = payload(); body.purpose = "Community special planting";
  body.workflow = { ...body.workflow, requestContractVersion: 2, purpose: "Other", purposeOther: body.purpose };
  const request = await submit("staff", body);
  assert.equal(request.status, "Reviewed");
  const result = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: 0 });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.approvedPurposePolicy.policyStatus, "PENDING_MENRO_POLICY"); assert.equal(result.data.approvedPurposePolicy.staffProposal, null);
});
test("proposed site: Admin records verified area/capacity when approving a Staff request; never for a Participant request", async () => {
  const proposed = () => { const body = payload(); Object.assign(body.workflow, { siteMode: "proposed", existingSiteId: "", siteName: "Proposed Staff Site", siteBarangay: "Bical", specificLocation: "Purok 3", latitude: "12.65", longitude: "123.91", niyogan: "no", landType: "Residential / Private Property", currentCondition: "Open lot", areaChoice: "", exactArea: "" }); body.eventProposal.plantingSiteId = "PROPOSED"; return body; };
  const staffRequest = await submit("staff", proposed());
  const before = unchangedSnapshot();
  const missing = await http(`/seedling-requests/${staffRequest.id}/approve`, "admin", "PATCH", { expectedVersion: 0 });
  assert.equal(missing.status, 409, JSON.stringify(missing)); assert.match(missing.message, /verified proposed site area and capacity/);
  const invalid = await http(`/seedling-requests/${staffRequest.id}/approve`, "admin", "PATCH", { expectedVersion: 0, siteVerification: { areaHectares: "-1", maximumCapacity: "x" } });
  assert.equal(invalid.status, 400, JSON.stringify(invalid)); assert.ok(invalid.fieldErrors.verifiedAreaHectares && invalid.fieldErrors.verifiedMaximumCapacity);
  assert.equal(unchangedSnapshot(), before, "refused approvals register no site and write nothing");
  const approved = await http(`/seedling-requests/${staffRequest.id}/approve`, "admin", "PATCH", { expectedVersion: 0, siteVerification: { areaHectares: "0.8", maximumCapacity: "600" } });
  assert.equal(approved.status, 200, JSON.stringify(approved));
  const stored = memory.records("seedlingRequests").get(staffRequest.id);
  assert.deepEqual([stored.proposedSiteVerification.areaHectares, stored.proposedSiteVerification.maximumCapacity, stored.proposedSiteVerification.reviewedBy, stored.proposedSiteVerification.verifiedByRole],
    [0.8, 600, identities.admin.uid, "admin"]);
  assert.ok(stored.workflow.officialSiteId); assert.equal(memory.records("sites").get(stored.workflow.officialSiteId).areaHectares, 0.8);
  const participantRequest = await submit("participant", proposed());
  const reviewed = await http(`/seedling-requests/${participantRequest.id}/review`, "officer", "PATCH", { expectedVersion: 0, items: participantRequest.items, purpose: participantRequest.purpose, plantingLocation: participantRequest.plantingLocation, preferredReleaseDate: participantRequest.preferredReleaseDate, siteVerification: { areaHectares: "1.2", maximumCapacity: "900" } });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed));
  const refused = await http(`/seedling-requests/${participantRequest.id}/approve`, "admin", "PATCH", { expectedVersion: reviewed.data.requestVersion, siteVerification: { areaHectares: "5", maximumCapacity: "5000" } });
  assert.equal(refused.status, 400, JSON.stringify(refused)); assert.match(refused.message, /Staff review/);
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
    // Releasing is not a review: before Admin approval it is refused as not approved, and nothing is released.
    if (action === "release") { assert.equal(denied.status, 400); assert.match(denied.message, /Only approved requests can be released/); assert.equal(memory.records("distributions").has(request.id), false); continue; }
    assert.equal(denied.status, 403); assert.equal(denied.code, "REQUEST_SELF_PROCESSING_FORBIDDEN");
  }
  // A Staff-encoded walk-in follows the Staff path: Awaiting Approval, straight to Admin; the citizen stays the requester.
  assert.equal(request.reviewHistory[0].actorId, identities.staff.uid);
  assert.deepEqual([request.status, request.submissionPath, request.reviewStatus, request.submittedByUid, request.requesterRole, request.createdByRole],
    ["Reviewed", "STAFF_DIRECT_TO_ADMIN", "Not Required", identities.staff.uid, "walk-in", "staff"]);
  assert.deepEqual([request.reviewHistory[0].actionBasis, request.reviewHistory[0].citizenRequesterId, request.reviewHistory[0].routedTo], ["STAFF_ENCODED_WALK_IN", request.participantId, "ADMIN_APPROVAL"]);
  noFabricatedReview(request);
  assert.equal(request.walkIn.receiptReference, "WALKIN-ACK-001"); assert.equal(JSON.stringify(result).includes("private-test/"), false);
  assert.ok(memory.records("walkInAcknowledgements").has(request.id));
  assert.equal((await send("staff")).data.id, request.id);
  assert.equal((await http(`/seedling-requests/${request.id}/acknowledgement`, "participant")).status, 403);
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "staff", "PATCH", { expectedVersion: 0 })).status, 403);
  assert.ok(![...memory.records("notifications").values()].some(n => n.recipientUserId === request.participantId));
  assert.ok([...memory.records("notifications").values()].some(n => n.type === "request_awaiting_admin_approval" && n.relatedRecordId === request.id && /walk-in requester Actual Walk-in Citizen/.test(n.message)));
  assert.equal(memory.records("users").has(request.participantId), false);
  // The encoder's My Requests lists the walk-in; another Staff member's does not.
  const mine = await http("/seedling-requests/my", "staff");
  assert.equal(mine.data.find(row => row.id === request.id)?.participantName, "Actual Walk-in Citizen");
  assert.ok(!(await http("/seedling-requests/my", "officer")).data.some(row => row.id === request.id));
  assert.ok(!(await http("/seedling-requests/my", "participant")).data.some(row => row.id === request.id));
  // No Staff review: another officer is refused; Admin decides directly (the promoted encoder cannot).
  const refusedReview = await http(`/seedling-requests/${request.id}/review`, "officer", "PATCH", { expectedVersion: 0, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate });
  assert.equal(refusedReview.status, 409); assert.equal(refusedReview.code, "STAFF_REVIEW_NOT_REQUIRED");
  assert.equal((await http(`/seedling-requests/${request.id}/approve`, "promotedOwner", "PATCH", { expectedVersion: request.requestVersion })).status, 403);
  const approved = await http(`/seedling-requests/${request.id}/approve`, "admin", "PATCH", { expectedVersion: request.requestVersion }); assert.equal(approved.status, 200, JSON.stringify(approved));
  assert.equal(approved.data.participantName, "Actual Walk-in Citizen"); assert.equal(approved.data.walkIn.encodedBy, identities.staff.uid);
  assert.equal(memory.records("events").get(approved.data.eventId).sourceRequestId, request.id);
  // Late-release rescheduling with a signed citizen acknowledgement, then an independent release.
  const conflict = await http(`/seedling-requests/${request.id}/late-release-conflict`, "officer", "PATCH", { expectedVersion: approved.data.requestVersion, availableReleaseDate: "2099-01-04", reason: "Later seedling availability" }); assert.equal(conflict.status, 200, JSON.stringify(conflict));
  body.action = "late-proposal"; body.clientSubmissionId = randomUUID(); body.expectedVersion = conflict.data.requestVersion; body.reschedulingVersion = conflict.data.lateReleaseRescheduling.version; body.plantingDate = "2099-01-05"; body.startTime = "08:00"; body.receiptReference = "SIGNED-LATE-SCHEDULE-004";
  const proposed = await send("staff", true, `/walk-in/${request.id}/schedule`, "PATCH"); assert.equal(proposed.status, 200, JSON.stringify(proposed));
  assert.equal(proposed.data.lateReleaseRescheduling.requesterProposal.submittedBy, identities.staff.uid);
  assert.equal((await http(`/seedling-requests/${request.id}/late-release-rescheduling/approve`, "staff", "PATCH", { expectedVersion: proposed.data.requestVersion })).status, 403);
  const decided = await http(`/seedling-requests/${request.id}/late-release-rescheduling/approve`, "officer", "PATCH", { expectedVersion: proposed.data.requestVersion, reschedulingVersion: proposed.data.lateReleaseRescheduling.version, proposalVersion: proposed.data.lateReleaseRescheduling.requesterProposal.proposalVersion }); assert.equal(decided.status, 200, JSON.stringify(decided));
  const released = await http(`/seedling-requests/${request.id}/release`, "officer", "PATCH", { expectedVersion: decided.data.requestVersion, availableReleaseDate: "2099-01-04", items: [{ inventoryId: "narra", releasedQuantity: 2 }] });
  assert.equal(released.status, 200, JSON.stringify(released)); assert.equal(released.data.reportingPolicy.reporting, "NOT_REQUIRED");
  assert.equal(memory.records("walkInAcknowledgements").get(request.id).history.length, 1);
  assert.ok(![...memory.records("notifications").values()].some(n => n.recipientUserId === request.participantId));
  assert.equal(memory.records("distributions").get(request.id).reportingPolicy.reportingOverdueApplicable, false);

  const useBody = extra => { for (const key of Object.keys(body)) delete body[key]; Object.assign(body, payload(), { purpose: "Household / Backyard" }, extra); body.workflow.requestContractVersion = 2; body.workflow.purpose = "Household / Backyard"; };
  const citizen = { fullName: "Plain Walk-in Citizen", contactNumber: "09171234567", assistedByName: "Maria Santos" };

  // Historical walk-in stored Pending before the fix (REQ-2026-054 shape): existing Staff coordination, return and
  // correction still work; the encoder's correction is then routed straight to Admin.
  useBody({ citizen: { ...citizen, fullName: "Historical Walk-in Citizen", receiptReference: "WALKIN-ACK-HIST" } });
  const historic = await send("staff", true); assert.equal(historic.status, 201, JSON.stringify(historic));
  makeHistoricalPending(historic.data.id);
  assert.ok((await http("/seedling-requests/my", "staff")).data.some(row => row.id === historic.data.id && row.status === "Pending"), "historical walk-ins appear in the encoder's My Requests");
  const coordinated = await http(`/seedling-requests/${historic.data.id}/pre-approval-schedule`, "officer", "PATCH", { expectedVersion: historic.data.requestVersion, plantingDate: "2099-01-03", startTime: "09:00", adjustmentReason: "Citizen coordinated the updated schedule" });
  assert.equal(coordinated.status, 200, JSON.stringify(coordinated));
  Object.assign(body, { action: "confirm", clientSubmissionId: randomUUID(), expectedVersion: coordinated.data.requestVersion, proposalVersion: coordinated.data.preApprovalSchedule.proposalVersion, plantingDate: "2099-01-03", startTime: "09:00", receiptReference: "SIGNED-SCHEDULE-003" });
  assert.equal((await send("officer", true, `/walk-in/${historic.data.id}/schedule`, "PATCH")).status, 404);
  assert.equal((await send("staff", false, `/walk-in/${historic.data.id}/schedule`, "PATCH")).status, 400);
  const confirmed = await send("staff", true, `/walk-in/${historic.data.id}/schedule`, "PATCH"); assert.equal(confirmed.status, 200, JSON.stringify(confirmed));
  assert.equal(confirmed.data.preApprovalSchedule.confirmedBy, identities.staff.uid); assert.equal(confirmed.data.scheduleHistory.at(-1).actorRole, "staff");
  const returned = await http(`/seedling-requests/${historic.data.id}/return`, "officer", "PATCH", { expectedVersion: confirmed.data.requestVersion, reason: "Clarify the signed care plan" });
  assert.equal(returned.status, 200, JSON.stringify(returned));
  for (const key of ["action", "proposalVersion", "plantingDate", "startTime", "receiptReference"]) delete body[key];
  body.clientSubmissionId = historic.data.clientSubmissionId || randomUUID();
  body.expectedVersion = returned.data.requestVersion; body.citizen.receiptReference = "WALKIN-CORRECTION-002";
  body.workflow.carePlan = "Corrected signed citizen plan"; body.citizen.assistedByName = "Jose Reyes";
  assert.equal((await send("officer", true, `/walk-in/${historic.data.id}/resubmit`, "PATCH")).status, 404);
  const corrected = await send("staff", true, `/walk-in/${historic.data.id}/resubmit`, "PATCH");
  assert.equal(corrected.status, 200, JSON.stringify(corrected)); assert.equal(corrected.data.id, historic.data.id);
  assert.equal(corrected.data.walkIn.assistedByName, "Jose Reyes"); assert.equal(corrected.data.walkIn.encodedBy, identities.staff.uid);
  assert.equal(corrected.data.participantId, historic.data.participantId); assert.equal(corrected.data.participantName, "Historical Walk-in Citizen");
  assert.deepEqual([corrected.data.status, corrected.data.submissionPath, corrected.data.reviewStatus, corrected.data.reviewHistory.at(-1).routedTo], ["Reviewed", "STAFF_DIRECT_TO_ADMIN", "Not Required", "ADMIN_APPROVAL"]);
  assert.equal(corrected.data.reviewHistory.some(entry => entry.action === "reviewed"), false); noFabricatedReview(corrected.data);
  assert.equal(memory.records("walkInAcknowledgements").get(historic.data.id).history.length, 2);
  assert.equal(JSON.stringify(corrected).includes("private-test/"), false);
  assert.equal((await send("staff", true, `/walk-in/${historic.data.id}/resubmit`, "PATCH")).status, 409);

  // Plain walk-in without an acknowledgement.
  useBody({ citizen: { ...citizen } });
  const previousMaintenance = process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED;
  let plain;
  try {
    process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED = "true";
    plain = await send("staff", false); assert.equal(plain.status, 201, JSON.stringify(plain));
    const blockedUpload = await send("staff", true); assert.equal(blockedUpload.status, 503, JSON.stringify(blockedUpload));
  } finally {
    if (previousMaintenance === undefined) delete process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED;
    else process.env.EVIDENCE_UPLOAD_MAINTENANCE_ENABLED = previousMaintenance;
  }
  assert.equal(plain.data.walkIn.acknowledgement, null); assert.equal(plain.data.walkIn.receiptReference, ""); assert.equal(plain.data.status, "Reviewed");
  assert.equal(memory.records("walkInAcknowledgements").get(plain.data.id).descriptor, null);
  assert.equal((await http(`/seedling-requests/${plain.data.id}/acknowledgement`, "officer")).status, 404);

  // Historical returned walk-in corrected without a new receipt keeps the original receipt and acknowledgement.
  useBody({ citizen: { ...citizen, fullName: "Earlier Walk-in Citizen", receiptReference: "OLD-RECEIPT-1" } });
  const earlier = await send("staff", true); assert.equal(earlier.status, 201, JSON.stringify(earlier));
  makeHistoricalPending(earlier.data.id);
  const earlierReturned = await http(`/seedling-requests/${earlier.data.id}/return`, "officer", "PATCH", { expectedVersion: earlier.data.requestVersion, reason: "Clarify the site" });
  assert.equal(earlierReturned.status, 200, JSON.stringify(earlierReturned));
  body.expectedVersion = earlierReturned.data.requestVersion; delete body.citizen.receiptReference;
  const earlierResubmitted = await send("staff", false, `/walk-in/${earlier.data.id}/resubmit`, "PATCH");
  assert.equal(earlierResubmitted.status, 200, JSON.stringify(earlierResubmitted));
  assert.equal(earlierResubmitted.data.walkIn.receiptReference, "OLD-RECEIPT-1");
  assert.equal(earlierResubmitted.data.walkIn.acknowledgement.originalName, earlier.data.walkIn.acknowledgement.originalName);
  assert.equal(earlierResubmitted.data.walkIn.acknowledgementStatus, "RECEIVED_PENDING_MANUAL_REVIEW");
  assert.equal(earlierResubmitted.data.status, "Reviewed");

});

// Walk-in release: review/approval stay independent; releasing an already approved request does not need another officer.
async function walkInRequest(purpose) {
  const created = await submit("staff", undefined), record = memory.records("seedlingRequests").get(created.id);
  memory.records("seedlingRequests").set(created.id, { ...record, participantId: "walkin_citizen", participantName: "Walk-in Citizen", requesterRole: "walk-in", createdByRole: "staff",
    walkIn: { encodedBy: identities.staff.uid, encodedByName: identities.staff.fullName, citizenHasAccount: false }, ...(purpose ? { purpose } : {}) });
  return memory.records("seedlingRequests").get(created.id) && created.id;
}
const approveWalkIn = async id => { const response = await http(`/seedling-requests/${id}/approve`, "admin", "PATCH", { expectedVersion: 0 }); assert.equal(response.status, 200, JSON.stringify(response)); return response.data; };
const releaseBody = (request, extra = {}) => ({ expectedVersion: request.requestVersion, availableReleaseDate: "2099-01-01", items: [{ inventoryId: "narra", releasedQuantity: 2 }], ...extra });

test("the Staff encoder releases an Admin-approved walk-in once: actual quantities, releaser, stock and the citizen requester are recorded", async () => {
  const id = await walkInRequest(), path = `/seedling-requests/${id}/release`;
  const early = await http(path, "staff", "PATCH", { ...releaseBody({ requestVersion: 0 }) });
  assert.equal(early.status, 400, "not before Admin approval"); assert.match(early.message, /Only approved requests/);
  const own = memory.records("seedlingRequests").get(id);
  for (const [action, body] of [["review", { items: own.items, purpose: own.purpose, plantingLocation: own.plantingLocation, preferredReleaseDate: own.preferredReleaseDate }], ["return", { reason: "Correction needed" }]]) assert.equal((await http(`/seedling-requests/${id}/${action}`, "staff", "PATCH", { expectedVersion: 0, ...body })).code, "REQUEST_SELF_PROCESSING_FORBIDDEN");
  const approved = await approveWalkIn(id), before = unchangedSnapshot();
  for (const role of ["participant", "admin"]) assert.equal((await http(path, role, "PATCH", releaseBody(approved))).status, 403);
  for (const items of [[{ inventoryId: "narra", releasedQuantity: 3 }], [{ inventoryId: "narra", releasedQuantity: 0 }], [{ inventoryId: "narra", releasedQuantity: 1 }], [{ inventoryId: "other", releasedQuantity: 2 }]])
    assert.equal((await http(path, "staff", "PATCH", releaseBody(approved, { items }))).status, 400);
  const stock = memory.records("seedlingInventory").get("narra"); memory.records("seedlingInventory").set("narra", { ...stock, availableQuantity: 1, currentQuantity: 1 });
  const short = await http(path, "staff", "PATCH", releaseBody(approved)); assert.equal(short.status, 400); assert.match(short.message, /available stock/);
  memory.records("seedlingInventory").set("narra", stock); assert.equal(unchangedSnapshot(), before, "refused releases write nothing");
  const available = Number(stock.currentQuantity ?? stock.availableQuantity);
  const released = await http(path, "staff", "PATCH", releaseBody(approved)); assert.equal(released.status, 200, JSON.stringify(released));
  assert.deepEqual([released.data.status, released.data.releasedBy, released.data.totalQuantityReleased, released.data.releaseType], ["Released", identities.staff.uid, 2, "Complete"]); assert.ok(released.data.releasedAt);
  assert.deepEqual([released.data.participantId, released.data.participantName, released.data.walkIn.encodedBy], ["walkin_citizen", "Walk-in Citizen", identities.staff.uid]);
  const distribution = memory.records("distributions").get(id); assert.deepEqual([distribution.participantId, distribution.releasedBy, distribution.status], ["walkin_citizen", identities.staff.uid, "Released"]);
  assert.equal(memory.records("seedlingInventory").get("narra").availableQuantity, available - 2);
  const after = unchangedSnapshot();
  for (const role of ["staff", "officer"]) for (const expectedVersion of [approved.requestVersion, released.data.requestVersion]) assert.notEqual((await http(path, role, "PATCH", releaseBody(approved, { expectedVersion }))).status, 200);
  assert.equal(unchangedSnapshot(), after, "a second release writes nothing");
});

test("another Staff member may still release a walk-in, and the encoder may record a late-release conflict but never decide it", async () => {
  const first = await walkInRequest(), approved = await approveWalkIn(first);
  assert.equal((await http(`/seedling-requests/${first}/release`, "officer", "PATCH", releaseBody(approved))).data.releasedBy, identities.officer.uid);
  const second = await walkInRequest(), other = await approveWalkIn(second);
  const conflict = await http(`/seedling-requests/${second}/late-release-conflict`, "staff", "PATCH", { expectedVersion: other.requestVersion, availableReleaseDate: "2099-01-04", reason: "Later seedling availability" });
  assert.equal(conflict.status, 200, JSON.stringify(conflict));
  for (const action of ["approve", "return"]) assert.equal((await http(`/seedling-requests/${second}/late-release-rescheduling/${action}`, "staff", "PATCH", { expectedVersion: conflict.data.requestVersion, reason: "Correction needed" })).code, "REQUEST_SELF_PROCESSING_FORBIDDEN");
  const blocked = await http(`/seedling-requests/${second}/release`, "staff", "PATCH", releaseBody(conflict.data)); assert.equal(blocked.status, 409, "the schedule conflict must be resolved first");
});

test("release separation: never the requester, and never the officer who both encoded and approved", () => {
  const { assertIndependentRequestAction, assertReleaseAction } = require("../src/utils/requestSeparation.util");
  const request = { participantId: "citizen", walkIn: { encodedBy: "encoder" }, approvedBy: "admin" };
  for (const uid of ["encoder", "officer"]) assert.doesNotThrow(() => assertReleaseAction(request, uid));
  for (const [row, uid] of [[request, "citizen"], [{ participantId: "staff" }, "staff"], [{ ...request, approvedBy: "encoder" }, "encoder"], [request, ""], [request, undefined]]) assert.throws(() => assertReleaseAction(row, uid), error => error.status === 403 && error.code === "REQUEST_SELF_PROCESSING_FORBIDDEN");
  assert.throws(() => assertIndependentRequestAction(request, "encoder"), error => error.code === "REQUEST_SELF_PROCESSING_FORBIDDEN", "review and approval rules are unchanged");
});

test("citizen and encoder remain unable to process an assisted request after a role change", () => {
  const { assertIndependentRequestAction } = require("../src/utils/requestSeparation.util");
  const historic = { participantId: "citizen", walkIn: { encodedBy: "encoder" }, status: "Pending", requestVersion: 0 };
  const before = JSON.stringify(historic);
  for (const uid of ["citizen", "encoder"]) assert.throws(() => assertIndependentRequestAction(historic, uid), error => error.code === "REQUEST_SELF_PROCESSING_FORBIDDEN");
  assert.doesNotThrow(() => assertIndependentRequestAction(historic, "independent-officer"));
  assert.equal(JSON.stringify(historic), before);
});
