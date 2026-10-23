const { db } = require("../config/firebase");
const { FieldPath, Timestamp } = require("firebase-admin/firestore");

const collection = db.collection("notifications");

function createNotificationInTransaction(transaction, data) {
  if (!data.recipientUserId) {
    throw new Error("Notification recipient is missing.");
  }
  const ref = collection.doc(
    data.notificationId || `${data.type}_${data.relatedRecordId}`
  );
  transaction.create(ref, {
    recipientUserId: data.recipientUserId,
    title: data.title,
    message: data.message,
    type: data.type,
    relatedRecordType: data.relatedRecordType,
    relatedRecordId: data.relatedRecordId,
    ...(data.relatedSubrecordId ? { relatedSubrecordId: data.relatedSubrecordId } : {}),
    ...(data.requestNumber ? { requestNumber: data.requestNumber } : {}),
    ...(data.reason ? { reason: data.reason } : {}),
    ...(data.returnedAt ? { returnedAt: data.returnedAt } : {}),
    ...(data.relatedEventId ? { relatedEventId: data.relatedEventId } : {}),
    ...(data.relatedDistributionId ? { relatedDistributionId: data.relatedDistributionId } : {}),
    ...(data.details && typeof data.details === "object" ? { details: data.details } : {}),
    isRead: false,
    createdAt: data.createdAt || Timestamp.now(),
    readAt: null,
  });
  return ref.id;
}

async function getRoleRecipientsInTransaction(transaction, roles) {
  const snapshots = await Promise.all(
    roles.map((role) => transaction.get(db.collection("users").where("role", "==", role)))
  );
  const recipients = new Map();
  snapshots.forEach((snapshot) => snapshot.docs.forEach((doc) => {
    const user = doc.data();
    if (user.status !== "inactive") recipients.set(doc.id, user);
  }));
  return [...recipients.entries()].map(([id, user]) => ({ id, ...user }));
}

async function createRoleNotificationsInTransaction(transaction, roles, data) {
  const recipients = await getRoleRecipientsInTransaction(transaction, roles);
  recipients.forEach((recipient) => createNotificationInTransaction(transaction, {
    ...data,
    recipientUserId: recipient.id,
    notificationId: `${data.notificationId || `${data.type}_${data.relatedRecordId}`}_${recipient.id}`,
  }));
  return recipients.length;
}

async function createLowStockNotificationsInTransaction(transaction, data) {
  return createRoleNotificationsInTransaction(transaction, ["admin", "staff"], {
    notificationId: `low_stock_${data.inventoryId}_${data.cycle || 1}`,
    type: "inventory_low_stock",
    title: "Low Seedling Stock",
    message: `${data.species} has reached the low-stock level. Current available stock: ${data.availableQuantity} seedlings.`,
    relatedRecordType: "inventory",
    relatedRecordId: data.inventoryId,
    createdAt: data.createdAt,
    details: {
      species: data.species,
      availableQuantity: data.availableQuantity,
      lowStockThreshold: data.lowStockThreshold,
    },
  });
}

async function createOutOfStockNotificationsInTransaction(transaction, data, recipients = null) {
  const notification = {
    notificationId: `out_of_stock_${data.inventoryId}_${data.cycle}`,
    type: "inventory_out_of_stock",
    title: "Seedling Stock Depleted",
    message: `${data.species} is now out of stock. Current available stock: 0 seedlings.`,
    relatedRecordType: "inventory",
    relatedRecordId: data.inventoryId,
    createdAt: data.createdAt,
    details: {
      species: data.species,
      inventoryReference: data.inventoryReference || data.inventoryId,
      availableQuantity: 0,
    },
  };
  if (!recipients) return createRoleNotificationsInTransaction(transaction, ["admin", "staff"], notification);
  const unique = [...new Map(recipients.map((recipient) => [recipient.id, recipient])).values()];
  unique.forEach((recipient) => createNotificationInTransaction(transaction, {
    ...notification,
    recipientUserId: recipient.id,
    notificationId: `${notification.notificationId}_${recipient.id}`,
  }));
  return unique.length;
}

