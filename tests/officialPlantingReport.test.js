const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { queryMemory } = require("./helpers/queryMemory");
const memory = queryMemory(); let nextId = 0;
const collection = memory.db.collection.bind(memory.db);
memory.db.collection = name => { const ref = collection(name), doc = ref.doc; return { ...ref, doc: id => doc(id || `generated-${++nextId}`) }; };
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: memory.db } };
const service = require("../src/services/officialPlantingReport.service");
const { summarizeSubmissions } = require("../src/services/parentPlantingReport.service");
const staff = { uid: "staff-real", fullName: "Verified Staff", role: "staff" }, admin = { uid: "admin-real", role: "admin" };
function seed(suffix, requestType = "individual", released = 10) {
  const requestId = `req-${suffix}`, eventId = `evt-${suffix}`, reportId = `event_${eventId}`;
  memory.records("seedlingRequests").set(requestId, { status: "Released", eventId, participantId: "requester-real", participantName: "Real requester", requestType, workflow: { sector: "Resident / Individual" } });
  memory.records("distributions").set(requestId, { requestId, eventId, participantId: "requester-real", status: "Released", items: [{ inventoryId: "narra", releasedQuantity: released }] });
  memory.records("events").set(eventId, { sourceRequestId: requestId, allocationReleasedAt: "2026-01-01", date: "2026-01-01", startTime: "08:00", plantingSiteId: "site-fixture", seedlingItems: [{ inventoryId: "narra", species: "Narra", quantity: released }], seedlingTotalQuantity: released });
  memory.records("plantingReports").set(reportId, { reportType: "parent", requestId, eventId, participantId: "requester-real", quantityReleased: released, quantityPlanted: 0, acceptedQuantity: 0, activeSubmittedQuantity: 0, pendingReviewQuantity: 0, reportingProgress: "Awaiting Submission" });
  return { requestId, eventId, reportId };
}
function payload(requestId, quantityPlanted = 6, leftoverQuantity = 2) {
  return { requestId, confirmationBasis: "menro-field-report", items: [{ inventoryId: "narra", quantityPlanted, leftoverQuantity }], remarks: "Official fixture report", clientSubmissionId: randomUUID(), expectedVersion: 0 };
}
// Trusted linkage fixture only: these unit tests do not claim real photo verification.
function verifiedEvidence(id) {
  const row = memory.records("plantingContributions").get(id);
  const op = memory.records("officialPlantingOperations").get(row.officialOperationId);
  Object.assign(op, { evidenceVerified: true, evidenceRevision: Number(row.revision || 0), evidenceSubmissionId: id });
  Object.assign(row, { hasVerifiedPlantingEvidence: true, officialEvidenceSubmissionId: id,
    photos: [{ privateEvidence: { uploadIntentId: "unit-server-reference" }, gpsValid: true, siteGpsValid: true, timestampValid: true }] });
}

