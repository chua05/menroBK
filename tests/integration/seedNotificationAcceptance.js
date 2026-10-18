const { Timestamp } = require("firebase-admin/firestore");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

validateIntegrationEnvironment();
const { db } = require("../../src/config/firebase");
const collection = db.collection("notifications");
const PREFIX = "bell-acceptance-";

async function cleanup() {
  const snapshot = await collection.get();
  const refs = snapshot.docs.filter((doc) => doc.id.startsWith(PREFIX)).map((doc) => doc.ref);
  const batch = db.batch();
  refs.forEach((ref) => batch.delete(ref));
  await batch.commit();
}

async function seed() {
  await cleanup();
  const batch = db.batch();
  const baseTimestamp = Date.now() + 60_000;
  for (let index = 0; index < 25; index += 1) {
    batch.set(collection.doc(`${PREFIX}participant-${String(index).padStart(2, "0")}`), {
      recipientUserId: "phase2-participant",
      title: `Participant notice ${index}`,
      message: `Notification Bell acceptance message ${index}`,
      type: "notification_acceptance",
      relatedRecordType: "monitoring",
      relatedRecordId: `acceptance-record-${index}`,
      isRead: false,
      readAt: null,
      createdAt: Timestamp.fromMillis(baseTimestamp + (index * 1_000)),
      testFixture: true,
    });
  }
  for (const [role, recipientUserId, second] of [
    ["staff", "phase2-staff", 40], ["admin", "phase2-admin", 50],
  ]) {
    batch.set(collection.doc(`${PREFIX}${role}`), {
      recipientUserId,
      title: `${role} private notice`,
      message: `Notification Bell acceptance message ${second}`,
      type: "notification_acceptance",
      relatedRecordType: "monitoring",
      relatedRecordId: `acceptance-record-${role}`,
      isRead: false,
      readAt: null,
      createdAt: Timestamp.fromMillis(baseTimestamp + (second * 1_000)),
      testFixture: true,
    });
  }
  await batch.commit();
}

(process.argv.includes("--cleanup") ? cleanup() : seed())
  .then(() => console.log(process.argv.includes("--cleanup")
    ? "Notification Bell fixtures removed." : "Notification Bell fixtures seeded."))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
