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
function seed(suffix, requestType = "individual", released = 8) {
  const requestId = `req-${suffix}`, eventId = `evt-${suffix}`, reportId = `event_${eventId}`;
  memory.records("seedlingRequests").set(requestId, { status: "Released", eventId, participantId: "requester-real", participantName: "Real requester", requestType, workflow: { sector: "Resident / Individual" } });
  memory.records("distributions").set(requestId, { requestId, eventId, participantId: "requester-real", status: "Released", items: [{ inventoryId: "narra", releasedQuantity: released }] });
  memory.records("events").set(eventId, { sourceRequestId: requestId, allocationReleasedAt: "2026-01-01", date: "2026-01-01", startTime: "08:00", plantingSiteId: "site-fixture", seedlingItems: [{ inventoryId: "narra", species: "Narra", quantity: released }], seedlingTotalQuantity: released });
  memory.records("plantingReports").set(reportId, { reportType: "parent", requestId, eventId, participantId: "requester-real", quantityReleased: released, quantityPlanted: 0, acceptedQuantity: 0, activeSubmittedQuantity: 0, pendingReviewQuantity: 0, reportingProgress: "Awaiting Submission" });
  return { requestId, eventId, reportId };
}
function payload(requestId, quantityPlanted = 6, leftoverQuantity = 2) {
  return { requestId, confirmationBasis: "menro-field-report", items: [{ inventoryId: "narra", quantityPlanted, leftoverQuantity, ...(leftoverQuantity > 0 ? { leftoverReason: "Seedlings damaged in transport" } : {}) }], remarks: "Official fixture report", clientSubmissionId: randomUUID(), expectedVersion: 0 };
}
// Historical-compatibility tests exercise the legacy per-type path.
async function legacyReporting(run) {
  const previous = process.env.PLANTING_FINAL_REPORT_ENFORCED;
  process.env.PLANTING_FINAL_REPORT_ENFORCED = "false";
  try { return await run(); } finally {
    if (previous === undefined) delete process.env.PLANTING_FINAL_REPORT_ENFORCED; else process.env.PLANTING_FINAL_REPORT_ENFORCED = previous;
  }
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
  assert.equal(result.activeSubmittedQuantity, 6); assert.equal(result.declaredLeftoverQuantity, 2); assert.equal(result.remainingAvailableQuantity, 0); assert.equal(result.acceptedQuantity, 0);
  assert.equal(result.submissions[0].submittedByName, "Verified Staff"); assert.equal(result.submissions[0].requesterName, "Real requester");
  assert.equal(result.submissions[0].staffReviewStatus, "Pending Review"); assert.equal(result.submissions[0].adminApprovalRequired, true); assert.deepEqual(result.submissions[0].photos, []);
});
test("Participant/Admin/unauthenticated cannot create Staff reports and body identities are rejected", async () => {
  const fixture = seed("roles");
  for (const user of [null, admin, { uid: "participant", role: "participant" }]) await assert.rejects(service.submitOfficialReport(user, payload(fixture.requestId)), error => [401, 403].includes(error.status));
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId), staffName: "spoof" }), /Unsupported/);
});
test("release-based individual confirmation excludes leftovers and never trusts a client planted total", async () => {
  const fixture = seed("release", "individual", 10);
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
test("planted quantity is derived from the available balance minus leftovers", async () => {
  const fixture = seed("derived");
  const report = await service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "narra", leftoverQuantity: 3, leftoverReason: "Seedlings damaged in transport" }] });
  const event = memory.records("events").get(fixture.eventId);
  assert.equal(event.recordedSeedlingQuantity, 5); assert.equal(event.leftoverSeedlingQuantity, 3);
  assert.equal(report.quantityPlanted, 5); assert.equal(report.declaredLeftoverQuantity, 3);
});
test("leftover defaults mean all available seedlings were planted", async () => {
  const fixture = seed("all-planted");
  await service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "narra", leftoverQuantity: 0 }] });
  assert.equal(memory.records("events").get(fixture.eventId).recordedSeedlingQuantity, 8);
});
test("leftovers cannot be negative or exceed the available balance", async () => {
  const fixture = seed("leftover-limits"); const send = leftoverQuantity => service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "narra", leftoverQuantity, ...(Number(leftoverQuantity) > 0 ? { leftoverReason: "Seedlings damaged in transport" } : {}) }] });
  await assert.rejects(send(-1), error => error.status === 400);
  await assert.rejects(send(9), error => error.status === 409 && /exceed/.test(error.message));
});
test("a planted value that disagrees with the balance is rejected instead of a partial report", async () => {
  const fixture = seed("partial-rejected");
  await assert.rejects(service.submitOfficialReport(staff, payload(fixture.requestId, 3, 2)), error => error.status === 409 && /Refresh/.test(error.message));
  assert.equal(Number(memory.records("events").get(fixture.eventId).recordedSeedlingQuantity || 0), 0);
});
test("per-species planted plus leftovers are reserved atomically and retries consume once", async () => {
  const fixture = seed("retry"); const input = payload(fixture.requestId, 6, 2);
  const results = await Promise.allSettled([service.submitOfficialReport(staff, input), service.submitOfficialReport(staff, input)]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 2);
  const event = memory.records("events").get(fixture.eventId); assert.equal(event.recordedSeedlingQuantity, 6); assert.equal(event.leftoverSeedlingQuantity, 2);
  await assert.rejects(service.submitOfficialReport(staff, { ...input, items: [{ inventoryId: "narra", quantityPlanted: 1, leftoverQuantity: 1, leftoverReason: "Seedlings damaged in transport" }] }), error => error.status === 409);
  await assert.rejects(service.submitOfficialReport(staff, payload(fixture.requestId, 1, 0)), /balance changed/);
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId, 3, 0), expectedVersion: 1 }), /exceed|already pending/);
});
test("concurrent different submissions cannot over-consume one release", async () => {
  const fixture = seed("race");
  const results = await Promise.allSettled([service.submitOfficialReport(staff, payload(fixture.requestId, 6, 2)), service.submitOfficialReport(staff, payload(fixture.requestId, 6, 2))]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1); assert.equal(results.filter(row => row.status === "rejected" && row.reason.status === 409).length, 1);
});
test("Admin return releases only this submission's quantities and correction preserves history", async () => {
  const fixture = seed("correction", "individual", 10);
  const report = await service.submitOfficialReport(staff, payload(fixture.requestId, 8, 2)); const id = report.submissions[0].id;
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
test("Staff reports go directly to Admin; Admin rejection is final while a return stays correctable", async () => {
  memory.records("users").set("admin-notify", { role: "admin", status: "active" });
  const fixture = seed("finality", "individual", 10);
  const report = await service.submitOfficialReport(staff, payload(fixture.requestId, 8, 2)); const id = report.submissions[0].id;
  assert.equal(report.submissions[0].workflowStatus, "Pending Admin Approval");
  const submittedNotice = [...memory.records("notifications").values()].find(row => row.recipientUserId === "admin-notify" && row.relatedSubrecordId === id);
  assert.equal(submittedNotice?.type, "planting_report_submitted_admin");
  await assert.rejects(service.reviewOfficialSubmission(admin, id, "reject", "  "), error => error.status === 400);
  await assert.rejects(service.reviewOfficialSubmission(admin, id, "unknown", "Reason"), error => error.status === 400);
  const rejected = await service.reviewOfficialSubmission(admin, id, "reject", "Field count could not be verified");
  const row = rejected.submissions.find(entry => entry.id === id);
  assert.equal(row.workflowStatus, "Rejected"); assert.equal(row.correctionAllowed, false);
  assert.equal(row.rejectionReason, "Field count could not be verified");
  assert.equal(rejected.remainingAvailableQuantity, 10, "an Admin rejection releases the balance");
  assert.equal(memory.records("notifications").get(`official_planting_${id}_rejected`).type, "planting_report_rejected");
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId, 7, 3), correctionOf: id, expectedVersion: 2 }), /cannot be corrected/);
  const logs = [...memory.records("verificationLogs").values()].filter(log => log.submissionId === id).map(log => log.action);
  assert.deepEqual(logs, ["Staff Submission", "Admin Rejection"]);

  const second = await service.submitOfficialReport(staff, { ...payload(fixture.requestId, 8, 2), expectedVersion: 2 });
  const secondId = second.submissions.find(entry => entry.workflowStatus === "Pending Admin Approval").id;
  const returned = await service.reviewOfficialSubmission(admin, secondId, "return", "Attach the attendance sheet");
  const returnedRow = returned.submissions.find(entry => entry.id === secondId);
  assert.equal(returnedRow.workflowStatus, "Returned for Correction"); assert.equal(returnedRow.correctionAllowed, true);
  assert.equal(returnedRow.returnReason, "Attach the attendance sheet");
  assert.equal(memory.records("notifications").get(`official_planting_${secondId}_correction`).type, "planting_report_returned");
});
test("legacy official Staff rejections remain correctable as returns", async () => {
  const fixture = seed("legacy-return", "individual", 10);
  const report = await service.submitOfficialReport(staff, payload(fixture.requestId, 8, 2)); const id = report.submissions[0].id;
  const returned = await service.reviewOfficialSubmission(admin, id, false, "Correct the counted quantity");
  delete memory.records("plantingContributions").get(id).workflowStatus; // a record written before the workflow field existed
  assert.equal(summarizeSubmissions([memory.records("plantingContributions").get(id)], 10).submissions[0].workflowStatus, "Returned for Correction");
  const corrected = await service.submitOfficialReport(staff, { ...payload(fixture.requestId, 7, 3), correctionOf: id, expectedVersion: returned.officialReportingVersion ?? 2 });
  assert.equal(corrected.submissions.find(row => row.correctionOf === id).revision, 1);
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
  const fixture = seed("historical-example", "individual", 10);
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

test("release options map authoritative requester, site, schedule and references without inventing sector or coordinates", async () => {
  const fixture = seed("mapped");
  Object.assign(memory.records("seedlingRequests").get(fixture.requestId), { requestNumber: "REQ-2026-123", workflow: { sector: "Resident / Individual", requestingAs: "individual", organizationName: "Actual organization" } });
  Object.assign(memory.records("events").get(fixture.eventId), { name: "Approved activity", endTime: "10:00" });
  memory.records("sites").set("site-fixture", { siteName: "Registered site", barangay: "Bical", latitude: 12.6, longitude: 123.9, coverageRadiusMeters: 50 });
  const result = await service.listReleasedOptions(staff, { requestId: fixture.requestId });
  assert.equal(result.options.length, 1);
  const option = result.options[0];
  assert.equal(option.requesterName, "Real requester"); assert.equal(option.participantSector, "Resident / Individual");
  assert.equal(option.organizationName, "Actual organization"); assert.equal(option.latitude, 12.6); assert.equal(option.longitude, 123.9);
  assert.equal(option.siteName, "Registered site"); assert.equal(option.barangay, "Bical"); assert.equal(option.startTime, "08:00"); assert.equal(option.endTime, "10:00");
  assert.equal(option.requestNumber, "REQ-2026-123");
  assert.equal(option.polygon, null);
  memory.records("sites").get("site-fixture").polygon = [{ lat: 12.6, lng: 123.9 }, { lat: 12.7, lng: 123.9 }, { lat: 12.7, lng: 124 }];
  assert.deepEqual((await service.listReleasedOptions(staff, { requestId: fixture.requestId })).options[0].polygon, memory.records("sites").get("site-fixture").polygon);
  const request = memory.records("seedlingRequests").get(fixture.requestId); request.workflow = {}; request.organization = "Not a sector";
  const missing = (await service.listReleasedOptions(staff, { requestId: fixture.requestId })).options[0]; assert.equal(missing.participantSector, "");
  memory.records("sites").get("site-fixture").latitude = null;
  assert.equal((await service.listReleasedOptions(staff, { requestId: fixture.requestId })).options[0].latitude, null);
});

function seedTwoSpecies(suffix, narra = 10, molave = 6) {
  const fixture = seed(suffix, "individual", narra + molave);
  memory.records("distributions").get(fixture.requestId).items = [{ inventoryId: "narra", species: "Narra", releasedQuantity: narra }, { inventoryId: "molave", species: "Molave", releasedQuantity: molave }];
  Object.assign(memory.records("events").get(fixture.eventId), { seedlingItems: [{ inventoryId: "narra", species: "Narra", quantity: narra }, { inventoryId: "molave", species: "Molave", quantity: molave }], seedlingTotalQuantity: narra + molave });
  return fixture;
}
test("one Staff report records every released seedling type with per-type planted and leftover quantities", async () => {
  const fixture = seedTwoSpecies("two-species");
  const [option] = (await service.listReleasedOptions(staff, { requestId: fixture.requestId })).options;
  assert.deepEqual(option.items.map(row => [row.inventoryId, row.quantityReleased, row.availableQuantity]), [["narra", 10, 10], ["molave", 6, 6]]);
  const report = await service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "narra", quantityPlanted: 8, leftoverQuantity: 2, leftoverReason: "Seedlings damaged in transport" }, { inventoryId: "molave", quantityPlanted: 6, leftoverQuantity: 0 }] });
  assert.equal(report.officialSubmissionIds.length, 2);
  assert.deepEqual(report.submissions.map(row => [row.inventoryId, row.species, row.quantity, row.leftoverQuantity]), [["narra", "Narra", 8, 2], ["molave", "Molave", 6, 0]]);
  assert.equal(report.species, "Narra, Molave", "a multi-type report is never summarized as one species");
  assert.equal(report.releasedItemQuantity, null); assert.equal(report.quantityReleased, 16);
  assert.equal(report.quantityPlanted, 14); assert.equal(report.declaredLeftoverQuantity, 2); assert.equal(report.reportingProgress, "Fully Reported — Awaiting Review");
  assert.deepEqual(report.allocationSummary.map(row => [row.species, row.allocated, row.recorded, row.leftoverQuantity, row.remaining]), [["Narra", 10, 8, 2, 0], ["Molave", 6, 6, 0, 0]]);
  const event = memory.records("events").get(fixture.eventId);
  assert.deepEqual(event.recordedSeedlingsByInventory, { narra: 8, molave: 6 }); assert.deepEqual(event.leftoverSeedlingsByInventory, { narra: 2, molave: 0 });
  assert.deepEqual(report.submissions.map(row => row.leftoverReason), ["Seedlings damaged in transport", ""]);
  const [narra, molave] = report.officialSubmissionIds; verifiedEvidence(narra);
  const rows = report.officialSubmissionIds.map(id => memory.records("plantingContributions").get(id));
  assert.ok(rows.every(row => row.submissionWorkflowVersion === 4 && row.finalReportGroupId === rows[0].finalReportGroupId && row.finalReportId === `FPR-${fixture.eventId}`));
  // One Admin decision approves the whole final report, leftovers included.
  const approved = await service.reviewOfficialSubmission(admin, narra, true);
  assert.equal(approved.acceptedQuantity, 14); assert.equal(approved.acceptedLeftoverQuantity, 2); assert.equal(approved.reportingProgress, "Completed");
  assert.deepEqual(approved.acceptedSeedlingsByInventory, { narra: 8, molave: 6 });
  assert.deepEqual(approved.submissions.map(row => row.workflowStatus), ["Completed", "Completed"]);
  await assert.rejects(service.reviewOfficialSubmission(admin, molave, true), error => error.status === 409, "the group was already decided");
});
test("legacy partial multi-type reporting records only reported types and keeps the rest available", () => legacyReporting(async () => {
  const fixture = seedTwoSpecies("two-species-partial");
  const report = await service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "narra", quantityPlanted: 10, leftoverQuantity: 0 }] });
  assert.deepEqual(report.submissions.map(row => row.inventoryId), ["narra"]);
  assert.equal(report.reportingProgress, "Partial"); assert.equal(report.remainingAvailableQuantity, 6);
  const [option] = (await service.listReleasedOptions(staff, { requestId: fixture.requestId })).options;
  assert.deepEqual(option.items.map(row => [row.inventoryId, row.availableQuantity]), [["narra", 0], ["molave", 6]]);
  const second = await service.submitOfficialReport(staff, { ...payload(fixture.requestId), expectedVersion: 1, items: [{ inventoryId: "narra", quantityPlanted: 0, leftoverQuantity: 0 }, { inventoryId: "molave", quantityPlanted: 5, leftoverQuantity: 1, leftoverReason: "Seedlings damaged in transport" }] });
  assert.equal(second.officialSubmissionIds.length, 1, "a type with nothing left to report creates no empty submission");
  assert.equal(second.quantityPlanted, 15); assert.equal(second.declaredLeftoverQuantity, 1); assert.equal(second.remainingAvailableQuantity, 0);
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId), expectedVersion: 2, items: [{ inventoryId: "molave", quantityPlanted: 1, leftoverQuantity: 0 }] }), error => error.status === 409);
}));

