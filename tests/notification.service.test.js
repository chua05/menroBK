const assert = require("node:assert/strict");
const test = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");

const collections = new Map();
function table(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}
function reference(name, id) {
  return { id, collectionName: name, async get() { return snapshot(name, id, table(name).get(id)); } };
}
function snapshot(name, id, value) {
  return { id, ref: reference(name, id), exists: value !== undefined, data: () => value };
}
function millis(value) { return value?.toMillis?.() ?? Number(value || 0); }
function queryFor(name, state = {}) {
  const next = (change) => queryFor(name, { ...state, ...change });
  return {
    where(field, operator, value) { return next({ filters: [...(state.filters || []), { field, operator, value }] }); },
    orderBy(field, direction) {
      return next({ orders: [...(state.orders || []), { field: typeof field === "string" ? field : "__name__", direction }] });
    },
    startAfter(...values) { return next({ cursor: values }); },
    limit(value) { return next({ maximum: value }); },
    count() { return { async get() { const result = await queryFor(name, state).get(); return { data: () => ({ count: result.size }) }; } }; },
    async get() {
      let rows = [...table(name)].map(([id, value]) => ({ id, value }));
      for (const filter of state.filters || []) {
        rows = rows.filter((row) => {
          const actual = row.value[filter.field];
          if (filter.operator === "==") return actual === filter.value;
          if (filter.operator === "in") return filter.value.includes(actual);
          if (filter.operator === "<=") return millis(actual) <= millis(filter.value);
          throw new Error(`Unsupported mock operator ${filter.operator}`);
        });
      }
      const orders = state.orders || [];
      rows.sort((left, right) => {
        for (const order of orders) {
          const leftValue = order.field === "__name__" ? left.id : left.value[order.field];
          const rightValue = order.field === "__name__" ? right.id : right.value[order.field];
          const compared = order.field === "createdAt"
            ? millis(leftValue) - millis(rightValue)
            : String(leftValue).localeCompare(String(rightValue));
          if (compared) return order.direction === "desc" ? -compared : compared;
        }
        return 0;
      });
      if (state.cursor) {
        const [cursorTime, cursorId] = state.cursor;
        rows = rows.filter((row) => {
          const time = millis(row.value.createdAt);
          return time < millis(cursorTime) || (time === millis(cursorTime) && row.id < cursorId);
        });
      }
      if (state.maximum) rows = rows.slice(0, state.maximum);
      const docs = rows.map(({ id, value }) => snapshot(name, id, value));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
}

const db = {
  collection(name) { return { ...queryFor(name), doc(id) { return reference(name, id); } }; },
  async getAll(...refs) { return Promise.all(refs.map((ref) => ref.get())); },
  async runTransaction(callback) {
    const writes = [];
    const result = await callback({ get: (ref) => ref.get(), update: (ref, value) => writes.push([ref, value]) });
    writes.forEach(([ref, value]) => table(ref.collectionName).set(ref.id, { ...table(ref.collectionName).get(ref.id), ...value }));
    return result;
  },
  batch() {
    const writes = [];
    return {
      update(ref, value) { writes.push([ref, value]); },
      async commit() { writes.forEach(([ref, value]) => table(ref.collectionName).set(ref.id, { ...table(ref.collectionName).get(ref.id), ...value })); },
    };
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const { getMyNotifications, markAllNotificationsRead, markNotificationRead, parseCursor } =
  require("../src/services/notification.service");

test.beforeEach(() => collections.clear());
function notice(id, overrides = {}) {
  table("notifications").set(id, {
    recipientUserId: "user-a", relatedRecordType: "seedlingRequest", relatedRecordId: `record-${id}`,
    isRead: false, createdAt: Timestamp.fromMillis(1_000), ...overrides,
  });
}

test("retrieval is recipient-scoped, newest-first, cursor-paginated, and globally counts unread", async () => {
  notice("a", { createdAt: Timestamp.fromMillis(3_000) });
  notice("b", { createdAt: Timestamp.fromMillis(2_000), isRead: true });
  notice("c", { createdAt: Timestamp.fromMillis(1_000) });
  notice("other", { recipientUserId: "user-b", createdAt: Timestamp.fromMillis(4_000) });
  const first = await getMyNotifications("user-a", { limit: 2 });
  assert.deepEqual(first.notifications.map((item) => item.id), ["a", "b"]);
  assert.equal(first.unreadCount, 2);
  assert.equal(first.hasMore, true);
  assert.deepEqual(parseCursor(first.nextCursor), { createdAtMillis: 2_000, id: "b" });
  const second = await getMyNotifications("user-a", { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.notifications.map((item) => item.id), ["c"]);
  assert.equal(second.hasMore, false);
});

test("read-state filtering keeps every module visible across same-time cursor pages", async () => {
  notice("z", { relatedRecordType: "inventory" });
  notice("y", { relatedRecordType: "distribution" });
  notice("x", { relatedRecordType: "monitoring" });
  const first = await getMyNotifications("user-a", { readState: "unread", limit: 1 });
  assert.deepEqual(first.notifications.map((item) => item.id), ["z"]);
  const second = await getMyNotifications("user-a", { readState: "unread", limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.notifications.map((item) => item.id), ["y"]);
});

test("new arrivals refresh independently of the existing pagination cursor", async () => {
  notice("old-2", { createdAt: Timestamp.fromMillis(2_000) });
  notice("old-1", { createdAt: Timestamp.fromMillis(1_000) });
  const first = await getMyNotifications("user-a", { limit: 1 });
  notice("new", { createdAt: Timestamp.fromMillis(3_000) });
  const refresh = await getMyNotifications("user-a", { limit: 1 });
  const nextOldPage = await getMyNotifications("user-a", { limit: 1, cursor: first.nextCursor });
  assert.equal(refresh.notifications[0].id, "new");
  assert.equal(nextOldPage.notifications[0].id, "old-1");
});

test("only the recipient can mark one notification read", async () => {
  notice("notice-a", { relatedRecordType: "plantingReport" });
  await assert.rejects(markNotificationRead("notice-a", "user-b"), /Notification not found/);
  assert.equal(table("notifications").get("notice-a").isRead, false);
  const updated = await markNotificationRead("notice-a", "user-a");
  assert.equal(updated.isRead, true);
  assert.ok(updated.readAt);
});

test("mark all updates only unread notifications for the authenticated recipient", async () => {
  notice("one");
  notice("two", { isRead: true });
  notice("other", { recipientUserId: "user-b" });
  const result = await markAllNotificationsRead("user-a");
  assert.equal(result.updatedCount, 1);
  assert.equal(result.unreadCount, 0);
  assert.equal(table("notifications").get("one").isRead, true);
  assert.equal(table("notifications").get("other").isRead, false);
});

test("invalid cursors fail safely", async () => {
  await assert.rejects(getMyNotifications("user-a", { cursor: "not-a-cursor" }), /Invalid notification cursor/);
});
