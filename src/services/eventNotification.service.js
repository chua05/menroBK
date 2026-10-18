const crypto = require("crypto");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { eventScheduleStatus } = require("../utils/eventStatus.util");
const { getRoleRecipientsInTransaction, createNotificationInTransaction } = require("./notification.service");
const { DEFAULT_BUDGET, processBoundedCollection } = require("../utils/boundedWorker.util");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function scheduleOf(event = {}) {
  return { date: clean(event.date), startTime: clean(event.startTime), endTime: clean(event.endTime) };
}

function scheduleKey(event = {}) {
  const schedule = scheduleOf(event);
  return crypto.createHash("sha256")
    .update(`${schedule.date}|${schedule.startTime}|${schedule.endTime || "23:59"}`)
    .digest("hex").slice(0, 16);
}

function scheduleText(event = {}) {
  const schedule = scheduleOf(event);
  return `${schedule.date} ${schedule.startTime}${schedule.endTime ? `-${schedule.endTime}` : ""}`.trim();
}

function manilaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function calendarDayDifference(fromDate, toDate) {
  const from = new Date(`${fromDate}T12:00:00Z`);
  const to = new Date(`${toDate}T12:00:00Z`);
  return Math.round((to - from) / DAY_MS);
}

function eventLocation(event = {}) {
  return clean(event.plantingSiteName) || clean(event.location) || clean(event.barangay) || "the scheduled site";
}

function notificationData({ eventId, event, recipientUserId, kind, previousSchedule }) {
  const name = clean(event.name) || "Planting event";
  const currentSchedule = scheduleText(event);
  const location = eventLocation(event);
  const copy = {
    scheduled: ["Event Scheduled", `${name} is scheduled for ${currentSchedule} at ${location}.`],
    reminder_3_day: ["Event Reminder", `${name} is scheduled in 3 days: ${currentSchedule} at ${location}.`],
    reminder_1_day: ["Event Reminder", `${name} is scheduled tomorrow: ${currentSchedule} at ${location}.`],
    reminder_same_day: ["Event Reminder", `${name} is scheduled today at ${currentSchedule} at ${location}.`],
    starting: ["Scheduled Event Starting", `${name}: your scheduled planting event is starting.`],
    ended: ["Scheduled Event Time Ended", `${name}: the scheduled time for this planting event has ended.`],
    rescheduled: ["Event Rescheduled", `${name} was rescheduled from ${scheduleText(previousSchedule)} to ${currentSchedule} at ${location}.`],
  }[kind];
  const idSchedule = kind === "rescheduled"
    ? `${scheduleKey(previousSchedule)}_${scheduleKey(event)}` : scheduleKey(event);
  return {
    notificationId: `event_${kind}_${eventId}_${idSchedule}_${recipientUserId}`,
    recipientUserId,
    type: `event_${kind}`,
    title: copy[0], message: copy[1],
    relatedRecordType: "event", relatedRecordId: eventId, relatedEventId: eventId,
    createdAt: Timestamp.now(),
    details: {
      eventName: name, barangay: clean(event.barangay), location,
      schedule: scheduleOf(event),
      ...(previousSchedule ? { previousSchedule: scheduleOf(previousSchedule) } : {}),
    },
  };
}

async function activeRegisteredRecipients(transaction, eventId, event) {
  const [staff, participants, requestDoc] = await Promise.all([
    getRoleRecipientsInTransaction(transaction, ["staff"]),
    transaction.get(db.collection("eventParticipants").where("eventId", "==", eventId)),
    event.sourceRequestId
      ? transaction.get(db.collection("seedlingRequests").doc(event.sourceRequestId))
      : Promise.resolve(null),
  ]);
  const ids = new Set(staff.map((recipient) => recipient.id));
  participants.docs.forEach((doc) => {
    const userId = clean(doc.data().userId);
    if (userId) ids.add(userId);
  });
  [event.createdBy, event.organizerUserId, requestDoc?.exists ? requestDoc.data().participantId : ""]
    .map(clean).filter(Boolean).forEach((id) => ids.add(id));

  const userDocs = await Promise.all([...ids].map((id) => transaction.get(db.collection("users").doc(id))));
  return userDocs
    .filter((doc) => doc.exists && doc.data().status !== "inactive")
    .map((doc) => doc.id);
}

function writeNotifications(transaction, { eventId, event, recipientIds, kind, previousSchedule, exclude = [] }) {
  const excluded = new Set(exclude.filter(Boolean));
  [...new Set(recipientIds)].filter((id) => !excluded.has(id)).forEach((recipientUserId) => {
    createNotificationInTransaction(transaction, notificationData({
      eventId, event, recipientUserId, kind, previousSchedule,
    }));
  });
}

function dueMilestone(event, now = new Date()) {
  const status = eventScheduleStatus(event, now);
  if (!status.scheduleValid || event.archived === true) return null;
  // A bounded grace window tolerates a temporarily delayed worker without
  // flooding users with historical completion notices on first activation.
  if (status.status === "Completed") {
    return now.getTime() - status.end.getTime() <= DAY_MS ? "ended" : null;
  }
  if (status.status === "Ongoing") return "starting";
  const days = calendarDayDifference(manilaDate(now), event.date);
  if (days === 3) return "reminder_3_day";
  if (days === 1) return "reminder_1_day";
  if (days === 0 && now < status.start) return "reminder_same_day";
  return null;
}

async function processEventCalendarNotifications(options = {}) {
  const now = options.now || new Date();
  const budget = options.budget ?? options.limit ?? DEFAULT_BUDGET;
  const pageSize = options.pageSize ?? DEFAULT_LIMIT;
  return processBoundedCollection({
    db,
    workerId: "event-calendar-notifications",
    collectionName: "events",
    budget,
    pageSize,
    async processDocument(snapshot) {
    try {
      let outcome = "skipped";
      await db.runTransaction(async (transaction) => {
        const currentDoc = await transaction.get(snapshot.ref);
        if (!currentDoc.exists) return;
        const event = currentDoc.data();
        const kind = dueMilestone(event, now);
        if (!kind) return;
        const recipientIds = await activeRegisteredRecipients(transaction, currentDoc.id, event);
        const notifications = recipientIds.map((recipientUserId) => notificationData({
          eventId: currentDoc.id, event, recipientUserId, kind,
        }));
        const existing = await Promise.all(notifications.map((item) =>
          transaction.get(db.collection("notifications").doc(item.notificationId))));
        notifications.forEach((item, index) => {
          if (!existing[index].exists) createNotificationInTransaction(transaction, item);
        });
        outcome = existing.every((doc) => doc.exists) ? "duplicate" : "notified";
      });
      return { eventId: snapshot.id, outcome };
    } catch (error) {
      if (error.code === 6 || error.code === "already-exists") {
        return { eventId: snapshot.id, outcome: "duplicate" };
      }
      throw error;
    }
    },
  });
}

module.exports = {
  scheduleOf, scheduleKey, scheduleText, manilaDate, dueMilestone,
  activeRegisteredRecipients, writeNotifications, processEventCalendarNotifications,
};
