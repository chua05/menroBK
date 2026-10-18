const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const records = new Map();
function table(name) {
  if (!records.has(name)) records.set(name, new Map());
  return records.get(name);
}
function reference(name, id) {
  return {
    name, id,
    async get() {
      const value = table(name).get(id);
      return { id, exists: value !== undefined, data: () => value };
    },
    async update(value) { table(name).set(id, { ...table(name).get(id), ...value }); },
  };
}
let queue = Promise.resolve();
const db = {
  collection(name) {
    return {
      doc(id) { return reference(name, id); },
      async get() { return { docs: [...table(name)].map(([id, value]) => ({ id, data: () => value })) }; },
      where(field, operator, value) {
        assert.equal(operator, "==");
        return {
          async get() {
            return { docs: [...table(name)]
              .filter(([, item]) => item[field] === value)
              .map(([id, item]) => ({ id, data: () => item })) };
          },
        };
      },
    };
  },
  runTransaction(callback) {
    const execute = async () => {
      const writes = [];
      const transaction = {
        get: (ref) => ref.get(),
        update: (ref, value) => writes.push(["update", ref, value]),
        create: (ref, value) => writes.push(["create", ref, value]),
      };
      const result = await callback(transaction);
      for (const [operation, ref, value] of writes) {
        if (operation === "create" && table(ref.name).has(ref.id)) throw new Error("Already exists");
        table(ref.name).set(ref.id, operation === "update" ? { ...table(ref.name).get(ref.id), ...value } : value);
      }
      return result;
    };
    const result = queue.then(execute, execute);
    queue = result.catch(() => undefined);
    return result;
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const service = require("../src/services/monitoring.service");

function observation(overrides = {}) {
  return {
    id: "OBS-1", workflowVersion: 2, originalReporterId: "participant-1",
    plantingReportId: "report-1", siteId: "site-1", reviewStatus: "Pending Review",
    reviewVersion: 0, revisionNumber: 1, monitoredDate: "2026-09-01",
    totalMonitored: 10, healthyCount: 8, damagedCount: 1, deadCount: 1,
    cohortQuantityAtObservation: 10, photoUrl: "/uploads/monitoring/participant-1/photo.jpg",
    revisionHistory: [{ revisionNumber: 1, evidenceRevision: 1,
      evidenceRef: { photoUrl: "/uploads/monitoring/participant-1/photo.jpg", imageHash: "hash-1",
        latitude: 12.57, longitude: 123.965 } }], auditHistory: [], ...overrides,
  };
}
function seed(entry = observation()) {
  table("notifications").clear();
  table("users").set("staff-notify", { role: "staff", status: "active" });
  table("users").set("admin-notify", { role: "admin", status: "active" });
  table("monitoringRecords").set("monitor-1", {
    participantId: "participant-1", plantingReportId: "report-1", siteId: "site-1",
    startMonitoringDate: "2026-01-01", monitoringEndDate: "2028-01-01",
    quantityPlanted: 10, history: [entry],
  });
}

test("Staff review and Admin approval are observation-specific and versioned", async () => {
  seed();
  await service.reviewMonitoringObservation({ monitoringId: "monitor-1", observationId: "OBS-1",
    expectedVersion: 0, actorId: "staff-1", actorRole: "staff" });
  let stored = table("monitoringRecords").get("monitor-1").history[0];
  assert.equal(stored.reviewStatus, "Reviewed");
  assert.equal(stored.reviewVersion, 1);
  assert.equal(stored.staffReviewedBy, "staff-1");
  assert.equal(table("monitoringRecords").get("monitor-1").nextMonitoringDate, null);
  assert.equal(
    table("notifications").get("monitoring_reviewed_admin_monitor-1_OBS-1_1_admin-notify").recipientUserId,
    "admin-notify",
  );
  await assert.rejects(service.approveMonitoringObservation({ monitoringId: "monitor-1",
    observationId: "OBS-1", expectedVersion: 0, actorId: "admin-1", actorRole: "admin" }),
  (error) => error.code === "STALE_OBSERVATION_VERSION");
  await service.approveMonitoringObservation({ monitoringId: "monitor-1", observationId: "OBS-1",
    expectedVersion: 1, actorId: "admin-1", actorRole: "admin" });
  stored = table("monitoringRecords").get("monitor-1").history[0];
  assert.equal(stored.reviewStatus, "Approved");
  assert.equal(stored.adminDecision, "Approve");
  assert.equal(
    table("notifications").get("monitoring_approved_monitor-1_OBS-1_2_participant-1").recipientUserId,
    "participant-1",
  );
  assert.equal(table("monitoringRecords").get("monitor-1").nextMonitoringDate, "2026-10-06");
  await assert.rejects(service.rejectMonitoringObservation({ monitoringId: "monitor-1",
    observationId: "OBS-1", expectedVersion: 2, actorId: "admin-2", actorRole: "admin", reason: "No" }),
  (error) => error.code === "INVALID_STATUS_TRANSITION");
});

test("Admin rejection clears a stale pending schedule and permits a new observation", async () => {
  seed(observation({ reviewStatus: "Reviewed", reviewVersion: 1,
    staffReviewedBy: "staff-1", staffReviewedAt: { seconds: 1 } }));
  table("monitoringRecords").get("monitor-1").nextMonitoringDate = "2026-10-06";
  await assert.rejects(service.rejectMonitoringObservation({ monitoringId: "monitor-1",
    observationId: "OBS-1", expectedVersion: 1, actorId: "admin-1", actorRole: "admin", reason: "  " }),
  /Rejection reason is required/);
  await service.rejectMonitoringObservation({ monitoringId: "monitor-1", observationId: "OBS-1",
    expectedVersion: 1, actorId: "admin-1", actorRole: "admin", reason: "Evidence is inconclusive" });
  const lifecycle = table("monitoringRecords").get("monitor-1");
  assert.equal(lifecycle.nextMonitoringDate, null);
  assert.equal(service.hasOutstandingObservation(lifecycle.history), false);
  assert.equal(
    table("notifications").get("monitoring_rejected_monitor-1_OBS-1_2_participant-1").reason,
    "Evidence is inconclusive",
  );
});

test("an approved partial observation does not advance the official schedule", async () => {
  seed(observation({ reviewStatus: "Reviewed", reviewVersion: 1, totalMonitored: 4,
    healthyCount: 3, damagedCount: 1, deadCount: 0, isFullCohortAssessment: false,
    staffReviewedBy: "staff-1", staffReviewedAt: { seconds: 1 } }));
  await service.approveMonitoringObservation({ monitoringId: "monitor-1", observationId: "OBS-1",
    expectedVersion: 1, actorId: "admin-1", actorRole: "admin" });
  assert.equal(table("monitoringRecords").get("monitor-1").nextMonitoringDate, null);
  assert.equal(
    table("notifications").get("monitoring_approved_monitor-1_OBS-1_2_participant-1").recipientUserId,
    "participant-1",
  );
});

test("returned observations notify the actual reporter rather than the planting owner", async () => {
  seed(observation({ originalReporterId: "field-reporter", monitoredBy: "field-reporter" }));
  await service.returnMonitoringObservation({ monitoringId: "monitor-1", observationId: "OBS-1",
    expectedVersion: 0, actorId: "staff-1", actorRole: "staff", reason: "Recheck the field count" });
  const notification = table("notifications").get(
    "monitoring_returned_monitor-1_OBS-1_1_field-reporter",
  );
  assert.equal(notification.recipientUserId, "field-reporter");
  assert.equal(notification.relatedSubrecordId, "OBS-1");
  assert.equal(notification.reason, "Recheck the field count");
});

test("Staff return requires a reason and only the original reporter can resubmit", async () => {
  seed();
  await assert.rejects(service.returnMonitoringObservation({ monitoringId: "monitor-1",
    observationId: "OBS-1", expectedVersion: 0, actorId: "staff-1", actorRole: "staff", reason: "  " }),
  /Return reason is required/);
  await service.returnMonitoringObservation({ monitoringId: "monitor-1", observationId: "OBS-1",
    expectedVersion: 0, actorId: "staff-1", actorRole: "staff", reason: "Recheck counts" });
  table("plantingReports").set("report-1", { participantId: "participant-1", siteId: "site-1", quantityPlanted: 10 });
  table("sites").set("site-1", { latitude: 12.57, longitude: 123.965 });
  const payload = { monitoringId: "monitor-1", observationId: "OBS-1", expectedVersion: 1,
    retainEvidenceRevision: 1, totalMonitored: 10, healthyCount: 7, damagedCount: 2,
    deadCount: 1, monitoredDate: "2026-09-02", maturityStatus: "Immature", remarks: "Corrected" };
  await assert.rejects(service.resubmitMonitoringObservation({ ...payload, actorId: "participant-2" }),
    (error) => error.code === "MONITORING_ACTION_FORBIDDEN");
  await service.resubmitMonitoringObservation({ ...payload, actorId: "participant-1" });
  const stored = table("monitoringRecords").get("monitor-1").history[0];
  assert.equal(stored.id, "OBS-1");
  assert.equal(stored.reviewStatus, "Pending Review");
  assert.equal(stored.reviewVersion, 2);
  assert.equal(stored.revisionNumber, 2);
  assert.equal(stored.revisionHistory.length, 2);
  assert.equal(stored.revisionHistory[1].reusedEvidence, true);
  assert.equal(
    table("notifications").get("monitoring_resubmitted_staff_monitor-1_OBS-1_2_staff-notify").recipientUserId,
    "staff-notify",
  );
});

test("a different authenticated reporter can submit a partial observation without changing cohort ownership", async () => {
  const ownerId = "planting-owner";
  const reporterId = "field-reporter-2";
  const uploadDirectory = path.join(process.cwd(), "uploads", "monitoring", reporterId);
  table("plantingReports").set("shared-report", {
    participantId: ownerId, eventId: "event-shared", siteId: "shared-site",
    quantityPlanted: 10, plantingDate: "2026-09-01", verificationStatus: "Approved",
  });
  table("sites").set("shared-site", { latitude: 12.57, longitude: 123.965 });
  try {
    const result = await service.createMonitoringRecord({
      plantingReportId: "shared-report", requesterRole: "participant", monitoredBy: reporterId,
      totalMonitored: 4, healthyCount: 3, damagedCount: 1, deadCount: 0,
      monitoredDate: "2026-10-10", maturityStatus: "Immature", remarks: "Partial field check",
      metadata: { latitude: 12.57, longitude: 123.965, capturedAt: "2026-10-10T08:00:00+08:00" },
      imageHash: "different-reporter-hash", imageDetails: { format: "jpeg" },
      file: { originalname: "field.jpg", mimetype: "image/jpeg", size: 5, buffer: Buffer.from("field") },
    });
    const entry = result.history.at(-1);
    assert.equal(result.participantId, ownerId);
    assert.equal(entry.originalReporterId, reporterId);
    assert.equal(entry.isFullCohortAssessment, false);
    assert.equal(table("notifications").get(
      `monitoring_submitted_${result.id}_${entry.id}_${reporterId}`,
    ).recipientUserId, reporterId);
  } finally {
    await fs.rm(uploadDirectory, { recursive: true, force: true });
  }
});

test("concurrent final decisions allow only one transaction result", async () => {
  seed(observation({ reviewStatus: "Reviewed", reviewVersion: 1,
    staffReviewedBy: "staff-1", staffReviewedAt: { seconds: 1 } }));
  const results = await Promise.allSettled([
    service.approveMonitoringObservation({ monitoringId: "monitor-1", observationId: "OBS-1",
      expectedVersion: 1, actorId: "admin-1", actorRole: "admin" }),
    service.rejectMonitoringObservation({ monitoringId: "monitor-1", observationId: "OBS-1",
      expectedVersion: 1, actorId: "admin-2", actorRole: "admin", reason: "Reject" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("concurrent submissions create one pending observation and clean up the rejected upload", async () => {
  const ownerId = "workflow-concurrency-owner";
  const uploadDirectory = path.join(process.cwd(), "uploads", "monitoring", ownerId);
  table("plantingReports").set("concurrent-report", {
    participantId: ownerId, eventId: "event-1", siteId: "concurrent-site",
    quantityPlanted: 10, plantingDate: "2026-09-01", verificationStatus: "Approved",
  });
  table("sites").set("concurrent-site", { latitude: 12.57, longitude: 123.965 });
  const submission = (imageHash) => service.createMonitoringRecord({
    plantingReportId: "concurrent-report", requesterRole: "participant", monitoredBy: ownerId,
    totalMonitored: 10, healthyCount: 8, damagedCount: 1, deadCount: 1,
    monitoredDate: "2026-10-10", maturityStatus: "Immature", remarks: "Concurrent field check",
    metadata: { latitude: 12.57, longitude: 123.965, capturedAt: "2026-10-10T08:00:00+08:00" },
    imageHash, imageDetails: { format: "jpeg" },
    file: { originalname: "field.jpg", mimetype: "image/jpeg", size: 5, buffer: Buffer.from(imageHash) },
  });

  try {
    const results = await Promise.allSettled([
      submission("concurrent-hash-a"), submission("concurrent-hash-b"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "OUTSTANDING_OBSERVATION_EXISTS");
    const [lifecycleId, lifecycle] = [...table("monitoringRecords").entries()].find(
      ([, record]) => record.plantingReportId === "concurrent-report"
    );
    assert.equal(lifecycle.history.length, 1);
    assert.equal(lifecycle.history[0].reviewStatus, "Pending Review");
    assert.equal([...table("notifications").values()].filter((item) =>
      item.type === "monitoring_submitted" && item.relatedRecordId === lifecycleId).length, 1,
    "the rejected transaction must not leave a reporter notification");
    assert.equal((await fs.readdir(uploadDirectory)).length, 1,
      "the upload from the rejected transaction must be removed");
  } finally {
    await fs.rm(uploadDirectory, { recursive: true, force: true });
  }
});

test("returned coverage corrections cannot leave stale official scheduling", async () => {
  table("plantingReports").set("report-1", { participantId: "participant-1", siteId: "site-1", quantityPlanted: 10 });
  table("sites").set("site-1", { latitude: 12.57, longitude: 123.965 });
  seed(observation({ reviewStatus: "Returned for Rechecking", reviewVersion: 1,
    returnedBy: "staff-1", returnReason: "Recheck coverage" }));
  table("monitoringRecords").get("monitor-1").nextMonitoringDate = "2026-10-06";
  const base = { monitoringId: "monitor-1", observationId: "OBS-1", expectedVersion: 1,
    retainEvidenceRevision: 1, totalMonitored: 4, healthyCount: 3, damagedCount: 1,
    deadCount: 0, monitoredDate: "2026-09-02", maturityStatus: "Immature",
    remarks: "Partial correction", actorId: "participant-1" };
  await service.resubmitMonitoringObservation(base);
  let lifecycle = table("monitoringRecords").get("monitor-1");
  assert.equal(lifecycle.history[0].id, "OBS-1");
  assert.equal(lifecycle.history[0].revisionHistory.length, 2);
  assert.equal(lifecycle.nextMonitoringDate, null);

  lifecycle.history[0].reviewStatus = "Returned for Rechecking";
  lifecycle.history[0].reviewVersion = 3;
  await service.resubmitMonitoringObservation({ ...base, expectedVersion: 3,
    totalMonitored: 10, healthyCount: 8, damagedCount: 1, deadCount: 1 });
  lifecycle = table("monitoringRecords").get("monitor-1");
  assert.equal(lifecycle.history[0].isFullCohortAssessment, true);
  assert.equal(lifecycle.nextMonitoringDate, null,
    "a corrected full observation remains pending until Admin approval");
});

test("replacement evidence stores immutable verification results and rejects duplicates", async () => {
  table("plantingReports").set("report-1", { participantId: "participant-1", siteId: "site-1", quantityPlanted: 10 });
  table("sites").set("site-1", { latitude: 12.57, longitude: 123.965 });
  seed(observation({ reviewStatus: "Returned for Rechecking", reviewVersion: 1 }));
  const replacement = { target: null, imageHash: "replacement-hash", evidenceRef: {
    photoUrl: "/uploads/monitoring/participant-1/replacement.jpg", imageHash: "replacement-hash",
    photoName: "replacement.jpg", photoType: "image/jpeg", photoSize: 100,
    latitude: 12.57, longitude: 123.965, capturedAt: "2026-09-02T08:00:00+08:00" } };
  const payload = { monitoringId: "monitor-1", observationId: "OBS-1", expectedVersion: 1,
    totalMonitored: 10, healthyCount: 8, damagedCount: 1, deadCount: 1,
    monitoredDate: "2026-09-02", maturityStatus: "Immature", remarks: "Replacement",
    actorId: "participant-1", savedEvidence: replacement };
  await service.resubmitMonitoringObservation(payload);
  const evidenceRef = table("monitoringRecords").get("monitor-1").history[0].revisionHistory[1].evidenceRef;
  assert.equal(evidenceRef.siteGpsValid, true);
  assert.equal(evidenceRef.automatedVerificationStatus, "Passed Automated Check");
  assert.deepEqual(evidenceRef.suspiciousFlags, []);
  assert.equal(Number.isFinite(evidenceRef.siteGpsDistanceMeters), true);

  seed(observation({ reviewStatus: "Returned for Rechecking", reviewVersion: 1 }));
  await assert.rejects(service.resubmitMonitoringObservation(payload),
    (error) => error.code === "DUPLICATE_EVIDENCE");
});

test("a failed replacement resubmission removes its newly saved evidence file", async () => {
  const actorId = "unauthorized-replacement-reporter";
  const uploadDirectory = path.join(process.cwd(), "uploads", "monitoring", actorId);
  seed(observation({ reviewStatus: "Returned for Rechecking", reviewVersion: 1 }));
  try {
    await assert.rejects(service.resubmitMonitoringObservation({
      monitoringId: "monitor-1", observationId: "OBS-1", expectedVersion: 1,
      totalMonitored: 10, healthyCount: 8, damagedCount: 1, deadCount: 1,
      monitoredDate: "2026-09-02", maturityStatus: "Immature", remarks: "Replacement",
      actorId, imageHash: "cleanup-replacement-hash", imageDetails: { format: "jpeg" },
      metadata: { latitude: 12.57, longitude: 123.965, capturedAt: "2026-09-02T08:00:00+08:00" },
      file: { originalname: "replacement.jpg", mimetype: "image/jpeg", size: 5,
        buffer: Buffer.from("photo") },
    }), (error) => error.code === "MONITORING_ACTION_FORBIDDEN");
    assert.deepEqual(await fs.readdir(uploadDirectory), []);
  } finally {
    await fs.rm(uploadDirectory, { recursive: true, force: true });
  }
});

test("invalid retained evidence cannot be reused", async () => {
  table("plantingReports").set("report-1", { participantId: "participant-1", siteId: "site-1", quantityPlanted: 10 });
  table("sites").set("site-1", { latitude: 12.57, longitude: 123.965 });
  seed(observation({ reviewStatus: "Returned for Rechecking", reviewVersion: 1,
    revisionHistory: [{ revisionNumber: 1, evidenceRevision: 1,
      evidenceRef: { photoUrl: "/uploads/monitoring/participant-1/photo.jpg",
        imageHash: "hash-1", latitude: 0, longitude: 0 } }] }));
  await assert.rejects(service.resubmitMonitoringObservation({ monitoringId: "monitor-1",
    observationId: "OBS-1", expectedVersion: 1, retainEvidenceRevision: 1,
    totalMonitored: 10, healthyCount: 8, damagedCount: 1, deadCount: 1,
    monitoredDate: "2026-09-02", maturityStatus: "Immature", actorId: "participant-1" }),
  (error) => error.code === "OBSERVATION_EVIDENCE_INVALID");
});
