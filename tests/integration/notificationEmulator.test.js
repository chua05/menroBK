const assert = require("node:assert/strict");
const test = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

validateIntegrationEnvironment();
const { db } = require("../../src/config/firebase");
const service = require("../../src/services/notification.service");

const collection = db.collection("notifications");
const PREFIX = "notification-acceptance-";
const USER_A = "notification-acceptance-user-a";
const USER_B = "notification-acceptance-user-b";

async function cleanup() {
  const snapshot = await collection.get();
  const refs = snapshot.docs.filter((doc) => doc.id.startsWith(PREFIX)).map((doc) => doc.ref);
  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = db.batch();
    refs.slice(offset, offset + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

async function seed() {
  await cleanup();
  const writes = [];
  for (let index = 0; index < 425; index += 1) {
    writes.push({
      ref: collection.doc(`${PREFIX}a-${String(index).padStart(3, "0")}`),
      data: {
        recipientUserId: USER_A,
        title: `Acceptance notification ${index}`,
        message: `Synthetic emulator record ${index}`,
        type: "notification_acceptance",
        relatedRecordType: index % 2 ? "monitoring" : "seedlingRequest",
        relatedRecordId: `record-${index}`,
        isRead: index === 0,
        readAt: index === 0 ? Timestamp.fromMillis(1_000) : null,
        createdAt: Timestamp.fromMillis(1_000_000 + index),
        testFixture: true,
      },
    });
  }
  writes.push({ ref: collection.doc(`${PREFIX}b-private`), data: {
    recipientUserId: USER_B, title: "Private", message: "Other recipient",
    type: "notification_acceptance", relatedRecordType: "monitoring", relatedRecordId: "private",
    isRead: false, readAt: null, createdAt: Timestamp.fromMillis(2_000_000), testFixture: true,
  } });
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    writes.slice(offset, offset + 400).forEach(({ ref, data }) => batch.set(ref, data));
    await batch.commit();
  }
}

test.before(seed);
test.after(cleanup);

test("real Firestore pagination is stable, ordered, duplicate-free, and recipient-only", async () => {
  const ids = [];
  let cursor = null;
  do {
    const page = await service.getMyNotifications(USER_A, { limit: 37, cursor });
    ids.push(...page.notifications.map((item) => item.id));
    assert.equal(page.notifications.every((item) => item.recipientUserId === USER_A), true);
    assert.equal(page.unreadCount, 424);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 425);
  assert.equal(new Set(ids).size, 425);
  assert.equal(ids[0], `${PREFIX}a-424`);
  assert.equal(ids.at(-1), `${PREFIX}a-000`);
});

test("real Firestore read filters and single-record ownership remain enforced", async () => {
  const read = await service.getMyNotifications(USER_A, { readState: "read", limit: 20 });
  assert.deepEqual(read.notifications.map((item) => item.id), [`${PREFIX}a-000`]);
  await assert.rejects(service.markNotificationRead(`${PREFIX}b-private`, USER_A), /Notification not found/);
  const updated = await service.markNotificationRead(`${PREFIX}a-424`, USER_A);
  assert.equal(updated.isRead, true);
});

test("mark all processes more than 400 records and remains recipient-scoped", async () => {
  const result = await service.markAllNotificationsRead(USER_A);
  assert.equal(result.updatedCount, 423);
  assert.equal(result.unreadCount, 0);
  assert.equal((await collection.doc(`${PREFIX}b-private`).get()).data().isRead, false);
});

test("deterministic create rejects duplicates and failed transactions roll back", async () => {
  const duplicateRef = collection.doc(`${PREFIX}deterministic`);
  const data = { notificationId: duplicateRef.id, recipientUserId: USER_A,
    title: "Deterministic", message: "One record", type: "acceptance",
    relatedRecordType: "monitoring", relatedRecordId: "deterministic", createdAt: Timestamp.now() };
  await db.runTransaction(async (transaction) => service.createNotificationInTransaction(transaction, data));
  await assert.rejects(db.runTransaction(async (transaction) =>
    service.createNotificationInTransaction(transaction, data)));
  await assert.rejects(db.runTransaction(async (transaction) => {
    service.createNotificationInTransaction(transaction, { ...data,
      notificationId: `${PREFIX}rollback`, relatedRecordId: "rollback" });
    throw new Error("force rollback");
  }), /force rollback/);
  assert.equal((await collection.doc(`${PREFIX}rollback`).get()).exists, false);
});
