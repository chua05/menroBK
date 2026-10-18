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
        filters.every(([field, expected]) => value[field] === expected) && (!cursor || id > cursor))
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
  collection(name) {
    return { ...query(name), doc: (id) => reference(name, id) };
  },
  async runTransaction(callback) {
    const creates = [];
    const transaction = {
      get: (target) => target.get(),
      create: (ref, value) => creates.push([ref, value]),
      set: (ref, value) => table(ref.name).set(ref.id, value),
    };
    await callback(transaction);
    for (const [ref] of creates) {
      const error = new Error("already exists");
      error.code = 6;
      if (table(ref.name).has(ref.id)) throw error;
    }
    creates.forEach(([ref, value]) => table(ref.name).set(ref.id, value));
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true, exports: { db },
};
const {
  dueMilestone, manilaDate, scheduleKey, writeNotifications,
  processEventCalendarNotifications,
} = require("../src/services/eventNotification.service");

const base = {
  name: "Bulan Tree Planting", date: "2026-10-20", startTime: "09:00", endTime: "11:00",
  barangay: "Zone 1", plantingSiteName: "Riverside", archived: false,
};

test.beforeEach(() => collections.clear());

test("uses Manila calendar dates and selects each schedule milestone", () => {
  assert.equal(manilaDate(new Date("2026-10-19T16:30:00Z")), "2026-10-20");
  assert.equal(dueMilestone(base, new Date("2026-10-16T16:00:00Z")), "reminder_3_day");
  assert.equal(dueMilestone(base, new Date("2026-10-18T16:00:00Z")), "reminder_1_day");
  assert.equal(dueMilestone(base, new Date("2026-10-19T23:00:00Z")), "reminder_same_day");
  assert.equal(dueMilestone(base, new Date("2026-10-20T01:00:00Z")), "starting");
  assert.equal(dueMilestone(base, new Date("2026-10-20T03:01:00Z")), "ended");
});

test("skips archived and invalid schedules and supports a missing legacy end time", () => {
  assert.equal(dueMilestone({ ...base, archived: true }, new Date("2026-10-17T00:00:00Z")), null);
  assert.equal(dueMilestone({ ...base, startTime: "" }, new Date("2026-10-17T00:00:00Z")), null);
  assert.equal(dueMilestone({ ...base, endTime: "" }, new Date("2026-10-20T15:00:00Z")), "starting");
  assert.equal(dueMilestone({ ...base, endTime: "" }, new Date("2026-10-20T16:00:00Z")), "ended");
  assert.equal(dueMilestone(base, new Date("2026-10-22T03:01:00Z")), null);
});

test("schedule-specific IDs change after rescheduling and recipient writes are deduplicated", () => {
  assert.notEqual(scheduleKey(base), scheduleKey({ ...base, date: "2026-10-21" }));
  const creates = [];
  writeNotifications({ create: (ref, value) => creates.push([ref, value]) }, {
    eventId: "event-1", event: base, recipientIds: ["staff-1", "staff-1", "participant-1"],
    kind: "scheduled",
  });
  assert.equal(creates.length, 2);
  assert.ok(creates.every(([, value]) => value.relatedEventId === "event-1"));

  const rescheduled = [];
  writeNotifications({ create: (ref, value) => rescheduled.push([ref, value]) }, {
    eventId: "event-1", event: { ...base, date: "2026-10-21" }, previousSchedule: base,
    recipientIds: ["requester-1", "registered-1", "staff-1"], exclude: ["requester-1"],
    kind: "rescheduled",
  });
  assert.equal(rescheduled.length, 2);
  assert.ok(rescheduled.every(([, value]) => value.message.includes("2026-10-20 09:00-11:00") &&
    value.message.includes("2026-10-21 09:00-11:00")));
});

test("worker notifies only active registered recipients and is retry/concurrency idempotent", async () => {
  table("events").set("event-1", { ...base, createdBy: "staff-1", sourceRequestId: "request-1" });
  table("eventParticipants").set("registered", { eventId: "event-1", userId: "participant-1" });
  table("eventParticipants").set("guest", { eventId: "event-1", fullName: "Guest only" });
  table("seedlingRequests").set("request-1", { participantId: "participant-1" });
  table("users").set("staff-1", { role: "staff", status: "active" });
  table("users").set("staff-inactive", { role: "staff", status: "inactive" });
  table("users").set("participant-1", { role: "participant", status: "active" });

  const now = new Date("2026-10-16T16:00:00Z");
  await Promise.all([
    processEventCalendarNotifications({ now }),
    processEventCalendarNotifications({ now }),
  ]);
  assert.equal(table("notifications").size, 2);
  assert.deepEqual([...table("notifications").values()].map((item) => item.recipientUserId).sort(),
    ["participant-1", "staff-1"]);
  assert.ok([...table("notifications").values()].every((item) => item.type === "event_reminder_3_day"));

  await processEventCalendarNotifications({ now });
  assert.equal(table("notifications").size, 2);
});

test("rescheduling prevents the worker from emitting the old schedule reminder", async () => {
  table("events").set("event-1", { ...base, date: "2026-10-22", createdBy: "staff-1" });
  table("users").set("staff-1", { role: "staff", status: "active" });
  await processEventCalendarNotifications({ now: new Date("2026-10-16T16:00:00Z") });
  assert.equal(table("notifications").size, 0);
  await processEventCalendarNotifications({ now: new Date("2026-10-18T16:00:00Z") });
  assert.equal(table("notifications").size, 1);
  assert.equal([...table("notifications").values()][0].type, "event_reminder_3_day");
});
