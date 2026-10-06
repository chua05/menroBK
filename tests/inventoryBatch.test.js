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
    description: "Healthy saplings", ...overrides,
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

test("zero stock is forced out of stock while positive Available and Limited are accepted", async () => {
  const zero = await create(validPayload({ initialQuantity: 0, stockStatus: "Available" }));
  assert.equal(zero.code, 201);
  assert.equal(zero.body.data.stockStatus, "Out of Stock");

  const available = await create(validPayload({ initialQuantity: 5, stockStatus: "Available" }));
  const limited = await create(validPayload({ initialQuantity: 5, stockStatus: "Limited" }));
  assert.equal(available.body.data.stockStatus, "Available");
  assert.equal(limited.body.data.stockStatus, "Limited");
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
