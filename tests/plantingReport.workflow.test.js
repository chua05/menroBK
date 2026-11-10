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

const STAFF = { uid: "staff-1", name: "Staff Name", role: "staff" };
const ADMIN = { uid: "admin-1", name: "Admin Name", role: "admin" };
const forward = (id, remarks = "Evidence reviewed") => service.forwardPlantingReport(id, STAFF.uid, remarks, STAFF.name, STAFF.role);
const staffReturn = (id, reason) => service.returnPlantingReport(id, STAFF.uid, reason, STAFF.name, STAFF.role);
const adminApprove = (id, remarks = "") => service.approvePlantingReport(id, ADMIN.uid, remarks, ADMIN.name, ADMIN.role);
const adminReject = (id, reason) => service.rejectPlantingReport(id, ADMIN.uid, reason, ADMIN.name, ADMIN.role);

test("Staff forwards or returns; only Admin reaches final decision routes; the intermediate route is gone", async () => {
  assert.equal(routes.stack.some((layer) => layer.route?.path === "/:id/review"), false);
  const forwardRoute = roleHandler("/:id/forward");
  assert.equal((await authorize(forwardRoute, "staff")).allowed, true);
  assert.equal((await authorize(forwardRoute, "admin")).result.code, 403);
  assert.equal((await authorize(forwardRoute, "participant")).result.code, 403);
  const returnRoute = roleHandler("/:id/return");
  assert.equal((await authorize(returnRoute, "staff")).allowed, true);
  assert.equal((await authorize(returnRoute, "admin")).allowed, true);
  assert.equal((await authorize(returnRoute, "participant")).result.code, 403);
  for (const path of ["/:id/approve", "/:id/reject"]) {
    const handler = roleHandler(path);
    assert.equal((await authorize(handler, "admin")).allowed, true);
    assert.equal((await authorize(handler, "staff")).result.code, 403);
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
      eventId, siteId: `site-${eventId}`, distributionId: `distribution-${eventId}`,
      quantityReleased: 150, quantityPlanted: 150, activeSubmittedQuantity: 150,
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

  test("Staff review forwards without completing; Admin approval completes progress without changing verification", async () => {
    process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true";
    seedContributionDecision("submission-accept", "event-accept");
    await assert.rejects(service.approvePlantingReport("submission-accept", STAFF.uid, "Reviewed", STAFF.name, STAFF.role), (error) => error.status === 403);
    await assert.rejects(adminApprove("submission-accept"), /must review and forward/);
    const reviewed = await forward("submission-accept", "Photos match the site");
    const forwarded = table("plantingContributions").get("submission-accept");
    assert.equal(forwarded.workflowStatus, "Reviewed");
    assert.equal(forwarded.staffReviewStatus, "Pending Review", "Staff review keeps the quantity pending");
    assert.equal(forwarded.staffReviewedBy, "staff-1");
    assert.equal(forwarded.staffReviewRemarks, "Photos match the site");
    assert.equal(reviewed.reportingProgress, "Fully Reported — Awaiting Review");
    assert.equal(reviewed.acceptedQuantity, 100);
    assert.equal([...table("verifiedPlantingCohorts").values()].length, 0, "Staff review never activates monitoring");
    assert.ok(table("notifications").get("planting_report_reviewed_event_event-accept_submission-accept_participant-1"));
    await assert.rejects(forward("submission-accept"), /pending Staff review/);
    const report = await adminApprove("submission-accept", "Reviewed");
    const submission = table("plantingContributions").get("submission-accept");
    assert.equal(submission.verificationStatus, "Needs Review");
    assert.equal(submission.staffReviewStatus, "Accepted");
    assert.equal(submission.workflowStatus, "Completed");
    assert.equal(submission.reviewedBy, "admin-1");
    assert.equal(submission.reviewedByName, "Admin Name");
    assert.equal(submission.staffReviewedBy, "staff-1");
    assert.ok(table("notifications").get("planting_report_admin_approved_staff_event_event-accept_submission-accept_staff-1"));
    assert.ok(submission.reviewedAt);
    assert.equal(report.reportingProgress, "Completed");
    assert.equal(report.acceptedQuantity, 150);
    assert.equal(report.pendingReviewQuantity, 0);
    const notification = table("notifications").get(
      "planting_report_accepted_event_event-accept_submission-accept_participant-1",
    );
    assert.equal(notification.recipientUserId, "participant-1");
    assert.equal(notification.relatedRecordId, "event_event-accept");
    assert.equal(notification.relatedSubrecordId, "submission-accept");
    const cohorts = [...table("verifiedPlantingCohorts").values()];
    assert.equal(cohorts.length, 1);
    assert.equal(cohorts[0].source.plantingReportId, "event_event-accept");
    assert.equal(cohorts[0].source.siteId, "site-event-accept");
    assert.equal(cohorts[0].source.distributionId, "distribution-event-accept");
    assert.equal(cohorts[0].verifiedPlantedQuantity, 150);
    delete process.env.VERIFIED_PLANTING_COHORT_ENABLED;
  });

  test("multiple contributors to one report receive distinct idempotent notifications", async () => {
    const reportId = seedContributionDecision("submission-a", "event-shared");
    table("plantingContributions").set("submission-b", {
      id: "submission-b", reportId, eventId: "event-shared",
      participantId: "participant-3", contributorId: "participant-3",
      contributorName: "Participant Three", inventoryId: "narra", quantity: 50,
      verificationStatus: "Needs Review", staffReviewStatus: "Pending Review",
      photos: [{ photoPath: "planting-reports/test/review-b.jpg" }],
    });
    table("plantingReports").set(reportId, {
      ...table("plantingReports").get(reportId),
      quantityReleased: 200, quantityPlanted: 200, activeSubmittedQuantity: 200,
      acceptedQuantity: 100, pendingReviewQuantity: 100,
    });
    table("events").set("event-shared", {
      ...table("events").get("event-shared"),
      seedlingTotalQuantity: 200, recordedSeedlingQuantity: 200,
      recordedSeedlingsByInventory: { narra: 200 },
      seedlingItems: [{ inventoryId: "narra", quantity: 200, species: "Narra" }],
    });

    await forward("submission-a");
    await forward("submission-b");
    await adminApprove("submission-a");
    await adminApprove("submission-b");

    const firstId = "planting_report_accepted_event_event-shared_submission-a_participant-1";
    const secondId = "planting_report_accepted_event_event-shared_submission-b_participant-3";
    assert.equal(table("notifications").get(firstId).recipientUserId, "participant-1");
    assert.equal(table("notifications").get(secondId).recipientUserId, "participant-3");
    assert.notEqual(firstId, secondId);
    await assert.rejects(
      adminApprove("submission-a"),
      /Only planting reports reviewed by MENRO Staff/,
    );
    assert.equal([...table("notifications")].filter(([id]) => id === firstId).length, 1);
  });

  test("Admin rejecting a reviewed contribution records reason, is final and reopens quantity", async () => {
    const reportId = seedContributionDecision("submission-reject", "event-reject");
    await assert.rejects(service.rejectPlantingReport("submission-reject", STAFF.uid, "Reason", STAFF.name, STAFF.role), (error) => error.status === 403);
    await forward("submission-reject");
    const report = await adminReject("submission-reject", "Evidence does not show this site");
    const submission = table("plantingContributions").get("submission-reject");
    assert.equal(submission.verificationStatus, "Needs Review");
    assert.equal(submission.staffReviewStatus, "Rejected");
    assert.equal(submission.workflowStatus, "Rejected");
    assert.equal(submission.rejectionReason, "Evidence does not show this site");
    assert.equal(submission.reviewedBy, "admin-1");
    assert.equal(submission.reviewedByName, "Admin Name");
    assert.equal(report.submissions.find((entry) => entry.id === "submission-reject").correctionAllowed, false);
    assert.equal(report.reportingProgress, "Partial");
    assert.equal(report.activeSubmittedQuantity, 100);
    assert.equal(report.remainingAvailableQuantity, 50);
    assert.equal(table("plantingReports").get(reportId).rejectedQuantity, 50);
    assert.equal(table("events").get("event-reject").recordedSeedlingQuantity, 100);
    assert.equal(table("events").get("event-reject").remainingSeedlingQuantity, 50);
    const notification = table("notifications").get(
      "planting_report_rejected_event_event-reject_submission-reject_participant-1",
    );
    assert.equal(notification.recipientUserId, "participant-1");
    assert.equal(notification.relatedSubrecordId, "submission-reject");
  });

test("Admin approval after Staff review is final and preserves automated findings", async () => {
  seed("approve-1");
  await assert.rejects(service.approvePlantingReport("approve-1", STAFF.uid, "", STAFF.name, STAFF.role), (error) => error.status === 403);
  await assert.rejects(adminApprove("approve-1"), /must review and forward/);
  const reviewed = await forward("approve-1");
  assert.equal(reviewed.workflowStatus, "Reviewed");
  assert.equal(table("plantingReports").get("approve-1").verificationStatus, "Pending Review");
  const report = await adminApprove("approve-1");
  assert.equal(report.verificationStatus, "Needs Review");
  assert.equal(report.staffReviewStatus, "Accepted");
  assert.equal(report.workflowStatus, "Completed");
  assert.equal(report.reviewedBy, "admin-1");
  assert.equal(report.reviewedByName, "Admin Name");
  assert.equal(report.staffReviewedBy, "staff-1");
  assert.ok(report.reviewedAt?.toDate?.());
  assert.equal(report.automatedVerificationStatus, "Flagged");
  assert.deepEqual(report.suspiciousFlags, ["GPS_MISMATCH"]);
  await assert.rejects(adminReject("approve-1", "Reason"), /Only planting reports reviewed by MENRO Staff/);
  await assert.rejects(adminApprove("approve-1"), /Only planting reports reviewed by MENRO Staff/);
  await assert.rejects(forward("approve-1"), /pending Staff review/);
});

test("an available but unsubmitted Pending report cannot be reviewed or decided", async () => {
  seed("unsubmitted", "Pending");
  await assert.rejects(forward("unsubmitted"), /pending Staff review/);
  await assert.rejects(staffReturn("unsubmitted", "Evidence missing"), /pending Staff review/);
  await assert.rejects(adminApprove("unsubmitted"), /Only planting reports reviewed by MENRO Staff/);
  await assert.rejects(adminReject("unsubmitted", "Evidence missing"), /Only planting reports reviewed by MENRO Staff/);
  assert.equal(table("plantingReports").get("unsubmitted").verificationStatus, "Pending");
});

test("Admin rejection requires a reason, persists the reviewer and is final", async () => {
  seed("reject-1");
  await forward("reject-1");
  await assert.rejects(adminReject("reject-1", "  "), /rejection reason is required/i);
  assert.equal(table("plantingReports").get("reject-1").verificationStatus, "Pending Review");
  const report = await adminReject("reject-1", "  Evidence mismatch  ");
  assert.equal(report.verificationStatus, "Needs Review");
  assert.equal(report.staffReviewStatus, "Rejected");
  assert.equal(report.workflowStatus, "Rejected");
  assert.equal(report.correctionAllowed, false);
  assert.equal(report.rejectionRemarks, "Evidence mismatch");
  assert.equal(report.reviewedBy, "admin-1");
  assert.ok(report.reviewedAt?.toDate?.());
  await assert.rejects(adminApprove("reject-1"), /Only planting reports reviewed by MENRO Staff/);
});

test("Staff returns a standalone report for correction with a required reason", async () => {
  seed("return-1");
  await assert.rejects(staffReturn("return-1", "  "), (error) => error.status === 400);
  await assert.rejects(service.returnPlantingReport("return-1", ADMIN.uid, "Fix photos", ADMIN.name, ADMIN.role), (error) => error.status === 403);
  const report = await staffReturn("return-1", " Retake the photos at the site ");
  assert.equal(report.workflowStatus, "Returned for Correction");
  assert.equal(report.correctionAllowed, true);
  assert.equal(report.returnReason, "Retake the photos at the site");
  assert.equal(table("notifications").get("planting_report_returned_return-1_participant-1").type, "planting_report_returned");
  await assert.rejects(forward("return-1"), /pending Staff review/);
  await assert.rejects(adminApprove("return-1"), /Only planting reports reviewed by MENRO Staff/);
});

test("legacy Flagged records read as Needs Review without mutating historical data", async () => {
  seed("legacy-1", "Flagged");
  table("plantingReports").get("legacy-1").automatedVerificationStatus = undefined;
  const report = await service.getPlantingReportById("legacy-1");
  assert.equal(report.verificationStatus, "Needs Review");
  assert.equal(report.automatedVerificationStatus, "Flagged");
  assert.equal(table("plantingReports").get("legacy-1").verificationStatus, "Flagged");
});

test("legacy Reviewed reports follow Staff review then Admin approval", async () => {
  seed("legacy-reviewed", "Reviewed");
  const pending = await service.getPlantingReportById("legacy-reviewed");
  assert.equal(pending.verificationStatus, "Needs Review");
  assert.equal(pending.workflowStatus, "Pending Review", "legacy pending records enter the new Staff stage");
  await forward("legacy-reviewed");
  const approved = await adminApprove("legacy-reviewed");
  assert.equal(approved.verificationStatus, "Needs Review");
  assert.equal(approved.staffReviewStatus, "Accepted");
  assert.equal(approved.automatedVerificationStatus, "Flagged");
  assert.equal(table("plantingReports").get("legacy-reviewed").verificationStatus, "Approved");
});

test("early monitoring assignment goes to Staff/Admin while planting approval remains requester-facing", async () => {
  const previousActivation = process.env.EARLY_MONITORING_ACTIVATION_AT;
  process.env.EARLY_MONITORING_ACTIVATION_AT = "2020-01-01T00:00:00.000Z";
  try {
    const { dateOnlyInManila, shiftCalendarDate } = require("../src/utils/earlyMonitoring.util");
    const reportId = "early-assignment-role-test";
    const now = new Date();
    const today = dateOnlyInManila(now);
    table("plantingReports").set(reportId, {
      participantId: "participant-1", verificationStatus: "Pending Review",
      createdAt: now, plantingDate: today, siteId: "assignment-test-site",
    });
    table("users").set("assignment-test-staff", { role: "staff", status: "active" });
    table("users").set("assignment-test-admin", { role: "admin", status: "active" });
    table("users").set("participant-1", { role: "participant", status: "active" });

    await forward(reportId);
    assert.equal(table("plantingReports").get(reportId).earlyMonitoring, undefined, "Staff review does not schedule monitoring");
    const approved = await adminApprove(reportId, "Verified");
    assert.equal(approved.earlyMonitoring.officialOpeningDate, shiftCalendarDate(today, 14));
    assert.equal(approved.earlyMonitoring.applicable, true);
    assert.equal(table("notifications").get(`planting_report_approved_${reportId}_participant-1`).recipientUserId,
      "participant-1", "planting approval status stays requester-facing");
    const taskNotices = [...table("notifications").values()].filter(item =>
      item.relatedRecordId === reportId && item.type === "early_monitoring_scheduled");
    assert.deepEqual(new Set(taskNotices.map(item => item.recipientUserId)),
      new Set(["assignment-test-staff", "assignment-test-admin"]));
    assert.equal(taskNotices.some(item => item.recipientUserId === "participant-1"), false);
  } finally {
    if (previousActivation === undefined) delete process.env.EARLY_MONITORING_ACTIVATION_AT;
    else process.env.EARLY_MONITORING_ACTIVATION_AT = previousActivation;
  }
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

test("decision controllers refuse a missing Return or Reject reason before calling the service", async () => {
  for (const [handler, message] of [[controller.returnReport, /returning/], [controller.rejectReport, /rejecting/]]) {
    let status, body;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    await handler({ params: { id: "missing-reason" }, body: { remarks: "   " }, user: { uid: "admin-1", role: "admin", fullName: "Admin" } }, res);
    assert.equal(status, 400);
    assert.match(body.message, message);
    assert.ok(body.fieldErrors.remarks);
  }
  let status;
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  await controller.forwardReport({ params: { id: "missing-report" }, body: {}, user: { uid: "admin-1", role: "admin" } }, res);
  assert.equal(status, 403, "Admin cannot perform the Staff review step");
});
