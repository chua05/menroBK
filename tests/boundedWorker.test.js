const assert = require("node:assert/strict");
const test = require("node:test");

const collections = new Map();
function table(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}
function ref(name, id) {
  return { id, async get() {
    const value = table(name).get(id);
    return { id, exists: value !== undefined, data: () => value };
  } };
}
function query(name, cursor = null, maximum = Infinity) {
  return {
    orderBy() { return query(name, cursor, maximum); },
    startAfter(id) { return query(name, id, maximum); },
    limit(value) { return query(name, cursor, value); },
    async get() {
      const docs = [...table(name)]
        .filter(([id]) => !cursor || id > cursor)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, maximum)
        .map(([id, value]) => ({ id, ref: ref(name, id), data: () => value }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
}
const db = {
  collection(name) { return { ...query(name), doc: (id) => ref(name, id) }; },
  async runTransaction(callback) {
    return callback({
      get: (target) => target.get(),
      set: (target, value) => table("workerCheckpoints").set(target.id, value),
    });
  },
};

const { processBoundedCollection } = require("../src/utils/boundedWorker.util");

test.beforeEach(() => collections.clear());

test("bounded scans continue from a stable document-id cursor and wrap", async () => {
  for (let index = 0; index < 205; index += 1) {
    table("records").set(String(index).padStart(3, "0"), { sameTimestamp: 1 });
  }
  const seen = [];
  const run = () => processBoundedCollection({
    db, workerId: "bounded-test", collectionName: "records", budget: 100, pageSize: 17,
    processDocument: async (document) => { seen.push(document.id); return { recordId: document.id }; },
  });
  const first = await run();
  const second = await run();
  const third = await run();
  assert.equal(first.summary.budgetExhausted, true);
  assert.equal(second.summary.budgetExhausted, true);
  assert.equal(third.summary.reachedEnd, true);
  assert.equal(seen.length, 205);
  assert.equal(new Set(seen).size, 205);
  assert.equal(table("workerCheckpoints").get("bounded-test").cursorId, null);
});

test("a record failure is isolated, reported, and does not block later records", async () => {
  for (const id of ["001", "002", "003"]) table("records").set(id, {});
  const completed = [];
  const results = await processBoundedCollection({
    db, workerId: "failure-test", collectionName: "records", budget: 10, pageSize: 2,
    processDocument: async (document) => {
      if (document.id === "002") throw new Error("synthetic recoverable failure");
      completed.push(document.id);
      return { recordId: document.id };
    },
  });
  assert.deepEqual(completed, ["001", "003"]);
  assert.deepEqual(results.summary.failures.map((item) => item.recordId), ["002"]);
  assert.equal(results.find((item) => item.recordId === "002").outcome, "failed");
});

test("concurrent scans never move a checkpoint backward", async () => {
  for (let index = 0; index < 30; index += 1) table("records").set(String(index).padStart(2, "0"), {});
  const run = () => processBoundedCollection({
    db, workerId: "concurrent-test", collectionName: "records", budget: 10, pageSize: 4,
    processDocument: async (document) => ({ recordId: document.id }),
  });
  const [left, right] = await Promise.all([run(), run()]);
  assert.equal(left.length, 10);
  assert.equal(right.length, 10);
  assert.equal(table("workerCheckpoints").get("concurrent-test").cursorId, "09");
});
