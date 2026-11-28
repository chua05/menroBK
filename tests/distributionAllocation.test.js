const assert = require("node:assert/strict");
const test = require("node:test");

const tables = new Map();
let getAllCalls = [];
let getCalls = 0;
const table = (name) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
const ref = (name, id) => ({
  id, name,
  async get() { getCalls += 1; const value = table(name).get(id); return { id, exists: value !== undefined, data: () => value }; },
});
const db = {
  collection(name) {
    return {
      doc: (id) => ref(name, id),
      where: (field, _op, value) => ({ async get() { return { docs: [...table(name)].filter(([, data]) => data[field] === value).map(([id, data]) => ({ id, data: () => data })) }; } }),
      async get() { return { docs: [...table(name)].map(([id, data]) => ({ id, data: () => data })) }; },
    };
  },
  async getAll(...refs) {
    getAllCalls.push(refs.map((r) => `${r.name}/${r.id}`));
    return Promise.all(refs.map((r) => r.get()));
  },
};
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db, auth: {} } };
const service = require("../src/services/distribution.service");

const EMPTY = { batchReference: "", inventoryNumber: "", sourceType: "", sourceSpecification: "", dateReceived: "" };
const reset = () => { tables.clear(); getAllCalls = []; getCalls = 0; };
const snap = (extra) => ({ inventoryId: "inv-1", itemIndex: 0, ...EMPTY, ...extra });

test("release snapshot is used entirely (basis release)", async () => {
  reset();
  table("seedlingInventory").set("inv-1", { batchReference: "BAT-LIVE", inventoryNumber: "INV-LIVE", sourceType: "Donation", sourceSpecification: "Live", dateReceived: "2026-01-01" });
  table("distributions").set("d1", { releasedBy: "staff-1", items: [{ inventoryId: "inv-1", quantity: 5 }],
    batchAllocations: [snap({ batchReference: "BAT-2026-001", inventoryNumber: "INV-2026-001", sourceType: "Purchase", sourceSpecification: "Nursery A", dateReceived: "2026-10-12" })] });
  const result = await service.getDistributionById("d1");
  assert.deepEqual(result.items[0].allocation, { inventoryId: "inv-1", batchReference: "BAT-2026-001", inventoryNumber: "INV-2026-001",
    sourceType: "Purchase", sourceSpecification: "Nursery A", dateReceived: "2026-10-12", basis: "release", liveRecordFound: true, recordFound: true });
});

test("Donation released, later corrected to Other: allocation keeps the release-time pairing, never merges", async () => {
  reset();
  table("seedlingInventory").set("inv-1", { batchReference: "BAT-1", inventoryNumber: "INV-1", sourceType: "Other", sourceSpecification: "LGU Purchase 2026", dateReceived: "2026-01-01" });
  table("distributions").set("d1", { items: [{ inventoryId: "inv-1", quantity: 5 }],
    batchAllocations: [snap({ batchReference: "BAT-1", inventoryNumber: "INV-1", sourceType: "Donation", dateReceived: "2026-01-01" })] });
  const { allocation } = (await service.getDistributionById("d1")).items[0];
  assert.equal(allocation.sourceType, "Donation");
  assert.equal(allocation.sourceSpecification, "");
  assert.equal(allocation.basis, "release");
});

test("no snapshot: current record is used entirely (basis current-record), including archived", async () => {
  reset();
  table("seedlingInventory").set("inv-1", { batchReference: "BAT-9", inventoryNumber: "INV-9", sourceType: "Donation", sourceSpecification: "DENR", dateReceived: "2026-03-04", isDeleted: true });
  table("distributions").set("d1", { items: [{ inventoryId: "inv-1", quantity: 5 }] });
  const [result] = await service.getAllDistributions();
  assert.deepEqual(result.items[0].allocation, { inventoryId: "inv-1", batchReference: "BAT-9", inventoryNumber: "INV-9",
    sourceType: "Donation", sourceSpecification: "DENR", dateReceived: "2026-03-04", basis: "current-record", liveRecordFound: true, recordFound: true });
});

test("legacy Timestamp dateReceived is normalised to a Manila date, not [object Object]", async () => {
  reset();
  table("seedlingInventory").set("inv-1", { batchReference: "B", dateReceived: { toDate: () => new Date("2026-03-04T18:00:00Z") } });
  table("distributions").set("d1", { items: [{ inventoryId: "inv-1", quantity: 5 }] });
  assert.equal((await service.getDistributionById("d1")).items[0].allocation.dateReceived, "2026-03-05");
});

test("missing record and no snapshot: unavailable, all empty, nothing invented", async () => {
  reset();
  table("distributions").set("d1", { items: [{ inventoryId: "gone", quantity: 5 }] });
  const result = await service.getDistributionById("d1");
  assert.deepEqual(result.items[0].allocation, { inventoryId: "gone", ...EMPTY, basis: "unavailable", liveRecordFound: false, recordFound: false });
});