async function createReplenishmentNotificationsInTransaction(transaction, data) {
  return createRoleNotificationsInTransaction(transaction, ["admin", "staff"], {
    notificationId: `inventory_replenished_${data.inventoryId}_${data.cycle}`,
    type: "inventory_replenished",
    title: "Seedling Stock Replenished",
    message: `${data.species} received ${data.quantityAdded} seedlings. Updated available stock: ${data.availableQuantity}.`,
    relatedRecordType: "inventory",
    relatedRecordId: data.inventoryId,
    createdAt: data.createdAt,
    details: {
      species: data.species,
      inventoryReference: data.inventoryReference || data.inventoryId,
      quantityAdded: data.quantityAdded,
      availableQuantity: data.availableQuantity,
    },
  });
}

async function createDistributionNotificationsInTransaction(transaction, recipients, data) {
  [...new Map(recipients.map((recipient) => [recipient.id, recipient])).values()]
    .forEach((recipient) => createNotificationInTransaction(transaction, {
      notificationId: `distribution_completed_${data.distributionId}_${recipient.id}`,
      recipientUserId: recipient.id,
      type: "distribution_completed",
      title: "Seedling Distribution Completed",
      message: `${data.requestNumber || data.distributionId} released ${data.totalQuantityReleased} seedlings${data.speciesSummary ? ` (${data.speciesSummary})` : ""}.`,
      relatedRecordType: "distribution",
      relatedRecordId: data.distributionId,
      relatedDistributionId: data.distributionId,
      requestNumber: data.requestNumber || "",
      createdAt: data.createdAt,
      details: {
        requestId: data.requestId,
        requestNumber: data.requestNumber || "",
        distributionId: data.distributionId,
        totalQuantityReleased: data.totalQuantityReleased,
        releasedAt: data.createdAt,
        releasedItems: data.releasedItems,
      },
    }));
}

const NOTIFICATION_PAGE_SIZE = 20;
const MAX_NOTIFICATION_PAGE_SIZE = 50;
function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isFinite(decoded.createdAtMillis) || !decoded.id) throw new Error();
    return decoded;
  } catch {
    const error = new Error("Invalid notification cursor.");
    error.code = "INVALID_CURSOR";
    throw error;
  }
}

function encodeCursor(item) {
  const createdAtMillis = item.createdAt?.toMillis?.();
  if (!Number.isFinite(createdAtMillis) || !item.id) return null;
  return Buffer.from(JSON.stringify({ createdAtMillis, id: item.id })).toString("base64url");
}

function notificationQuery(userId, { readState = "all", cursor, limit } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || NOTIFICATION_PAGE_SIZE, 1), MAX_NOTIFICATION_PAGE_SIZE);
  let query = collection.where("recipientUserId", "==", userId);
  if (readState === "unread") query = query.where("isRead", "==", false);
  if (readState === "read") query = query.where("isRead", "==", true);
  query = query.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
  const decodedCursor = parseCursor(cursor);
  if (decodedCursor) query = query.startAfter(Timestamp.fromMillis(decodedCursor.createdAtMillis), decodedCursor.id);
  return { query: query.limit(pageSize + 1), pageSize };
}

