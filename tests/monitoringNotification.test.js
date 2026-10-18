const assert = require("node:assert/strict");
const test = require("node:test");

const collections = new Map();
function table(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}
function snapshot(id, value, ref) {
  return { id, ref, exists: value !== undefined, data: () => value };
}
function reference(name, id) {
  const ref = { id, name };
  ref.get = async () => snapshot(id, table(name).get(id), ref);
  return ref;
}
function query(name, filters = [], maximum = Infinity, cursor = null) {
  return {
    async get() {
      const docs = [...table(name)].filter(([, value]) =>
        filters.every(([field, expected]) => field.split(".").reduce((item, key) => item?.[key], value) === expected) &&
          (!cursor || id > cursor))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, maximum).map(([id, value]) => snapshot(id, value, reference(name, id)));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
    where(field, operator, value) {
      assert.equal(operator, "==");
      return query(name, [...filters, [field, value]], maximum, cursor);
    },
    orderBy() { return query(name, filters, maximum, cursor); },
    startAfter(id) { return query(name, filters, maximum, id); },
    limit(value) { return query(name, filters, value, cursor); },
  };
}
const db = {
  collection(name) { return { ...query(name), doc: (id) => reference(name, id) }; },
  async runTransaction(callback) {
    const creates = [];
    await callback({
      get: (target) => target.get(),
      create: (ref, value) => creates.push([ref, value]),
      set: (ref, value) => table(ref.name).set(ref.id, value),
    });
    for (const [ref] of creates) {
      if (table(ref.name).has(ref.id)) {
        const error = new Error("already exists"); error.code = 6; throw error;
      }
    }
    creates.forEach(([ref, value]) => table(ref.name).set(ref.id, value));
  },
};
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true, exports: { db },
};

const { milestone } = require("../src/services/earlyMonitoringNotification.service");
const {
  officialSchedule,
  processOfficialMonitoringNotifications,
} = require("../src/services/officialMonitoringNotification.service");

const report = {
  participantId: "owner-1", eventId: "event-1", siteId: "site-1",
  plantingDate: "2026-10-01", quantityPlanted: 10,
  verificationStatus: "Approved", siteName: "Riverside",
};
const approved = (date, overrides = {}) => ({
  workflowVersion: 2, observationType: "official", monitoredDate: date,
  totalMonitored: 10, cohortQuantityAtObservation: 10, isFullCohortAssessment: true,
  reviewStatus: "Approved", adminDecision: "Approve", adminDecidedBy: "admin-1",
  adminDecidedAt: { seconds: 1 }, ...overrides,
});

test.beforeEach(() => collections.clear());

test("Early Monitoring retains opening, deadline, overdue, and weekly milestones", () => {
  const policy = {
    enabled: true, applicable: true, openingDate: "2026-10-01",
    deadlineDate: "2026-10-07", officialOpeningDate: "2026-10-20",
  };
  assert.equal(milestone(policy, "2026-10-01"), "available");
  assert.equal(milestone(policy, "2026-10-05"), "deadline_reminder");
  assert.equal(milestone(policy, "2026-10-08"), "overdue");
  assert.equal(milestone(policy, "2026-10-15"), "overdue_followup_2026-10-15");
  assert.equal(milestone(policy, "2026-10-20"), null);
});

test("official schedule uses first opening, 35-day follow-up, and later monthly cycles", () => {
  assert.equal(officialSchedule(report, []).openingDate, "2026-10-15");
  assert.equal(officialSchedule(report, [{ history: [approved("2026-10-16")] }]).openingDate,
    "2026-11-20");
  assert.equal(officialSchedule(report, [{ history: [approved("2026-10-16"), approved("2026-11-21")] }]).openingDate,
    "2026-12-21");
});

test("partial, pending, reviewed, returned, and rejected observations never advance the schedule", () => {
  for (const entry of [
    approved("2026-10-16", { totalMonitored: 4, isFullCohortAssessment: false }),
    approved("2026-10-16", { reviewStatus: "Rejected", adminDecision: "Reject" }),
  ]) assert.equal(officialSchedule(report, [{ history: [entry] }]).openingDate, "2026-10-15");
  for (const reviewStatus of ["Pending Review", "Reviewed", "Returned for Rechecking"]) {
    const schedule = officialSchedule(report, [{ history: [approved("2026-10-16", {
      reviewStatus, adminDecision: null, adminDecidedBy: null, adminDecidedAt: null,
    })] }]);
    assert.equal(schedule.openingDate, "2026-10-15");
    assert.equal(schedule.outstanding, true);
  }
});

test("compatible legacy validated full observations advance without migration", () => {
  const schedule = officialSchedule(report, [{
    reviewStatus: "Validated",
    history: [{ monitoredDate: "2026-10-16", totalMonitored: 10, cohortQuantityAtObservation: 10 }],
  }]);
  assert.equal(schedule.openingDate, "2026-11-20");
});

test("worker uses report ownership, active Staff, deterministic IDs, and suppresses stale retries", async () => {
  table("plantingReports").set("report-1", report);
  table("monitoringRecords").set("monitor-1", {
    recordType: "monitoringLifecycle", plantingReportId: "report-1", quantityPlanted: 10,
    history: [approved("2026-10-10", {
      originalReporterId: "reporter-2", totalMonitored: 4, isFullCohortAssessment: false,
    })],
  });
  table("users").set("owner-1", { role: "participant", status: "active" });
  table("users").set("reporter-2", { role: "participant", status: "active" });
  table("users").set("staff-1", { role: "staff", status: "active" });
  table("users").set("inactive-staff", { role: "staff", status: "inactive" });

  await Promise.all([
    processOfficialMonitoringNotifications({ today: "2026-10-15" }),
    processOfficialMonitoringNotifications({ today: "2026-10-15" }),
  ]);
  assert.equal(table("notifications").size, 2);
  assert.deepEqual([...table("notifications").values()].map((item) => item.recipientUserId).sort(),
    ["owner-1", "staff-1"]);
  assert.ok([...table("notifications").values()].every((item) =>
    item.relatedRecordId === "monitor-1" && item.type === "official_monitoring_available"));

  await processOfficialMonitoringNotifications({ today: "2026-10-16" });
  assert.equal(table("notifications").size, 2);
});
