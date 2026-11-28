const assert = require("node:assert/strict");
const test = require("node:test");

const records = new Map();
let generated = 0;
let transactionQueue = Promise.resolve();
function table(name) {
  if (!records.has(name)) records.set(name, new Map());
  return records.get(name);
}
function ref(name, id) {
  return {
    id, name,
    async get() {
      const value = table(name).get(id);
      return { id, exists: value !== undefined, data: () => value };
    },
  };
}
const db = {
  collection(name) {
    return {
      doc(id = `generated-${++generated}`) { return ref(name, id); },
      async get() {
        return { docs: [...table(name)].map(([id, data]) => ({ id, data: () => data })) };
      },
      where(field, operator, value) {
        assert.equal(operator, "==");
        return { async get() { return { docs: [...table(name)].filter(([, row]) => row[field] === value).map(([id, data]) => ({ id, data: () => data })) }; } };
      },
    };
  },
  runTransaction(callback) {
    const execute = async () => {
      const writes = [];
      const transaction = {
        get: (reference) => reference.get(),
        create(reference, value) { writes.push(["create", reference, value]); },
        update(reference, value) { writes.push(["update", reference, value]); },
      };
      const result = await callback(transaction);
      for (const [operation, reference, value] of writes) {
        const target = table(reference.name);
        if (operation === "create" && target.has(reference.id)) throw new Error("Already exists");
        target.set(reference.id, operation === "update" ? { ...target.get(reference.id), ...value } : value);
      }
      return result;
    };
    const result = transactionQueue.then(execute, execute);
    transactionQueue = result.catch(() => undefined);
    return result;
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const inventoryService = require("../src/services/inventory.service");
const inventoryController = require("../src/controller/inventory.controller");

function response() {
  return {
    result: {},
    status(code) { this.result.code = code; return this; },
    json(body) { this.result.body = body; return this; },
  };
}

function validPayload(overrides = {}) {
  return {
    species: "Kalamansi", category: "Fruit Tree", initialQuantity: 100,
    stockStatus: "Available", sourceType: "MENRO Propagation",
    dateReceived: "2020-01-01", storageLocation: "MENRO Nursery",
    description: "Healthy seedlings", ...overrides,
  };
}

async function create(body) {
  const res = response();
  await inventoryController.addInventory({ body, user: { uid: "staff-1" } }, res);
  return res.result;
}

test("species master preserves authoritative scientific names and leaves Acacia unspecified", () => {
  const { findSaplingSpecies } = require("../src/data/saplingSpecies");
  assert.equal(findSaplingSpecies("Kalamansi").scientificName, "Citrus × microcarpa");
  assert.equal(findSaplingSpecies("Narra").scientificName, "Pterocarpus indicus");
  assert.equal(findSaplingSpecies("Balig-ang").scientificName, "Syzygium polycephaloides");
  assert.equal(findSaplingSpecies("Ogob").scientificName, "Artocarpus camansi");
  assert.equal(findSaplingSpecies("Acacia").scientificName, null);
});

test("create derives scientific name, preserves initial/current quantities, and rejects client batch references", async () => {
  const rejected = await create(validPayload({ batchReference: "BAT-2099-999" }));
  assert.equal(rejected.code, 400);

  const created = await create(validPayload({ scientificName: "Pterocarpus indicus" }));
  assert.equal(created.code, 201);
  assert.equal(created.body.data.scientificName, "Citrus × microcarpa");
  assert.equal(created.body.data.initialQuantity, 100);
  assert.equal(created.body.data.currentQuantity, 100);
  assert.match(created.body.data.batchReference, /^BAT-\d{4}-\d{3}$/);
});

test("zero stock is forced out of stock and positive stock is calculated, not client-chosen", async () => {
  const zero = await create(validPayload({ initialQuantity: 0, stockStatus: "Available" }));
  assert.equal(zero.code, 201);
  assert.equal(zero.body.data.stockStatus, "Out of Stock");

  const available = await create(validPayload({ initialQuantity: 5, stockStatus: "Available" }));
  const limited = await create(validPayload({ initialQuantity: 5, stockStatus: "Limited" }));
  assert.equal(available.body.data.stockStatus, "Available");
  assert.equal(limited.body.data.stockStatus, "Available");
});

test("concurrent creates receive distinct transaction-backed batch references", async () => {
  const [first, second] = await Promise.all([
    inventoryService.createInventory({ ...validPayload(), scientificName: "Citrus × microcarpa", createdBy: "staff-1" }),
    inventoryService.createInventory({ ...validPayload(), scientificName: "Citrus × microcarpa", createdBy: "staff-2" }),
  ]);
  assert.notEqual(first.batchReference, second.batchReference);
});

test("stock adjustment changes current quantity without rewriting initial quantity or batch reference", async () => {
  const created = await inventoryService.createInventory({ ...validPayload(), scientificName: "Citrus × microcarpa", createdBy: "staff-1" });
  const adjusted = await inventoryService.addInventoryStock(created.id, 25, "staff-1");
  assert.equal(adjusted.initialQuantity, 100);
  assert.equal(adjusted.currentQuantity, 125);
  assert.equal(adjusted.batchReference, created.batchReference);
});

test("client-sent stockStatus is ignored on create; status is calculated", async () => {
  const created = await create(validPayload({ initialQuantity: 100, stockStatus: "Limited" }));
  assert.equal(created.code, 201);
  assert.equal(created.body.data.stockStatus, "Available");
  assert.equal(created.body.data.status, "Available");
  assert.equal(created.body.data.totalReceivedQuantity, 100);
  const bogus = await create(validPayload({ initialQuantity: 100, stockStatus: "Nonsense" }));
  assert.equal(bogus.code, 201);
});

test("restock on baseline-known record updates total and status", async () => {
  const created = await inventoryService.createInventory({ ...validPayload(), createdBy: "staff-1" });
  records.get("seedlingInventory").set(created.id, { ...records.get("seedlingInventory").get(created.id), currentQuantity: 10, availableQuantity: 10, status: "Limited", stockStatus: "Limited" });
  const adjusted = await inventoryService.addInventoryStock(created.id, 100, "staff-1");
  assert.equal(adjusted.totalReceivedQuantity, 200);
  assert.equal(adjusted.currentQuantity, 110);
  assert.equal(adjusted.stockStatus, "Available");
});

test("restock on legacy restocked record leaves total missing and shows Needs Review", async () => {
  table("seedlingInventory").set("legacy-1", {
    species: "Narra", initialQuantity: 100, currentQuantity: 5, availableQuantity: 5,
    replenishmentCycle: 1, isDeleted: false, status: "Limited", stockStatus: "Limited",
  });
  const adjusted = await inventoryService.addInventoryStock("legacy-1", 10, "staff-1");
  assert.equal(adjusted.totalReceivedQuantity, null);
  assert.equal(adjusted.stockStatus, "Needs Review");
  const read = await inventoryService.getInventoryById("legacy-1");
  assert.equal(read.totalReceivedQuantity, null);
  assert.equal(read.stockStatus, "Needs Review");
  assert.ok(read.stockBaselineIssue);
  const list = await inventoryService.getAllInventory({ status: "Needs Review" });
  assert.ok(list.some((item) => item.id === "legacy-1"));
});

test("update ignores client stockStatus", async () => {
  const created = await inventoryService.createInventory({ ...validPayload(), createdBy: "staff-1" });
  const res = response();
  await inventoryController.updateInventory({ params: { id: created.id }, body: { stockStatus: "Limited", description: "x" }, user: { uid: "s" } }, res);
  assert.equal(res.result.code, 200);
  assert.equal(res.result.body.data.stockStatus, "Available");
  const only = response();
  await inventoryController.updateInventory({ params: { id: created.id }, body: { stockStatus: "Limited" }, user: { uid: "s" } }, only);
  assert.equal(only.result.code, 200);
  assert.equal(only.result.body.data.stockStatus, "Available");
});

test("restock of a batch created empty gets a known baseline", async () => {
  const created = await create(validPayload({ initialQuantity: 0 }));
  const adjusted = await inventoryService.addInventoryStock(created.body.data.id, 10, "staff-1");
  assert.equal(adjusted.totalReceivedQuantity, 10);
  assert.equal(adjusted.stockStatus, "Available");
});

test("restock never invents a baseline for null/empty initialQuantity or non-empty batches with 0 initial", async () => {
  const cases = [
    ["null-init", { initialQuantity: null, currentQuantity: 50, availableQuantity: 50 }],
    ["blank-init", { initialQuantity: "", currentQuantity: 50, availableQuantity: 50 }],
    ["nonempty-zero-init", { initialQuantity: 0, currentQuantity: 50, availableQuantity: 50 }],
    ["zero-init-distributed", { initialQuantity: 0, currentQuantity: 0, availableQuantity: 0, distributedQuantity: 4 }],
    ["zero-init-reserved", { initialQuantity: 0, currentQuantity: 0, availableQuantity: 0, reservedQuantity: 4 }],
  ];
  for (const [id, fields] of cases) {
    table("seedlingInventory").set(id, { species: "Narra", isDeleted: false, ...fields });
    const adjusted = await inventoryService.addInventoryStock(id, 10, "staff-1");
    assert.equal(adjusted.totalReceivedQuantity, null, id);
    assert.equal(adjusted.stockStatus, "Needs Review", id);
    assert.equal(table("seedlingInventory").get(id).totalReceivedQuantity, undefined, id);
  }
});

test("restock of an unprovable pre-counter legacy batch never persists a total", async () => {
  table("seedlingInventory").set("pre-counter", { species: "Narra", isDeleted: false, initialQuantity: 100, currentQuantity: 50, availableQuantity: 50, distributedQuantity: 250 });
  const adjusted = await inventoryService.addInventoryStock("pre-counter", 10, "staff-1");
  assert.equal(adjusted.stockStatus, "Needs Review");
  assert.equal(table("seedlingInventory").get("pre-counter").totalReceivedQuantity, undefined);
  table("seedlingInventory").set("proven", { species: "Narra", isDeleted: false, initialQuantity: 100, currentQuantity: 30, availableQuantity: 30, distributedQuantity: 70 });
  const ok = await inventoryService.addInventoryStock("proven", 10, "staff-1");
  assert.equal(ok.totalReceivedQuantity, 110);
  assert.equal(ok.stockStatus, "Available");
});