test("snapshot survives a deleted inventory record (liveRecordFound false)", async () => {
  reset();
  table("distributions").set("d1", { items: [{ inventoryId: "inv-1", quantity: 5 }], batchAllocations: [snap({ batchReference: "BAT-1" })] });
  const { allocation } = (await service.getDistributionById("d1")).items[0];
  assert.equal(allocation.basis, "release");
  assert.equal(allocation.liveRecordFound, false);
  assert.equal(allocation.batchReference, "BAT-1");
});

test("multi-batch distribution stays one distribution with two allocations and unchanged totals", async () => {
  reset();
  table("seedlingInventory").set("a", { batchReference: "BAT-A", inventoryNumber: "INV-A", sourceType: "Purchase", sourceSpecification: "S1", dateReceived: "2026-01-02" });
  table("seedlingInventory").set("b", { batchReference: "BAT-B", inventoryNumber: "INV-B", sourceType: "Donation", sourceSpecification: "S2", dateReceived: "2026-02-03" });
  table("distributions").set("d1", { totalQuantityReleased: 30, items: [{ inventoryId: "a", quantity: 10 }, { inventoryId: "b", quantity: 20 }, { inventoryId: "a", quantity: 0 }] });
  const all = await service.getAllDistributions();
  assert.equal(all.length, 1);
  assert.equal(all[0].totalQuantityReleased, 30);
  assert.deepEqual(all[0].items.map((i) => i.allocation.batchReference), ["BAT-A", "BAT-B", "BAT-A"]);
  assert.deepEqual(all[0].items.map((i) => i.quantity), [10, 20, 0]);
  assert.equal(getAllCalls.length, 1, "one batched read");
  assert.deepEqual(getAllCalls[0].filter((r) => r.startsWith("seedlingInventory/")).sort(), ["seedlingInventory/a", "seedlingInventory/b"], "deduplicated ids");
});

test("releasedByName comes from the users doc, falling back through name fields then empty", async () => {
  reset();
  table("users").set("u1", { fullName: "Full Name", name: "N", displayName: "D", password: "x", email: "e@x" });
  table("users").set("u2", { name: "Only Name" });
  table("users").set("u3", { displayName: "Display" });
  table("users").set("u4", {});
  for (const [id, by] of [["d1", "u1"], ["d2", "u2"], ["d3", "u3"], ["d4", "u4"], ["d5", "nobody"], ["d6", undefined]]) {
    table("distributions").set(id, { releasedBy: by, items: [] });
  }
  const names = Object.fromEntries((await service.getAllDistributions()).map((d) => [d.id, d.releasedByName]));
  assert.deepEqual(names, { d1: "Full Name", d2: "Only Name", d3: "Display", d4: "", d5: "", d6: "" });
  const one = await service.getDistributionById("d1");
  assert.equal(one.releasedBy, "u1");
  assert.equal(JSON.stringify(one).includes("e@x"), false);
});

test("reads perform no writes", async () => {
  reset();
  table("distributions").set("d1", { participantId: "p1", items: [{ inventoryId: "a", quantity: 1 }] });
  const before = JSON.stringify([...table("distributions")]);
  await service.getAllDistributions();
  assert.equal(JSON.stringify([...table("distributions")]), before);
});

test("create stores batchAllocations on the distribution only; items are unchanged", () => {
  reset();
  let written;
  const transaction = { set(_ref, data) { written = data; } };
  service.createDistributionRecordInTransaction(transaction, {
    requestId: "r1", releasedBy: "staff-1", releasedAt: "now",
    requestData: { items: [{ inventoryId: "a", species: "X", quantity: 3 }],
      batchAllocations: [snap({ inventoryId: "a", batchReference: "BAT-1", sourceType: "Purchase" })] },
  });
  assert.deepEqual(written.batchAllocations, [{ inventoryId: "a", itemIndex: 0, batchReference: "BAT-1", inventoryNumber: "", sourceType: "Purchase", sourceSpecification: "", dateReceived: "" }]);
  for (const key of Object.keys(EMPTY)) assert.equal(key in written.items[0], false, key);
});

test("participant-facing eligible distributions never expose batchAllocations, allocation or source data", async () => {
  reset();
  table("distributions").set("d1", { requestId: "d1", participantId: "owner", status: "Released", eventId: "evt-1", plantingSiteId: "s", releasedBy: "staff-1",
    items: [{ inventoryId: "inv-1", quantity: 5 }], batchAllocations: [snap({ batchReference: "BAT-SECRET", sourceType: "Other", sourceSpecification: "Private donor" })] });
  table("seedlingRequests").set("d1", { participantId: "owner" });
  table("events").set("evt-1", { recordStatus: "Authorized", status: "Upcoming", date: "2020-01-01", allocationReleasedAt: "x", plantingSiteId: "s", sourceRequestId: "d1" });
  table("plantingReports").set("event_evt-1", { reportingProgress: "Awaiting Submission" });
  const rows = await service.getEligibleDistributionsForParticipant("owner");
  assert.equal(rows.length, 1, "owner still sees the distribution");
  const json = JSON.stringify(rows);
  for (const needle of ["batchAllocations", "allocation", "BAT-SECRET", "Private donor", "sourceSpecification", "batchReference"]) {
    assert.equal(json.includes(needle), false, needle);
  }
});