test("Staff reporting derives identities and release quantities; requester documentation remains optional", async () => {
  const fixture = seed("optional");
  const result = await service.submitOfficialReport(staff, payload(fixture.requestId));
  assert.equal(result.activeSubmittedQuantity, 6); assert.equal(result.declaredLeftoverQuantity, 2); assert.equal(result.remainingAvailableQuantity, 2); assert.equal(result.acceptedQuantity, 0);
  assert.equal(result.submissions[0].submittedByName, "Verified Staff"); assert.equal(result.submissions[0].requesterName, "Real requester");
  assert.equal(result.submissions[0].staffReviewStatus, "Pending Review"); assert.equal(result.submissions[0].adminApprovalRequired, true); assert.deepEqual(result.submissions[0].photos, []);
});
test("Participant/Admin/unauthenticated cannot create Staff reports and body identities are rejected", async () => {
  const fixture = seed("roles");
  for (const user of [null, admin, { uid: "participant", role: "participant" }]) await assert.rejects(service.submitOfficialReport(user, payload(fixture.requestId)), error => [401, 403].includes(error.status));
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId), staffName: "spoof" }), /Unsupported/);
});
test("release-based individual confirmation excludes leftovers and never trusts a client planted total", async () => {
  const fixture = seed("release");
  const input = { ...payload(fixture.requestId, 999999, 2), confirmationBasis: "release-based" };
  const report = await service.submitOfficialReport(staff, input);
  assert.equal(report.quantityPlanted, 8); assert.equal(report.acceptedQuantity, 0); assert.equal(report.remainingAvailableQuantity, 0);
  assert.equal(report.submissions[0].confirmationBasis, "release-based");
  const approved = await service.reviewOfficialSubmission(admin, report.submissions[0].id, true);
  assert.equal(approved.acceptedQuantity, 8); assert.equal(approved.acceptedLeftoverQuantity, 2); assert.equal(approved.reportingProgress, "Completed");
  assert.equal(memory.records("events").get(fixture.eventId).recordedSeedlingQuantity, 8);
  await assert.rejects(service.reviewOfficialSubmission(admin, report.submissions[0].id, true), error => error.status === 409);
});
test("organization cannot use release-based confirmation", async () => {
  const fixture = seed("organization", "organization");
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId), confirmationBasis: "release-based" }), error => error.status === 400);
  assert.equal(memory.records("events").get(fixture.eventId).recordedSeedlingQuantity, undefined);
});
test("per-species planted plus leftovers are reserved atomically and retries consume once", async () => {
  const fixture = seed("retry"); const input = payload(fixture.requestId, 6, 2);
  const results = await Promise.allSettled([service.submitOfficialReport(staff, input), service.submitOfficialReport(staff, input)]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 2);
  const event = memory.records("events").get(fixture.eventId); assert.equal(event.recordedSeedlingQuantity, 6); assert.equal(event.leftoverSeedlingQuantity, 2);
  await assert.rejects(service.submitOfficialReport(staff, { ...input, items: [{ inventoryId: "narra", quantityPlanted: 1, leftoverQuantity: 1 }] }), error => error.status === 409);
  await assert.rejects(service.submitOfficialReport(staff, payload(fixture.requestId, 1, 0)), /balance changed/);
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId, 3, 0), expectedVersion: 1 }), /exceed/);
  const next = await service.submitOfficialReport(staff, { ...payload(fixture.requestId, 2, 0), expectedVersion: 1 });
  assert.equal(next.quantityPlanted, 8); assert.equal(next.declaredLeftoverQuantity, 2); assert.equal(next.remainingAvailableQuantity, 0);
});
test("concurrent different submissions cannot over-consume one release", async () => {
  const fixture = seed("race");
  const results = await Promise.allSettled([service.submitOfficialReport(staff, payload(fixture.requestId, 6, 2)), service.submitOfficialReport(staff, payload(fixture.requestId, 6, 2))]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1); assert.equal(results.filter(row => row.status === "rejected" && row.reason.status === 409).length, 1);
});
test("Admin return releases only this submission's quantities and correction preserves history", async () => {
  const fixture = seed("correction");
  const report = await service.submitOfficialReport(staff, payload(fixture.requestId, 6, 2)); const id = report.submissions[0].id;
  await assert.rejects(service.reviewOfficialSubmission(staff, id, true), error => error.status === 403);
  await assert.rejects(service.reviewOfficialSubmission(admin, id, false, "  "), error => error.status === 400);
  const returned = await service.reviewOfficialSubmission(admin, id, false, "Correct the counted quantity");
  assert.equal(returned.remainingAvailableQuantity, 10); assert.equal(returned.submissions[0].staffReviewStatus, "Rejected");
  const corrected = await service.submitOfficialReport(staff, { ...payload(fixture.requestId, 7, 3), correctionOf: id, expectedVersion: 2 });
  assert.equal(corrected.submissions.length, 2); const row = corrected.submissions.find(row => row.correctionOf === id); assert.equal(row.revision, 1);
  verifiedEvidence(row.id);
  const approved = await service.reviewOfficialSubmission(admin, row.id, true);
  assert.equal(approved.acceptedQuantity, 7); assert.equal(approved.acceptedLeftoverQuantity, 3); assert.equal(approved.reportingProgress, "Completed");
});
test("invalid species, negative/fractional numbers and mixed request/event ownership fail closed", async () => {
  const fixture = seed("invalid");
  for (const value of [-1, 1.5, "1e3", "", Infinity]) await assert.rejects(service.submitOfficialReport(staff, payload(fixture.requestId, value, 0)), error => error.status === 400);
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "not-released", quantityPlanted: 1, leftoverQuantity: 0 }] }), error => error.status === 400);
  memory.records("distributions").get(fixture.requestId).participantId = "other-owner";
  await assert.rejects(service.submitOfficialReport(staff, payload(fixture.requestId)), /must agree/);
});
test("historical summaries remain unchanged; leftovers are never a planted or surviving count", () => {
  const historic = summarizeSubmissions([{ quantity: 2, verificationStatus: "Verified", staffReviewStatus: "Not Required" }], 10);
  assert.equal(historic.acceptedQuantity, 2); assert.equal(historic.remainingAvailableQuantity, 8);
  const withLeftover = summarizeSubmissions([{ quantity: 2, verificationStatus: "Verified", staffReviewStatus: "Not Required" }, { quantity: 6, leftoverQuantity: 2, staffReviewStatus: "Accepted", verificationStatus: "Needs Review", staffApprovalRequired: true }], 10);
  assert.equal(withLeftover.acceptedQuantity, 8); assert.equal(withLeftover.acceptedLeftoverQuantity, 2); assert.equal(withLeftover.remainingAvailableQuantity, 0); assert.equal(withLeftover.reportingProgress, "Completed");
});