async function hydrateNotifications(docs) {
  const items = docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const refs = new Map();
  items.forEach((item) => {
    if (item.relatedRecordType === "seedlingRequest" && item.relatedRecordId) {
      refs.set(`request:${item.relatedRecordId}`, db.collection("seedlingRequests").doc(item.relatedRecordId));
    }
    if (item.relatedEventId) {
      refs.set(`event:${item.relatedEventId}`, db.collection("events").doc(item.relatedEventId));
      refs.set(`invitation:${item.relatedEventId}`, db.collection("eventInvitations").doc(item.relatedEventId));
    }
  });
  const entries = [...refs.entries()];
  const snapshots = entries.length ? await db.getAll(...entries.map(([, ref]) => ref)) : [];
  const related = new Map(entries.map(([key], index) => [key, snapshots[index]]));
  return items.map((item) => {
    const requestDoc = related.get(`request:${item.relatedRecordId}`);
    const eventDoc = related.get(`event:${item.relatedEventId}`);
    const invitationDoc = related.get(`invitation:${item.relatedEventId}`);
    return {
      ...item,
      requestNumber: item.requestNumber || (requestDoc?.exists ? requestDoc.data().requestNumber || "" : ""),
      event: item.event || (eventDoc?.exists ? {
        id: eventDoc.id,
        name: eventDoc.data().name || "",
        date: eventDoc.data().date || "",
        location: eventDoc.data().location || eventDoc.data().plantingSiteName || "",
      } : null),
      hasGuestInvitation: invitationDoc?.exists && invitationDoc.data().active === true,
    };
  });
}

async function getUnreadCount(userId) {
  const snapshot = await collection
    .where("recipientUserId", "==", userId)
    .where("isRead", "==", false)
    .get();
  return snapshot.size;
}

async function getMyNotifications(userId, options = {}) {
  const { query, pageSize } = notificationQuery(userId, options);
  const [snapshot, unreadCount] = await Promise.all([query.get(), getUnreadCount(userId)]);
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const notifications = await hydrateNotifications(pageDocs);
  return {
    notifications,
    unreadCount,
    hasMore: snapshot.docs.length > pageSize,
    nextCursor: snapshot.docs.length > pageSize
      ? encodeCursor(notifications[notifications.length - 1])
      : null,
  };
}

async function markNotificationRead(id, userId) {
  const ref = collection.doc(id);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists || doc.data().recipientUserId !== userId) {
      throw new Error("Notification not found.");
    }
    if (!doc.data().isRead) {
      transaction.update(ref, { isRead: true, readAt: Timestamp.now() });
    }
  });
  const doc = await ref.get();
  return { id: doc.id, ...doc.data() };
}

async function markAllNotificationsRead(userId) {
  const refs = [];
  let lastId = null;
  do {
    let query = collection
      .where("recipientUserId", "==", userId)
      .where("isRead", "==", false)
      .orderBy(FieldPath.documentId())
      .limit(400);
    if (lastId) query = query.startAfter(lastId);
    const snapshot = await query.get();
    refs.push(...snapshot.docs.map((doc) => doc.ref));
    lastId = snapshot.size === 400 ? snapshot.docs[snapshot.docs.length - 1].id : null;
  } while (lastId);

  let updatedCount = 0;
  for (let index = 0; index < refs.length; index += 400) {
    const batchRefs = refs.slice(index, index + 400);
    try {
      const batchUpdated = await db.runTransaction(async (transaction) => {
        const snapshots = await Promise.all(batchRefs.map((ref) => transaction.get(ref)));
        const readAt = Timestamp.now();
        let count = 0;
        snapshots.forEach((doc, itemIndex) => {
          if (doc.exists && doc.data().recipientUserId === userId && !doc.data().isRead) {
            transaction.update(batchRefs[itemIndex], { isRead: true, readAt });
            count += 1;
          }
        });
        return count;
      });
      updatedCount += batchUpdated;
    } catch (error) {
      error.updatedCount = updatedCount;
      error.code = "MARK_ALL_PARTIAL_FAILURE";
      throw error;
    }
  }
  return { updatedCount, unreadCount: await getUnreadCount(userId) };
}

module.exports = {
  createNotificationInTransaction,
  getRoleRecipientsInTransaction,
  createRoleNotificationsInTransaction,
  createLowStockNotificationsInTransaction,
  createOutOfStockNotificationsInTransaction,
  createReplenishmentNotificationsInTransaction,
  createDistributionNotificationsInTransaction,
  getMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  parseCursor,
};
