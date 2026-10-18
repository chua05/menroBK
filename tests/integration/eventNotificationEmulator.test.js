const test = require("node:test");
const assert = require("node:assert/strict");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

validateIntegrationEnvironment();
const { db } = require("../../src/config/firebase");
const {
  processEventCalendarNotifications,
  scheduleKey,
} = require("../../src/services/eventNotification.service");

const PREFIX = "event-acceptance-";
const EVENT_ID = `${PREFIX}milestones`;
const REQUEST_ID = `${PREFIX}request`;
const ACTIVE_STAFF = `${PREFIX}staff`;
const INACTIVE_STAFF = `${PREFIX}inactive-staff`;
const PARTICIPANT = `${PREFIX}participant`;

async function deleteMatching(collectionName, predicate) {
  const snapshot = await db.collection(collectionName).get();
  const refs = snapshot.docs.filter(predicate).map((doc) => doc.ref);
  while (refs.length) {
    const batch = db.batch();
    refs.splice(0, 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

async function cleanup() {
  await deleteMatching("notifications", (doc) =>
    doc.id.startsWith("event_") && String(doc.data().relatedRecordId || "").startsWith(PREFIX));
  await deleteMatching("eventParticipants", (doc) =>
    String(doc.data().eventId || "").startsWith(PREFIX));
  await deleteMatching("events", (doc) => doc.id.startsWith(PREFIX));
  await Promise.all([
    db.collection("workerCheckpoints").doc("event-calendar-notifications").delete(),
    db.collection("seedlingRequests").doc(REQUEST_ID).delete(),
    db.collection("users").doc(ACTIVE_STAFF).delete(),
    db.collection("users").doc(INACTIVE_STAFF).delete(),
    db.collection("users").doc(PARTICIPANT).delete(),
  ]);
}

async function seed() {
  await cleanup();
  const batch = db.batch();
  batch.set(db.collection("users").doc(ACTIVE_STAFF), {
    role: "staff", status: "active", testFixture: true,
  });
  batch.set(db.collection("users").doc(INACTIVE_STAFF), {
    role: "staff", status: "inactive", testFixture: true,
  });
  batch.set(db.collection("users").doc(PARTICIPANT), {
    role: "participant", status: "active", testFixture: true,
  });
  batch.set(db.collection("seedlingRequests").doc(REQUEST_ID), {
    participantId: PARTICIPANT, testFixture: true,
  });
  batch.set(db.collection("events").doc(EVENT_ID), {
    name: "Acceptance Planting Event", date: "2026-10-20",
    startTime: "09:00", endTime: "11:00", barangay: "Bical",
    plantingSiteName: "Acceptance Site", createdBy: ACTIVE_STAFF,
    sourceRequestId: REQUEST_ID, archived: false, testFixture: true,
  });
  batch.set(db.collection("eventParticipants").doc(`${PREFIX}registration`), {
    eventId: EVENT_ID, userId: PARTICIPANT, testFixture: true,
  });
  await batch.commit();
}

async function notificationsFor(eventId = EVENT_ID) {
  const snapshot = await db.collection("notifications")
    .where("relatedRecordId", "==", eventId).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function activeStaffIds() {
  const snapshot = await db.collection("users").where("role", "==", "staff").get();
  return snapshot.docs
    .filter((doc) => String(doc.data().status || "active").toLowerCase() === "active")
    .map((doc) => doc.id)
    .sort();
}

test.beforeEach(seed);
test.after(cleanup);

test("actual worker query emits every Manila milestone once for active recipients", async () => {
  const expectedRecipients = [...await activeStaffIds(), PARTICIPANT].sort();
  const runs = [
    ["2026-10-16T16:00:00Z", "event_reminder_3_day"],
    ["2026-10-18T16:00:00Z", "event_reminder_1_day"],
    ["2026-10-19T23:00:00Z", "event_reminder_same_day"],
    ["2026-10-20T01:00:00Z", "event_starting"],
    ["2026-10-20T03:01:00Z", "event_ended"],
  ];
  for (const [instant, type] of runs) {
    const [first, concurrent] = await Promise.all([
      processEventCalendarNotifications({ now: new Date(instant) }),
      processEventCalendarNotifications({ now: new Date(instant) }),
    ]);
    assert.ok(first.some((result) => result.eventId === EVENT_ID));
    assert.ok(concurrent.some((result) => result.eventId === EVENT_ID));
    const matching = (await notificationsFor()).filter((item) => item.type === type);
    assert.equal(matching.length, expectedRecipients.length);
    assert.deepEqual(matching.map((item) => item.recipientUserId).sort(),
      expectedRecipients);
    assert.ok(matching.every((item) => item.relatedEventId === EVENT_ID));
  }
  assert.equal((await notificationsFor()).length, 5 * expectedRecipients.length);
});

test("rescheduling changes schedule IDs and suppresses the stale reminder", async () => {
  const expectedRecipientCount = (await activeStaffIds()).length + 1;
  const oldSchedule = { date: "2026-10-20", startTime: "09:00", endTime: "11:00" };
  await db.collection("events").doc(EVENT_ID).update({ date: "2026-10-22" });
  await processEventCalendarNotifications({ now: new Date("2026-10-16T16:00:00Z") });
  assert.equal((await notificationsFor()).length, 0);
  await processEventCalendarNotifications({ now: new Date("2026-10-18T16:00:00Z") });
  const notices = await notificationsFor();
  assert.equal(notices.length, expectedRecipientCount);
  assert.ok(notices.every((item) => item.id.includes(scheduleKey({ ...oldSchedule, date: "2026-10-22" }))));
  assert.ok(notices.every((item) => !item.id.includes(scheduleKey(oldSchedule))));
});

test("archived and invalid events are skipped while legacy missing end time completes safely", async () => {
  const expectedStaff = await activeStaffIds();
  const batch = db.batch();
  batch.set(db.collection("events").doc(`${PREFIX}archived`), {
    name: "Archived", date: "2026-10-20", startTime: "09:00", endTime: "11:00",
    createdBy: ACTIVE_STAFF, archived: true, testFixture: true,
  });
  batch.set(db.collection("events").doc(`${PREFIX}invalid`), {
    name: "Invalid", date: "2026-10-20", startTime: "", endTime: "11:00",
    createdBy: ACTIVE_STAFF, archived: false, testFixture: true,
  });
  batch.set(db.collection("events").doc(`${PREFIX}legacy`), {
    name: "Legacy", date: "2026-10-20", startTime: "09:00", endTime: "",
    createdBy: ACTIVE_STAFF, archived: false, testFixture: true,
  });
  await batch.commit();
  await processEventCalendarNotifications({ now: new Date("2026-10-20T16:00:00Z") });
  assert.equal((await notificationsFor(`${PREFIX}archived`)).length, 0);
  assert.equal((await notificationsFor(`${PREFIX}invalid`)).length, 0);
  const legacy = await notificationsFor(`${PREFIX}legacy`);
  assert.equal(legacy.length, expectedStaff.length);
  assert.ok(legacy.every((item) => item.type === "event_ended"));
  assert.deepEqual(legacy.map((item) => item.recipientUserId).sort(), expectedStaff);
});

test("worker processing remains bounded", async () => {
  const batch = db.batch();
  for (let index = 0; index < 5; index += 1) {
    batch.set(db.collection("events").doc(`${PREFIX}bounded-${index}`), {
      name: `Bounded ${index}`, date: "2026-10-20", startTime: "09:00", endTime: "11:00",
      createdBy: ACTIVE_STAFF, archived: false, testFixture: true,
    });
  }
  await batch.commit();
  const results = await processEventCalendarNotifications({
    now: new Date("2026-10-16T16:00:00Z"), limit: 2,
  });
  assert.equal(results.length, 2);
  assert.equal(results.summary.budgetExhausted, true);
});
