const assert = require("node:assert/strict");

// Observe successful creations made by this one test process. Existing shared
// documents, updates and counters are never cleanup targets. The original SDK
// transaction and storage methods still execute unchanged.
function trackEmulatorCreatedResources({ db, auth, getBucket, prefix, users }) {
  const created = new Map();
  const allowed = new Set(["users", "sites", "events", "distributions", "seedlingRequests", "plantingReports",
    "plantingContributions", "eventParticipants", "monitoringRecords", "verifiedPlantingCohorts", "notifications",
    "plantingEvidenceHashes", "monitoringEvidenceHashes", "evidenceCaptureSessions", "evidenceUploadIntents",
    "evidenceWorkflowOperations", "evidenceQuotaReservations", "evidenceQuotaDays", "evidenceQuotaAudit"]);
  const remember = ref => {
    if (ref.firestore === db && (allowed.has(ref.parent.id) ||
        ref.parent.id === "counters" && ref.id.startsWith(`${prefix}_`))) created.set(ref.path, ref);
  };
  // Record numbering still uses its real SDK transaction and formatting, but
  // this regression's counter documents cannot advance a shared sequence.
  const originalCollection = db.collection;
  db.collection = function (name, ...args) {
    const collection = originalCollection.call(this, name, ...args);
    if (name === "counters") {
      const doc = collection.doc.bind(collection);
      collection.doc = id => doc(`${prefix}_${id}`);
    }
    return collection;
  };
  const prototype = Object.getPrototypeOf(db.collection("users").doc("unused"));
  const originalCreate = prototype.create;
  const originalTransaction = db.runTransaction;
  prototype.create = async function (...args) {
    const result = await originalCreate.apply(this, args);
    remember(this);
    return result;
  };
  db.runTransaction = async function (fn, ...options) {
    let committed = [];
    const result = await originalTransaction.call(this, async transaction => {
      const reads = new Map(), pending = [];
      const get = transaction.get.bind(transaction), create = transaction.create.bind(transaction), set = transaction.set.bind(transaction);
      transaction.get = async (ref, ...args) => {
        const snapshot = await get(ref, ...args);
        if (typeof snapshot.exists === "boolean") reads.set(ref.path, snapshot.exists);
        return snapshot;
      };
      transaction.create = (ref, ...args) => { pending.push(ref); return create(ref, ...args); };
      transaction.set = (ref, ...args) => { if (reads.get(ref.path) === false) pending.push(ref); return set(ref, ...args); };
      const value = await fn(transaction);
      committed = pending;
      return value;
    }, ...options);
    committed.forEach(remember);
    return result;
  };
  return async function cleanup() {
    prototype.create = originalCreate;
    db.runTransaction = originalTransaction;
    db.collection = originalCollection;
    assert.equal(db.projectId, "demo-menro-phase2");
    const snapshots = await Promise.all([...created.values()].map(ref => ref.get()));
    const intents = snapshots.filter(doc => doc.exists && doc.ref.parent.id === "evidenceUploadIntents");
    const actorIds = new Set([...Object.values(users), ...snapshots.filter(doc => doc.ref.parent.id === "users" || doc.ref.parent.id === "eventParticipants").map(doc => doc.id)]);
    const bucket = getBucket();
    assert.equal(bucket.name, "demo-menro-phase2.firebasestorage.app");
    for (const doc of intents) {
      const intent = doc.data();
      assert.ok(actorIds.has(intent.actorId));
      assert.equal(intent.bucket, bucket.name);
      assert.equal(intent.objectName, `evidence/v1/${intent.evidenceType}/${intent.recordId}/${doc.id}`);
      const [exists] = await bucket.file(intent.objectName).exists();
      if (exists) {
        const [metadata] = await bucket.file(intent.objectName).getMetadata();
        assert.equal(metadata.metadata?.uploadIntentId, doc.id);
      }
    }
    for (const doc of intents) await bucket.file(doc.data().objectName).delete({ ignoreNotFound: true });
    const refs = [...created.values()];
    for (let offset = 0; offset < refs.length; offset += 500) {
      const batch = db.batch();
      for (const ref of refs.slice(offset, offset + 500)) batch.delete(ref);
      await batch.commit();
    }
    for (const uid of Object.values(users)) {
      assert.ok(uid.startsWith(`${prefix}-`));
      await auth.deleteUser(uid).catch(error => { if (error.code !== "auth/user-not-found") throw error; });
    }
    for (const ref of refs) assert.equal((await ref.get()).exists, false);
    for (const doc of intents) assert.equal((await bucket.file(doc.data().objectName).exists())[0], false);
    console.log(JSON.stringify({ scopedEmulatorCleanup: true, createdRecordsRemoved: refs.length, ownedObjectsRemoved: intents.length }));
  };
}
module.exports = { trackEmulatorCreatedResources };
