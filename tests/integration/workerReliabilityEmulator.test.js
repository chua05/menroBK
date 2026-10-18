const assert = require("node:assert/strict");
const test = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

validateIntegrationEnvironment();
const { db } = require("../../src/config/firebase");
const { processBoundedCollection } = require("../../src/utils/boundedWorker.util");
const { processOfficialMonitoringNotifications } = require("../../src/services/officialMonitoringNotification.service");

const PREFIX = "worker-reliability-";
const COLLECTION = "workerReliabilityRecords";
const CHECKPOINT_ID = "worker-reliability-integration";
const RECIPIENT_ID = `${PREFIX}recipient`;
const RECORD_COUNT = 505;
const OFFICIAL_REPORT_ID = `${PREFIX}official-report`;
const PARTICIPANT_ID = `${PREFIX}participant`;

async function deleteMatching(collectionName, predicate) {
  const snapshot = await db.collection(collectionName).get();
  const refs = snapshot.docs.filter(predicate).map((document) => document.ref);
  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = db.batch();
    refs.slice(offset, offset + 400).forEach((reference) => batch.delete(reference));
    await batch.commit();
  }
}

async function cleanup() {
  await deleteMatching("notifications", (document) => document.id.startsWith(PREFIX) ||
    String(document.data().relatedRecordId || "").startsWith(PREFIX) ||
    String(document.data().details?.plantingReportId || "").startsWith(PREFIX));
  await deleteMatching(COLLECTION, (document) => document.id.startsWith(PREFIX));
  await db.collection("workerCheckpoints").doc(CHECKPOINT_ID).delete();
  await db.collection("workerCheckpoints").doc("official-monitoring-notifications").delete();
  await db.collection("plantingReports").doc(OFFICIAL_REPORT_ID).delete();
  await db.collection("users").doc(PARTICIPANT_ID).delete();
}

async function seed() {
  await cleanup();
  const writes = [];
  for (let index = 0; index < RECORD_COUNT; index += 1) {
    writes.push({
      id: `${PREFIX}${String(index).padStart(3, "0")}`,
      data: {
        eligible: index === RECORD_COUNT - 1,
        malformed: index === 1,
        sameTimestamp: Timestamp.fromMillis(1_000),
        testFixture: true,
      },
    });
  }
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    writes.slice(offset, offset + 400).forEach(({ id, data }) =>
      batch.set(db.collection(COLLECTION).doc(id), data));
    await batch.commit();
  }
}

async function processRecord(document) {
  const data = document.data();
  if (data.malformed) throw new Error("Synthetic malformed worker record");
  if (!data.eligible) return { recordId: document.id, outcome: "skipped" };
  const notificationId = `${PREFIX}notice-${document.id}`;
  await db.runTransaction(async (transaction) => {
    const ref = db.collection("notifications").doc(notificationId);
    if ((await transaction.get(ref)).exists) return;
    transaction.create(ref, {
      recipientUserId: RECIPIENT_ID,
      type: "worker_reliability_acceptance",
      title: "Worker reliability fixture",
      message: "Synthetic emulator-only notification",
      relatedRecordType: "workerReliability",
      relatedRecordId: document.id,
      isRead: false,
      readAt: null,
      createdAt: Timestamp.now(),
      testFixture: true,
    });
  });
  return { recordId: document.id, outcome: "notified" };
}

function run(options = {}) {
  return processBoundedCollection({
    db,
    workerId: CHECKPOINT_ID,
    collectionName: COLLECTION,
    processDocument: processRecord,
    budget: 100,
    pageSize: 37,
    ...options,
  });
}

test.before(seed);
test.after(cleanup);

test("bounded concurrent and repeated runs reach records beyond 500 without duplicates", async () => {
  const first = await run();
  assert.equal(first.length, 100);
  assert.equal(first.summary.budgetExhausted, true);
  assert.deepEqual(first.summary.failures.map((failure) => failure.recordId),
    [`${PREFIX}001`]);

  await Promise.all([run(), run()]);
  for (let invocation = 0; invocation < 4; invocation += 1) await run();

  const lastId = `${PREFIX}504`;
  const noticeId = `${PREFIX}notice-${lastId}`;
  const notice = await db.collection("notifications").doc(noticeId).get();
  assert.equal(notice.exists, true);
  assert.equal(notice.data().recipientUserId, RECIPIENT_ID);
  assert.equal(notice.data().relatedRecordId, lastId);

  await run({ budget: 600, pageSize: 100 });
  const notices = await db.collection("notifications")
    .where("relatedRecordId", "==", lastId).get();
  assert.equal(notices.size, 1);
});

test("a failed record remains retryable on the next complete scan", async () => {
  const failedId = `${PREFIX}001`;
  await db.collection(COLLECTION).doc(failedId).update({ malformed: false, eligible: true });
  await run({ budget: 600, pageSize: 100 });
  const notice = await db.collection("notifications")
    .doc(`${PREFIX}notice-${failedId}`).get();
  assert.equal(notice.exists, true);
  assert.equal(notice.data().recipientUserId, RECIPIENT_ID);
});

test("official worker persists notices only for the owner and active Staff", async () => {
  await db.collection("users").doc(PARTICIPANT_ID).set({
    role: "participant", status: "active", testFixture: true,
  });
  await db.collection("plantingReports").doc(OFFICIAL_REPORT_ID).set({
    participantId: PARTICIPANT_ID,
    plantingDate: "2026-10-01",
    quantityPlanted: 10,
    verificationStatus: "Approved",
    reportingProgress: "Completed",
    siteName: "Worker Reliability Site",
    testFixture: true,
  });
  await processOfficialMonitoringNotifications({ today: "2026-10-15", budget: 10000 });

  const allNotices = await db.collection("notifications").get();
  const notices = allNotices.docs.filter((document) =>
    document.data().details?.plantingReportId === OFFICIAL_REPORT_ID);
  const activeStaff = await db.collection("users").where("role", "==", "staff").get();
  const expected = new Set(activeStaff.docs
    .filter((document) => document.data().status !== "inactive")
    .map((document) => document.id));
  expected.add(PARTICIPANT_ID);
  assert.deepEqual(new Set(notices.map((document) => document.data().recipientUserId)), expected);
  assert.ok(notices.every((document) =>
    document.data().type === "official_monitoring_available"));
});
