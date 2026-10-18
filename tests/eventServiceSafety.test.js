const test = require("node:test");
const assert = require("node:assert/strict");

const firebasePath = require.resolve("../src/config/firebase");
const records = new Map();

function snapshot(id, value) {
  return { id, exists: value !== undefined, data: () => value };
}

const db = {
  collection(name) {
    return {
      name,
      doc(id) {
        return { name, id, async get() { return snapshot(id, records.get(`${name}/${id}`)); } };
      },
      where(field, operator, value) { return { name, field, operator, value, query: true }; },
    };
  },
  async runTransaction(operation) {
    return operation({
      async get(target) {
        if (target.query) {
          const docs = [...records.entries()]
            .filter(([key, value]) => key.startsWith(`${target.name}/`) && value[target.field] === target.value)
            .map(([key, value]) => snapshot(key.slice(target.name.length + 1), value));
          return { docs, size: docs.length, empty: docs.length === 0 };
        }
        return snapshot(target.id, records.get(`${target.name}/${target.id}`));
      },
      delete(ref) { records.delete(`${ref.name}/${ref.id}`); },
    });
  },
};

require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const service = require("../src/services/event.service");

test.beforeEach(() => records.clear());

test("permanent deletion rejects an event linked to workflow records", async () => {
  records.set("events/event-linked", { source: "manual", date: "2026-10-20", startTime: "09:00", endTime: "10:00" });
  records.set("plantingReports/report-1", { eventId: "event-linked" });
  await assert.rejects(() => service.deleteEvent("event-linked"),
    (error) => error.code === "EVENT_HAS_LINKED_RECORDS");
  assert.equal(records.has("events/event-linked"), true);
});

test("permanent deletion remains available for a genuinely unlinked event", async () => {
  records.set("events/event-unlinked", { source: "manual", date: "2026-10-20", startTime: "09:00", endTime: "10:00" });
  const result = await service.deleteEvent("event-unlinked");
  assert.equal(result.id, "event-unlinked");
  assert.equal(records.has("events/event-unlinked"), false);
});
