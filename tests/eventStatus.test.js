const test = require("node:test");
const assert = require("node:assert/strict");
const { eventScheduleStatus, presentEventStatus, assertEventUpdateAllowed,
  hasLinkedEventRecords } = require("../src/utils/eventStatus.util");

const event = { date: "2026-10-01", startTime: "09:00", endTime: "11:00",
  status: "Upcoming", recordStatus: "scheduled" };

test("computes Upcoming, Ongoing, and Completed in Manila time", () => {
  assert.equal(eventScheduleStatus(event, new Date("2026-10-01T00:59:00Z")).status, "Upcoming");
  assert.equal(eventScheduleStatus(event, new Date("2026-10-01T01:00:00Z")).status, "Ongoing");
  assert.equal(eventScheduleStatus(event, new Date("2026-10-01T03:00:00Z")).status, "Ongoing");
  assert.equal(eventScheduleStatus(event, new Date("2026-10-01T03:01:00Z")).status, "Completed");
});

test("keeps persisted status while presenting the computed status", () => {
  const result = presentEventStatus(event, new Date("2026-10-01T02:00:00Z"));
  assert.equal(result.status, "Ongoing");
  assert.equal(result.persistedStatus, "Upcoming");
  assert.equal(result.recordStatus, "scheduled");
});

test("supports missing legacy end time and explicitly identifies invalid schedules", () => {
  assert.equal(eventScheduleStatus({ ...event, endTime: "" }, new Date("2026-10-01T10:00:00Z")).status, "Ongoing");
  assert.equal(eventScheduleStatus({ ...event, date: "2026-02-30" }).status, "Invalid Schedule");
  assert.equal(eventScheduleStatus({ ...event, startTime: "" }).status, "Invalid Schedule");
});

test("locks relationship changes for request-backed and completed events", () => {
  assert.throws(() => assertEventUpdateAllowed({ ...event, source: "seedling_request", sourceRequestId: "request-1" },
    { date: "2026-10-02" }), (error) => error.code === "REQUEST_EVENT_RELATIONSHIP_LOCKED");
  assert.throws(() => assertEventUpdateAllowed({ ...event, recordStatus: "completed" },
    { plantingSiteId: "site-2" }), (error) => error.code === "COMPLETED_EVENT_RELATIONSHIP_LOCKED");
  assert.doesNotThrow(() => assertEventUpdateAllowed({ ...event, source: "manual" },
    { description: "Updated operational note" }));
});

test("linked records block permanent deletion while an unlinked event remains deletable", () => {
  assert.equal(hasLinkedEventRecords({ sourceRequestId: "request-1" }, []), true);
  assert.equal(hasLinkedEventRecords({}, [{ empty: true }, { empty: false }]), true);
  assert.equal(hasLinkedEventRecords({}, [{ empty: true }, { empty: true }]), false);
});
