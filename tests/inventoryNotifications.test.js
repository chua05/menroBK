const assert = require("node:assert/strict");
const test = require("node:test");

const collections = new Map();
let queue = Promise.resolve();
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
function query(name, filters = []) {
  return {
    async get() {
      const docs = [...table(name)].filter(([, value]) =>
        filters.every(([field, expected]) => value[field] === expected))
        .map(([id, value]) => snapshot(id, value, reference(name, id)));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
    where(field, operator, value) {
      assert.equal(operator, "==");
      return query(name, [...filters, [field, value]]);
    },
  };
}
const db = {
  collection(name) { return { ...query(name), doc: (id) => reference(name, id) }; },
  runTransaction(callback) {
    const execute = async () => {
      const writes = [];
      const result = await callback({
        get: (target) => target.get(),
        create: (ref, value) => writes.push(["create", ref, value]),
        update: (ref, value) => writes.push(["update", ref, value]),
      });
      for (const [operation, ref] of writes) {
        if (operation === "create" && table(ref.name).has(ref.id)) throw new Error("Already exists");
      }
      writes.forEach(([operation, ref, value]) => table(ref.name).set(ref.id,
        operation === "update" ? { ...table(ref.name).get(ref.id), ...value } : value));
      return result;
    };
    const result = queue.then(execute, execute);
    queue = result.catch(() => undefined);
    return result;
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true, exports: { db },
};
const inventory = require("../src/services/inventory.service");

function seedInventory(overrides = {}) {
  table("seedlingInventory").set("inventory-1", {
    species: "Narra", inventoryNumber: "INV-2026-001", batchReference: "BAT-2026-001",
    quantity: 10, initialQuantity: 10, currentQuantity: 10, availableQuantity: 10,
    reservedQuantity: 0, distributedQuantity: 0, lowStockThreshold: 5,
    lowStockCycle: 0, outOfStockCycle: 0, replenishmentCycle: 0,
    status: "Available", stockStatus: "Available", isDeleted: false, ...overrides,
  });
}
function seedUsers() {
  table("users").set("admin-1", { role: "admin", status: "active" });
  table("users").set("staff-1", { role: "staff", status: "active" });
  table("users").set("staff-inactive", { role: "staff", status: "inactive" });
}

test.beforeEach(() => { collections.clear(); queue = Promise.resolve(); seedUsers(); });

test("a threshold-only crossing starts one low-stock cycle for active roles", async () => {
  seedInventory();
  const updated = await inventory.updateInventoryById("inventory-1", { lowStockThreshold: 12 }, "staff-1");
  assert.equal(updated.currentQuantity, 10);
  assert.equal(updated.lowStockCycle, 1);
  assert.equal(table("notifications").has("low_stock_inventory-1_1_admin-1"), true);
  assert.equal(table("notifications").has("low_stock_inventory-1_1_staff-1"), true);
  assert.equal(table("notifications").has("low_stock_inventory-1_1_staff-inactive"), false);

  await inventory.updateInventoryById("inventory-1", { lowStockThreshold: 15 }, "staff-1");
  assert.equal(table("seedlingInventory").get("inventory-1").lowStockCycle, 1);
  assert.equal([...table("notifications")].filter(([id]) => id.startsWith("low_stock_")).length, 2);
});

test("positive-to-zero stock creates one out-of-stock cycle without changing the requested quantity", async () => {
  seedInventory({ currentQuantity: 4, availableQuantity: 4, quantity: 4, initialQuantity: 4 });
  const updated = await inventory.updateInventoryById("inventory-1", { quantity: 0 }, "staff-1");
  assert.equal(updated.currentQuantity, 0);
  assert.equal(updated.availableQuantity, 0);
  assert.equal(updated.outOfStockCycle, 1);
  assert.equal(table("notifications").has("out_of_stock_inventory-1_1_admin-1"), true);
  assert.equal(table("notifications").has("out_of_stock_inventory-1_1_staff-1"), true);

  await inventory.updateInventoryById("inventory-1", { quantity: 0 }, "staff-1");
  assert.equal(table("seedlingInventory").get("inventory-1").outOfStockCycle, 1);
});

test("authorized replenishment records exact quantities and deterministic concurrent cycles", async () => {
  seedInventory({ currentQuantity: 0, availableQuantity: 0, quantity: 0, initialQuantity: 0,
    status: "Out of Stock", stockStatus: "Out of Stock" });
  const first = await inventory.addInventoryStock("inventory-1", 10, "staff-1");
  assert.equal(first.currentQuantity, 10);
  assert.equal(first.replenishmentCycle, 1);
  assert.equal(table("notifications").has("inventory_replenished_inventory-1_1_admin-1"), true);
  assert.equal(table("notifications").has("inventory_replenished_inventory-1_1_staff-inactive"), false);

  await Promise.all([
    inventory.addInventoryStock("inventory-1", 2, "staff-1"),
    inventory.addInventoryStock("inventory-1", 3, "staff-1"),
  ]);
  assert.equal(table("seedlingInventory").get("inventory-1").currentQuantity, 15);
  assert.equal(table("seedlingInventory").get("inventory-1").replenishmentCycle, 3);
  assert.equal([...table("notifications")].filter(([id]) => id.startsWith("inventory_replenished_")).length, 6);
});

test("failed inventory operations roll back without creating alerts", async () => {
  await assert.rejects(inventory.addInventoryStock("missing", 5, "staff-1"), /Inventory not found/);
  assert.equal(table("notifications").size, 0);
});
