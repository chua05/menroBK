const assert = require("node:assert/strict");
const test = require("node:test");

const collections = new Map();
let generatedId = 0;

function table(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

function reference(name, id) {
  return {
    id,
    collectionName: name,
    async get() {
      const value = table(name).get(id);
      return { id, exists: value !== undefined, data: () => value };
    },
  };
}

const db = {
  collection(name) {
    return {
      doc(id = `generated-${++generatedId}`) { return reference(name, id); },
      async get() {
        return { docs: [...table(name)].map(([id, value]) => ({ id, data: () => value })) };
      },
      where(field, operator, value) {
        assert.equal(operator, "==");
        return {
          async get() {
            return {
              docs: [...table(name)].filter(([, item]) => item[field] === value)
                .map(([id, item]) => ({ id, data: () => item })),
            };
          },
        };
      },
    };
  },
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: (ref) => ref.get(),
      update(ref, value) { writes.push(["update", ref, value]); },
      set(ref, value) { writes.push(["set", ref, value]); },
      create(ref, value) { writes.push(["create", ref, value]); },
    };
    await callback(transaction);
    for (const [operation, ref, value] of writes) {
      const target = table(ref === undefined ? "" : ref.collectionName || "plantingReports");
      if (operation === "set" || operation === "create") table(ref.collectionName).set(ref.id, value);
      else target.set(ref.id, { ...target.get(ref.id), ...value });
    }
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { db },
};

const service = require("../src/services/plantingReport.service");
const { summarizeSubmissions } = require("../src/services/parentPlantingReport.service");
const routes = require("../src/routes/plantingReport.routes");
const controller = require("../src/controller/plantingReport.controller");
const inventoryRoutes = require("../src/routes/inventory.routes");
const eventRoutes = require("../src/routes/event.routes");
const guestRoutes = require("../src/routes/guestEvent.routes");

function seed(id, status = "Pending Review") {
  table("plantingReports").set(id, {
    participantId: "participant-1",
    verificationStatus: status,
    automatedVerificationStatus: "Flagged",
    suspiciousFlags: ["GPS_MISMATCH"],
    photos: [{ gpsValid: false, suspiciousFlags: ["GPS_MISMATCH"] }],
  });
}

function roleHandler(path) {
  const route = routes.stack.find((layer) => layer.route?.path === path && layer.route.methods.patch);
  assert.ok(route, `${path} route exists`);
  return route.route.stack[1].handle;
}

async function authorize(handler, role) {
  let result;
  let allowed = false;
  const res = {
    status(code) { result = { code }; return this; },
    json(body) { result.body = body; return this; },
  };
  handler({ user: { uid: `${role}-1`, role } }, res, () => { allowed = true; });
  return { allowed, result };
}

