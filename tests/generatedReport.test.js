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
    name: "Bulan Planting", date: "2026-09-17", sourceRequestId: "request-1",
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
    quantityPlanted: 5,
    healthyCount: 3, damagedCount: 1, deadCount: 1,
    survivingCount: 4, survivalRate: 80, reviewStatus: "Approved",
  });
  const result = await service.buildRows(service.cleanFilters({ type: "tree-monitoring" }));
  assert.deepEqual(result[0], {
    monitoringId: "monitor-1", observationId: "monitor-1", reportId: "event_event-1", date: "2026-09-17",
    healthyCount: 3, damagedCount: 1, deadCount: 1,
    totalMonitored: 5, survivingCount: 4, survivalRate: 80,
    mortalityRate: null, coverage: "Full cohort", monitoredBy: "",
    workflowStatus: "Approved", revisionNumber: null,
    staffReviewedBy: "", adminDecidedBy: "", adminDecision: "",
    approvalBasis: "Legacy Validated",
  });
});

test("tree monitoring reports include every validated observation in the selected range", async () => {
  rows("monitoringRecords").set("monitor-history", {
    plantingReportId: "report-history",
    quantityPlanted: 10,
    history: [
      { monitoredDate: "2026-08-01", healthyCount: 6, damagedCount: 2, deadCount: 2,
        survivingCount: 8, survivalRate: 80, reviewStatus: "Approved" },
      { monitoredDate: "2026-10-01", healthyCount: 1, damagedCount: 0, deadCount: 9,
        survivingCount: 1, survivalRate: 10, reviewStatus: "Pending" },
      { monitoredDate: "2026-09-01", healthyCount: 5, damagedCount: 2, deadCount: 3,
        survivingCount: 7, survivalRate: 70, reviewStatus: "Validated" },
      { monitoredDate: "2026-11-01", healthyCount: 0, damagedCount: 0, deadCount: 10,
        survivingCount: 0, survivalRate: 0, reviewStatus: "Rejected" },
    ],
  });

  try {
    const result = await service.buildRows(service.cleanFilters({
      type: "tree-monitoring", dateFrom: "2026-01-01", dateTo: "2026-12-31",
    }));
    const lifecycleRows = result.filter((item) => item.monitoringId === "monitor-history");
    assert.deepEqual(lifecycleRows.map((item) => item.date), ["2026-08-01", "2026-09-01"]);
  } finally {
    rows("monitoringRecords").delete("monitor-history");
  }
});

test("historical monitoring reports filter by actual monitoredDate before returning observations", async () => {
  rows("monitoringRecords").set("monitor-dates", {
    plantingReportId: "report-dates", quantityPlanted: 100,
    history: [
      { id: "august", monitoredDate: "2026-08-10", monitoredAt: "2026-11-01T00:00:00Z",
        healthyCount: 80, damagedCount: 10, deadCount: 10, totalMonitored: 100,
        reviewStatus: "Approved" },
      { id: "october", monitoredDate: "2026-10-10", monitoredAt: "2026-10-11T00:00:00Z",
        healthyCount: 70, damagedCount: 10, deadCount: 20, totalMonitored: 100,
        reviewStatus: "Approved" },
    ],
  });
  try {
    const result = await service.buildRows(service.cleanFilters({
      type: "tree-monitoring", dateFrom: "2026-08-01", dateTo: "2026-08-31",
    }));
    const row = result.find((item) => item.monitoringId === "monitor-dates");
    assert.equal(row.observationId, "august");
    assert.equal(row.date, "2026-08-10");
  } finally {
    rows("monitoringRecords").delete("monitor-dates");
  }
});

