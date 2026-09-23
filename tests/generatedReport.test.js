const assert = require("node:assert/strict");
const test = require("node:test");

const data = new Map();
let sequence = 0;
function rows(name) {
  if (!data.has(name)) data.set(name, new Map());
  return data.get(name);
}
function doc(name, id) {
  return {
    id,
    name,
    async get() {
      const value = rows(name).get(id);
      return { id, exists: value !== undefined, data: () => value };
    },
    async create(value) { rows(name).set(id, value); },
    collection(child) { return collection(`${name}/${id}/${child}`); },
  };
}
function collection(name) {
  return {
    doc(id = `report-${++sequence}`) { return doc(name, id); },
    orderBy() { return this; },
    async get() {
      return { docs: [...rows(name)].map(([id, value]) => ({ id, data: () => value })) };
    },
  };
}
const firebasePath = require.resolve("../src/config/firebase");
const db = {
  collection,
  async runTransaction(callback) {
    const writes = [];
    await callback({
      get: (reference) => reference.get(),
      create(reference, value) { writes.push(["create", reference, value]); },
      update(reference, value) { writes.push(["update", reference, value]); },
    });
    for (const [operation, reference, value] of writes) {
      const target = rows(reference.name);
      target.set(
        reference.id,
        operation === "update" ? { ...target.get(reference.id), ...value } : value
      );
    }
  },
};
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { db },
};
const service = require("../src/services/generatedReport.service");

test("event participation report uses real guest records without exporting contact numbers", async () => {
  rows("events").set("event-1", {
    name: "Juban Planting", date: "2026-09-17", sourceRequestId: "request-1",
    plantingSiteName: "Site One",
  });
  rows("seedlingRequests").set("request-1", { participantName: "Requester" });
  rows("eventParticipants").set("guest-1", {
    eventId: "event-1", participantType: "guest", fullName: "Guest One",
    contactNumber: "09123456789",
  });
  rows("eventParticipants").set("registered-1", {
    eventId: "event-1", participantType: "participant", fullName: "Registered One",
  });
  rows("plantingContributions").set("contribution-1", {
    eventId: "event-1", participantId: "guest-1", species: "Narra", quantity: 5,
  });
  const filters = service.cleanFilters({ type: "event-participation", eventId: "event-1", participantType: "guest" });
  const reportRows = await service.buildRows(filters);
  assert.equal(reportRows.length, 1);
  assert.equal(reportRows[0].participantName, "Guest One");
  assert.equal(reportRows[0].quantityPlanted, 5);
  assert.equal(reportRows[0].species, "Narra");
  assert.equal(JSON.stringify(reportRows).includes("09123456789"), false);
  const generated = await service.generateReport(filters, { uid: "staff-1", fullName: "MENRO Staff" });
  assert.equal(generated.generatedBy, "staff-1");
  assert.match(generated.reportNumber, /^RPT-\d{4}-\d{3,}$/);
  assert.ok(generated.generatedAt.toDate());
  const pdf = await service.generatedPdf(generated.id);
  assert.equal(pdf.bytes.subarray(0, 8).toString(), "%PDF-1.4");
  assert.equal(pdf.bytes.includes(Buffer.from("Guest One")), true);
  assert.equal(pdf.bytes.includes(Buffer.from("09123456789")), false);
});

test("report filters reject unknown types and invalid date ranges", () => {
  assert.throws(() => service.cleanFilters({ type: "invented" }), /Invalid/);
  assert.throws(() => service.cleanFilters({ type: "participant", dateFrom: "2026-09-18", dateTo: "2026-09-17" }), /Invalid/);
  assert.throws(() => service.cleanFilters({ type: "participant", dateFrom: "2026-02-30" }), /Invalid/);
});

test("monthly reporting groups only dates backed by real records", async () => {
  rows("distributions").set("distribution-1", {
    releasedAt: "2026-09-17", totalQuantityReleased: 7,
  });
  const result = await service.buildRows(service.cleanFilters({
    type: "monthly", dateFrom: "2026-09-01", dateTo: "2026-09-30",
  }));
  assert.equal(result.length, 1);
  assert.equal(result[0].period, "2026-09");
  assert.equal(result[0].quantityReleased, 7);
  assert.equal(result[0].participantsJoined, 0);
});

test("tree monitoring report reads the stored survival fields", async () => {
  rows("monitoringRecords").set("monitor-1", {
    plantingReportId: "event_event-1", monitoringDate: "2026-09-17",
    healthyCount: 3, damagedCount: 1, deadCount: 1,
    survivingCount: 4, survivalRate: 80,
  });
  const result = await service.buildRows(service.cleanFilters({ type: "tree-monitoring" }));
  assert.deepEqual(result[0], {
    monitoringId: "monitor-1", reportId: "event_event-1", date: "2026-09-17",
    healthyCount: 3, damagedCount: 1, deadCount: 1,
    survivingCount: 4, survivalRate: 80,
  });
});