test("a final Staff report must include every released type with a balance and give a reason for leftovers", async () => {
  const fixture = seedTwoSpecies("final-rules");
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "narra", quantityPlanted: 10, leftoverQuantity: 0 }] }),
    error => error.status === 409 && /every released seedling type/.test(error.message));
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "narra", quantityPlanted: 8, leftoverQuantity: 2 }, { inventoryId: "molave", quantityPlanted: 6, leftoverQuantity: 0 }] }),
    error => error.status === 400 && Boolean(error.fieldErrors?.["leftoverReason-0"]));
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "narra", quantityPlanted: 8, leftoverQuantity: 2, leftoverReason: "x".repeat(501) }, { inventoryId: "molave", quantityPlanted: 6, leftoverQuantity: 0 }] }),
    error => error.status === 400);
  assert.equal(memory.records("events").get(fixture.eventId).recordedSeedlingQuantity || 0, 0, "refused reports change no balance");
});

test("a pending or approved final report blocks a second independent report; a rejection allows a new revision", async () => {
  const fixture = seedTwoSpecies("final-duplicate");
  const items = [{ inventoryId: "narra", quantityPlanted: 10, leftoverQuantity: 0 }, { inventoryId: "molave", quantityPlanted: 5, leftoverQuantity: 1, leftoverReason: "Seedlings damaged in transport" }];
  const first = await service.submitOfficialReport(staff, { ...payload(fixture.requestId), items });
  // Even with a balance somehow available, a second report for the same event is refused while the first is pending.
  await assert.rejects(service.submitOfficialReport(staff, { ...payload(fixture.requestId), expectedVersion: 1, items }), error => error.status === 409);
  await service.reviewOfficialSubmission(admin, first.officialSubmissionIds[1], "reject", "Wrong event recorded");
  const rejected = first.officialSubmissionIds.map(id => memory.records("plantingContributions").get(id));
  assert.deepEqual(rejected.map(row => row.workflowStatus), ["Rejected", "Rejected"], "rejection applies to the whole report");
  assert.deepEqual(memory.records("events").get(fixture.eventId).recordedSeedlingsByInventory, { narra: 0, molave: 0 }, "rejection releases every type");
  const second = await service.submitOfficialReport(staff, { ...payload(fixture.requestId), expectedVersion: 2, items });
  const revision = memory.records("plantingContributions").get(second.officialSubmissionIds[0]);
  assert.equal(revision.finalReportId, rejected[0].finalReportId, "same logical report");
  assert.equal(revision.finalReportRevision, 1);
  assert.deepEqual(second.submissions.filter(row => row.workflowStatus === "Rejected").length, 2, "rejection history is preserved");
});