test("the 2 previously planted + 6 new planted + 2 leftover example confirms eight and preserves history", async () => {
  const fixture = seed("historical-example");
  const prior = { reportId: fixture.reportId, inventoryId: "narra", quantity: 2, verificationStatus: "Verified", staffReviewStatus: "Not Required", photos: [{ hasEvidence: true }] };
  memory.records("plantingContributions").set("historical-two", prior);
  Object.assign(memory.records("events").get(fixture.eventId), { recordedSeedlingsByInventory: { narra: 2 }, recordedSeedlingQuantity: 2 });
  Object.assign(memory.records("plantingReports").get(fixture.reportId), { quantityPlanted: 2, activeSubmittedQuantity: 2, acceptedQuantity: 2 });
  const before = JSON.stringify(prior), flag = process.env.VERIFIED_PLANTING_COHORT_ENABLED;
  process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true";
  try {
    const report = await service.submitOfficialReport(staff, payload(fixture.requestId, 6, 2));
    const current = report.submissions.find(row => row.officialStaffReport);
    verifiedEvidence(current.id);
    const verified = await service.reviewOfficialSubmission(admin, current.id, true);
    assert.equal(verified.acceptedQuantity, 8); assert.equal(verified.acceptedLeftoverQuantity, 2); assert.equal(verified.remainingAvailableQuantity, 0);
    const cohort = [...memory.records("verifiedPlantingCohorts").values()].find(row => row.source.plantingReportId === fixture.reportId);
    assert.equal(cohort.verifiedPlantedQuantity, 8); assert.equal(cohort.source.species[0].releasedQuantity, 10); assert.equal(cohort.source.species[0].verifiedPlantedQuantity, 8);
    assert.equal(JSON.stringify(memory.records("plantingContributions").get("historical-two")), before);
  } finally { if (flag === undefined) delete process.env.VERIFIED_PLANTING_COHORT_ENABLED; else process.env.VERIFIED_PLANTING_COHORT_ENABLED = flag; }
});

test("field approval requires server-linked evidence for the current revision and valid private photos", async () => {
  const fixture = seed("mandatory-photos");
  const report = await service.submitOfficialReport(staff, payload(fixture.requestId));
  const id = report.submissions[0].id;
  await assert.rejects(service.reviewOfficialSubmission(admin, id, true), error => error.status === 409);
  verifiedEvidence(id);
  const row = memory.records("plantingContributions").get(id);
  const op = memory.records("officialPlantingOperations").get(row.officialOperationId);
  op.evidenceRevision = 1;
  await assert.rejects(service.reviewOfficialSubmission(admin, id, true), error => error.status === 409);
  op.evidenceRevision = 0; row.photos[0].siteGpsValid = false;
  await assert.rejects(service.reviewOfficialSubmission(admin, id, true), error => error.status === 409);
  row.photos[0].siteGpsValid = true;
  assert.equal((await service.reviewOfficialSubmission(admin, id, true)).acceptedQuantity, 6);
});

test("release discovery pages are bounded and use backend document cursors without duplicate records", async () => {
  for (let index = 0; index < 55; index++) seed(`page-${String(index).padStart(3, "0")}`);
  const first = await service.listReleasedOptions(staff); assert.ok(first.options.length <= 50); assert.ok(first.nextCursor);
  const second = await service.listReleasedOptions(staff, { cursor: first.nextCursor });
  const ids = [...first.options, ...second.options].map(row => row.requestId); assert.equal(new Set(ids).size, ids.length);
  await assert.rejects(service.listReleasedOptions(staff, { cursor: "../other" }), error => error.status === 400);
  await assert.rejects(service.listReleasedOptions({ uid: "participant", role: "participant" }), error => error.status === 403);
});
