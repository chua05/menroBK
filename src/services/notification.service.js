const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

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
    ...(data.requestNumber ? { requestNumber: data.requestNumber } : {}),
    ...(data.reason ? { reason: data.reason } : {}),
    ...(data.returnedAt ? { returnedAt: data.returnedAt } : {}),
    ...(data.relatedEventId ? { relatedEventId: data.relatedEventId } : {}),
    ...(data.relatedDistributionId ? { relatedDistributionId: data.relatedDistributionId } : {}),
    isRead: false,
    createdAt: data.createdAt || Timestamp.now(),
    readAt: null,
  });
  return ref.id;
}

async function getMyNotifications(userId) {
  const snapshot = await collection.where("recipientUserId", "==", userId).get();
  const items = await Promise.all(snapshot.docs.map(async (doc) => {
    const item = { id: doc.id, ...doc.data() };
    const [requestDoc, eventDoc, invitationDoc] = await Promise.all([
      item.relatedRecordType === "seedlingRequest" && item.relatedRecordId
        ? db.collection("seedlingRequests").doc(item.relatedRecordId).get() : Promise.resolve(null),
      item.relatedEventId ? db.collection("events").doc(item.relatedEventId).get() : Promise.resolve(null),
      item.relatedEventId ? db.collection("eventInvitations").doc(item.relatedEventId).get() : Promise.resolve(null),
    ]);
    return {
      ...item,
      requestNumber: requestDoc?.exists ? requestDoc.data().requestNumber || "" : "",
      event: eventDoc?.exists ? {
        id: eventDoc.id,
        name: eventDoc.data().name || "",
        date: eventDoc.data().date || "",
        location: eventDoc.data().location || eventDoc.data().plantingSiteName || "",
      } : null,
      hasGuestInvitation: invitationDoc?.exists && invitationDoc.data().active === true,
    };
  }));
  return items.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
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

module.exports = { createNotificationInTransaction, getMyNotifications, markNotificationRead };