test("Admin return sends the whole final report back; the Staff correction resubmits every type as the next revision", async () => {
  const fixture = seedTwoSpecies("final-return");
  const first = await service.submitOfficialReport(staff, { ...payload(fixture.requestId), items: [{ inventoryId: "narra", quantityPlanted: 10, leftoverQuantity: 0 }, { inventoryId: "molave", quantityPlanted: 6, leftoverQuantity: 0 }] });
  await service.reviewOfficialSubmission(admin, first.officialSubmissionIds[0], "return", "Molave quantity needs the field sheet");
  assert.deepEqual(first.officialSubmissionIds.map(id => memory.records("plantingContributions").get(id).workflowStatus), ["Returned for Correction", "Returned for Correction"]);
  await assert.rejects(service.submitOfficialReport({ ...staff, uid: "staff-other" }, { ...payload(fixture.requestId), expectedVersion: 2, correctionOf: first.officialSubmissionIds[0],
    items: [{ inventoryId: "narra", quantityPlanted: 10, leftoverQuantity: 0 }, { inventoryId: "molave", quantityPlanted: 6, leftoverQuantity: 0 }] }), error => error.status === 409, "only the original Staff submitter corrects it");
  const corrected = await service.submitOfficialReport(staff, { ...payload(fixture.requestId), expectedVersion: 2, correctionOf: first.officialSubmissionIds[0],
    items: [{ inventoryId: "narra", quantityPlanted: 10, leftoverQuantity: 0 }, { inventoryId: "molave", quantityPlanted: 5, leftoverQuantity: 1, leftoverReason: "Seedlings damaged in transport" }] });
  const old = first.officialSubmissionIds.map(id => memory.records("plantingContributions").get(id));
  const next = corrected.officialSubmissionIds.map(id => memory.records("plantingContributions").get(id));
  assert.ok(old.every(row => row.correctedBySubmission === corrected.officialSubmissionIds[0]));
  assert.deepEqual(next.map(row => [row.inventoryId, row.correctionOf, row.workflowStatus]),
    [["narra", first.officialSubmissionIds[0], "Pending Admin Approval"], ["molave", first.officialSubmissionIds[1], "Pending Admin Approval"]]);
  assert.equal(next[0].finalReportId, old[0].finalReportId); assert.equal(next[0].finalReportRevision, 1);
});