test("only Staff and Admin can reach final decision routes; the intermediate route is gone", async () => {
  assert.equal(routes.stack.some((layer) => layer.route?.path === "/:id/review"), false);
  for (const path of ["/:id/approve", "/:id/reject"]) {
    const handler = roleHandler(path);
    assert.equal((await authorize(handler, "staff")).allowed, true);
    assert.equal((await authorize(handler, "admin")).allowed, true);
    assert.equal((await authorize(handler, "participant")).result.code, 403);
  }
});

  test("parent progress keeps Verification, Staff Review, and quantity totals separate", () => {
    const awaiting = summarizeSubmissions([], 150);
    assert.equal(awaiting.reportingProgress, "Awaiting Submission");
    assert.equal(awaiting.remainingAvailableQuantity, 150);

    const verified = summarizeSubmissions([
      { quantity: 50, verificationStatus: "Verified", staffReviewStatus: "Not Required" },
    ], 150);
    assert.equal(verified.reportingProgress, "Partial");
    assert.equal(verified.activeSubmittedQuantity, 50);
    assert.equal(verified.acceptedQuantity, 50);
    assert.equal(verified.remainingAvailableQuantity, 100);

    const newVerifiedPending = summarizeSubmissions([
      { quantity: 50, verificationStatus: "Verified", staffReviewStatus: "Pending Review",
        staffApprovalRequired: true },
    ], 150);
    assert.equal(newVerifiedPending.acceptedQuantity, 0);
    assert.equal(newVerifiedPending.pendingReviewQuantity, 50);
    assert.equal(newVerifiedPending.reportingProgress, "Partial");

    const legacyVerified = summarizeSubmissions([
      { quantity: 50, automatedVerificationStatus: "Passed Automated Check" },
    ], 150);
    assert.equal(legacyVerified.submissions[0].verificationStatus, "Verified");
    assert.equal(legacyVerified.submissions[0].staffReviewStatus, "Not Required");

    const pending = summarizeSubmissions([
      { quantity: 50, verificationStatus: "Needs Review", staffReviewStatus: "Pending Review" },
    ], 150);
    assert.equal(pending.reportingProgress, "Partial");
    assert.equal(pending.pendingReviewQuantity, 50);
    assert.equal(pending.remainingAvailableQuantity, 100);

    const completeAwaitingReview = summarizeSubmissions([
      { quantity: 100, verificationStatus: "Verified", staffReviewStatus: "Not Required" },
      { quantity: 50, verificationStatus: "Needs Review", staffReviewStatus: "Pending Review" },
    ], 150);
    assert.equal(completeAwaitingReview.reportingProgress, "Fully Reported — Awaiting Review");

    const accepted = summarizeSubmissions([
      { quantity: 100, verificationStatus: "Verified", staffReviewStatus: "Not Required" },
      { quantity: 50, verificationStatus: "Needs Review", staffReviewStatus: "Accepted" },
    ], 150);
    assert.equal(accepted.reportingProgress, "Completed");
    assert.equal(accepted.submissions[1].verificationStatus, "Needs Review");
    assert.equal(accepted.submissions[1].staffReviewStatus, "Accepted");

    const rejected = summarizeSubmissions([
      { quantity: 100, verificationStatus: "Verified", staffReviewStatus: "Not Required" },
      { quantity: 50, verificationStatus: "Needs Review", staffReviewStatus: "Rejected" },
    ], 150);
    assert.equal(rejected.reportingProgress, "Partial");
    assert.equal(rejected.activeSubmittedQuantity, 100);
    assert.equal(rejected.rejectedQuantity, 50);
    assert.equal(rejected.remainingAvailableQuantity, 50);
  });

  function seedContributionDecision(submissionId, eventId) {
    const reportId = `event_${eventId}`;
    table("plantingReports").set(reportId, {
      reportType: "parent", reportNumber: "RPT-2026-100", requestId: `request-${eventId}`,
      eventId, quantityReleased: 150, quantityPlanted: 150, activeSubmittedQuantity: 150,
      acceptedQuantity: 100, pendingReviewQuantity: 50, rejectedQuantity: 0,
      remainingAvailableQuantity: 0, reportingProgress: "Fully Reported — Awaiting Review",
      verificationStatus: "Fully Reported — Awaiting Review", createdAt: new Date(),
    });
    table("events").set(eventId, {
      seedlingTotalQuantity: 150, recordedSeedlingQuantity: 150,
      remainingSeedlingQuantity: 0, recordedSeedlingsByInventory: { narra: 150 },
      seedlingItems: [{ inventoryId: "narra", quantity: 150, species: "Narra" }],
    });
    table("plantingContributions").set(submissionId, {
      id: submissionId, reportId, eventId, participantId: "participant-1", contributorId: "participant-1",
      contributorName: "Participant One", inventoryId: "narra", quantity: 50,
      verificationStatus: "Needs Review", staffReviewStatus: "Pending Review",
      photos: [{ photoPath: "planting-reports/test/review.jpg" }], suspiciousFlags: ["OUTSIDE_REGISTERED_SITE"],
    });
    table("plantingContributions").set(`${submissionId}-verified`, {
      id: `${submissionId}-verified`, reportId, eventId, participantId: "participant-2", contributorId: "participant-2",
      contributorName: "Participant Two", inventoryId: "narra", quantity: 100,
      verificationStatus: "Verified", staffReviewStatus: "Not Required",
      photos: [{ photoPath: "planting-reports/test/verified.jpg" }],
    });
    return reportId;
  }

  test("accepting a contribution completes progress without changing verification", async () => {
    seedContributionDecision("submission-accept", "event-accept");
    const report = await service.approvePlantingReport("submission-accept", "staff-1", "Reviewed", "Staff Name");
    const submission = table("plantingContributions").get("submission-accept");
    assert.equal(submission.verificationStatus, "Needs Review");
    assert.equal(submission.staffReviewStatus, "Accepted");
    assert.equal(submission.reviewedBy, "staff-1");
    assert.equal(submission.reviewedByName, "Staff Name");
    assert.ok(submission.reviewedAt);
    assert.equal(report.reportingProgress, "Completed");
    assert.equal(report.acceptedQuantity, 150);
    assert.equal(report.pendingReviewQuantity, 0);
  });

  test("rejecting a contribution records reason and reopens quantity", async () => {
    const reportId = seedContributionDecision("submission-reject", "event-reject");
    const report = await service.rejectPlantingReport("submission-reject", "staff-1", "Evidence does not show this site", "Staff Name");
    const submission = table("plantingContributions").get("submission-reject");
    assert.equal(submission.verificationStatus, "Needs Review");
    assert.equal(submission.staffReviewStatus, "Rejected");
    assert.equal(submission.rejectionReason, "Evidence does not show this site");
    assert.equal(submission.reviewedBy, "staff-1");
    assert.equal(submission.reviewedByName, "Staff Name");
    assert.equal(report.reportingProgress, "Partial");
    assert.equal(report.activeSubmittedQuantity, 100);
    assert.equal(report.remainingAvailableQuantity, 50);
    assert.equal(table("plantingReports").get(reportId).rejectedQuantity, 50);
    assert.equal(table("events").get("event-reject").recordedSeedlingQuantity, 100);
    assert.equal(table("events").get("event-reject").remainingSeedlingQuantity, 50);
  });

