const assert = require("node:assert/strict");
const test = require("node:test");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

test("installed Firestore query supports server-side count aggregation", async () => {
  const app = initializeApp(
    { projectId: "demo-menro-phase2" },
    "firebase-compatibility-test"
  );

  try {
    const query = getFirestore(app)
      .collection("notifications")
      .where("recipientUserId", "==", "compatibility-test")
      .where("isRead", "==", false);
    assert.equal(typeof query.count, "function");
  } finally {
    await deleteApp(app);
  }
});