test("operational reports retain multiple partial observations and unknown legacy coverage", async () => {
  rows("monitoringRecords").set("monitor-partials", {
    plantingReportId: "report-partials", quantityPlanted: 100,
    history: [
      { id: "partial-1", monitoredDate: "2026-08-01", healthyCount: 18, damagedCount: 1,
        deadCount: 1, totalMonitored: 20, cohortQuantityAtObservation: 100,
        survivingCount: 19, survivalRate: 95, mortalityRate: 5, monitoredBy: "user-1",
        reviewStatus: "Approved" },
      { id: "partial-2", monitoredDate: "2026-08-15", healthyCount: 20, damagedCount: 3,
        deadCount: 2, totalMonitored: 25, cohortQuantityAtObservation: 100,
        survivingCount: 23, survivalRate: 92, mortalityRate: 8, monitoredBy: "user-2",
        reviewStatus: "Approved" },
    ],
  });
  rows("monitoringRecords").set("monitor-unknown", {
    plantingReportId: "report-unknown", monitoringDate: "2026-08-20",
    healthyCount: 3, damagedCount: 1, deadCount: 1, reviewStatus: "Approved",
  });
  try {
    const result = await service.buildRows(service.cleanFilters({
      type: "tree-monitoring", dateFrom: "2026-08-01", dateTo: "2026-08-31",
    }));
    const partials = result.filter((item) => item.monitoringId === "monitor-partials");
    assert.deepEqual(partials.map((item) => item.observationId), ["partial-1", "partial-2"]);
    assert.deepEqual(partials.map((item) => item.coverage), ["Partial observation", "Partial observation"]);
    assert.equal(result.find((item) => item.monitoringId === "monitor-unknown").coverage,
      "Coverage Unavailable / Legacy");
  } finally {
    rows("monitoringRecords").delete("monitor-partials");
    rows("monitoringRecords").delete("monitor-unknown");
  }
});

test("report generation accepts small datasets and does not persist zero-data attempts", async () => {
  rows("distributions").set("small-1", {
    releasedAt: "2026-10-01", totalQuantityReleased: 1,
  });
  rows("distributions").set("small-2", {
    releasedAt: "2026-10-02", totalQuantityReleased: 2,
  });

  const one = await service.generateReport({
    type: "seedling-distribution", dateFrom: "2026-10-01", dateTo: "2026-10-01",
  }, { uid: "staff-1", fullName: "MENRO Staff" });
  assert.equal(one.rowCount, 1);

  const two = await service.generateReport({
    type: "seedling-distribution", dateFrom: "2026-10-01", dateTo: "2026-10-02",
  }, { uid: "staff-1", fullName: "MENRO Staff" });
  assert.equal(two.rowCount, 2);

  const historyBefore = rows("generatedReports").size;
  await assert.rejects(
    service.generateReport({
      type: "seedling-distribution", dateFrom: "1999-01-01", dateTo: "1999-01-02",
    }, { uid: "staff-1", fullName: "MENRO Staff" }),
    (error) => error.code === "REPORT_DATA_UNAVAILABLE" &&
      error.message === service.REPORT_DATA_UNAVAILABLE
  );
  assert.equal(rows("generatedReports").size, historyBefore);
});

test("every report type exposed by the Reports page generates from one or more real rows", async () => {
  rows("plantingReports").set("planting-1", {
    submittedAt: "2026-11-03", reportNumber: "RPT-2026-900",
    quantityPlanted: 3, verificationStatus: "Pending Review",
  });
  const cases = [
    { type: "seedling-distribution", dateFrom: "2026-10-01", dateTo: "2026-10-01" },
    { type: "planting-activity", dateFrom: "2026-11-03", dateTo: "2026-11-03" },
    { type: "tree-monitoring", dateFrom: "2026-09-17", dateTo: "2026-09-17" },
    { type: "participant", dateFrom: "2026-09-17", dateTo: "2026-09-17" },
    { type: "monthly", dateFrom: "2026-09-01", dateTo: "2026-09-30" },
    { type: "annual", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
  ];
  for (const filters of cases) {
    const generated = await service.generateReport(filters, {
      uid: "staff-1", fullName: "MENRO Staff",
    });
    assert.ok(generated.rowCount >= 1, `${filters.type} should contain real rows`);
  }
});