test("Staff approval is final and preserves automated findings", async () => {
  seed("approve-1");
  const report = await service.approvePlantingReport("approve-1", "staff-1", "", "Staff Name");
  assert.equal(report.verificationStatus, "Needs Review");
  assert.equal(report.staffReviewStatus, "Accepted");
  assert.equal(report.reviewedBy, "staff-1");
  assert.equal(report.reviewedByName, "Staff Name");
  assert.ok(report.reviewedAt?.toDate?.());
  assert.equal(report.automatedVerificationStatus, "Flagged");
  assert.deepEqual(report.suspiciousFlags, ["GPS_MISMATCH"]);
  await assert.rejects(service.rejectPlantingReport("approve-1", "staff-2", "Reason"), /Only pending review/);
  await assert.rejects(service.approvePlantingReport("approve-1", "staff-2", ""), /Only pending review/);
});

test("Staff cannot decide an available but unsubmitted Pending report", async () => {
  seed("unsubmitted", "Pending");
  await assert.rejects(service.approvePlantingReport("unsubmitted", "staff-1", ""), /Only pending review/);
  await assert.rejects(service.rejectPlantingReport("unsubmitted", "staff-1", "Evidence missing"), /Only pending review/);
  assert.equal(table("plantingReports").get("unsubmitted").verificationStatus, "Pending");
});

test("rejection requires a reason and persists the authenticated reviewer", async () => {
  seed("reject-1");
  await assert.rejects(service.rejectPlantingReport("reject-1", "staff-1", "  "), /Rejection reason is required/);
  assert.equal(table("plantingReports").get("reject-1").verificationStatus, "Pending Review");
  const report = await service.rejectPlantingReport("reject-1", "staff-1", "  Evidence mismatch  ", "Staff Name");
  assert.equal(report.verificationStatus, "Needs Review");
  assert.equal(report.staffReviewStatus, "Rejected");
  assert.equal(report.rejectionRemarks, "Evidence mismatch");
  assert.equal(report.reviewedBy, "staff-1");
  assert.ok(report.reviewedAt?.toDate?.());
  await assert.rejects(service.approvePlantingReport("reject-1", "staff-2", ""), /Only pending review/);
});

test("legacy Flagged records read as Needs Review without mutating historical data", async () => {
  seed("legacy-1", "Flagged");
  table("plantingReports").get("legacy-1").automatedVerificationStatus = undefined;
  const report = await service.getPlantingReportById("legacy-1");
  assert.equal(report.verificationStatus, "Needs Review");
  assert.equal(report.automatedVerificationStatus, "Flagged");
  assert.equal(table("plantingReports").get("legacy-1").verificationStatus, "Flagged");
});

test("legacy Reviewed reports can receive the final Staff decision", async () => {
  seed("legacy-reviewed", "Reviewed");
  const pending = await service.getPlantingReportById("legacy-reviewed");
  assert.equal(pending.verificationStatus, "Needs Review");
  const approved = await service.approvePlantingReport("legacy-reviewed", "staff-1", "", "Staff Name");
  assert.equal(approved.verificationStatus, "Needs Review");
  assert.equal(approved.staffReviewStatus, "Accepted");
  assert.equal(approved.automatedVerificationStatus, "Flagged");
  assert.equal(table("plantingReports").get("legacy-reviewed").verificationStatus, "Approved");
});

test("participants cannot open records outside their authorized scope", async () => {
  seed("owned-1");
  async function readAs(uid) {
    let result;
    const res = {
      status(code) { result = { code }; return this; },
      json(body) { result.body = body; return this; },
    };
    await controller.getPlantingReport({ params: { id: "owned-1" }, user: { uid, role: "participant" } }, res);
    return result;
  }
  assert.equal((await readAs("participant-1")).code, 200);
  assert.equal((await readAs("participant-out-of-scope")).code, 404);
});

test("specific inventory archived route precedes item ID route", () => {
  const paths = inventoryRoutes.stack.filter((layer) => layer.route?.methods.get)
    .map((layer) => layer.route.path);
  assert.ok(paths.indexOf("/archived") < paths.indexOf("/:id"));
});

test("Staff and Admin can read event participants; guests have no decision route", async () => {
  const route = eventRoutes.stack.find((layer) =>
    layer.route?.path === "/:id/participants" && layer.route.methods.get);
  assert.ok(route);
  const roleGuard = route.route.stack[1].handle;
  assert.equal((await authorize(roleGuard, "staff")).allowed, true);
  assert.equal((await authorize(roleGuard, "admin")).allowed, true);
  assert.equal((await authorize(roleGuard, "participant")).result.code, 403);
  assert.equal(guestRoutes.stack.some((layer) =>
    /approve|reject/.test(layer.route?.path || "")), false);
});

test("events do not expose a cancellation endpoint", () => {
  assert.equal(eventRoutes.stack.some((layer) =>
    layer.route?.path === "/:id/cancel"), false);
});
