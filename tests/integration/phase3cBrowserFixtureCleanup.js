const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

const evidenceDirectory = path.join(os.tmpdir(), "menro-phase3c-test-evidence");
const fixturePath = path.join(os.tmpdir(), "menro-phase3c-browser-fixture.json");
const validPrefix = prefix => assert.match(prefix, /^phase3c-browser-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
const manifestPath = prefix => { validPrefix(prefix); return path.join(evidenceDirectory, `${prefix}.fixture.json`); };
const missing = error => { if (error.code === "auth/user-not-found") return null; throw error; };

// Recovery requires a local run record AND independent server ownership checks.
// Neither a matching digest nor a naming prefix alone authorizes deletion.
async function cleanupFixture(prefix, { dryRun = false } = {}) {
  validPrefix(prefix);
  const integration = validateIntegrationEnvironment();
  assert.equal(integration.integration, true);
  const manifest = await fs.readFile(manifestPath(prefix), "utf8").then(JSON.parse)
    .catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (manifest) assert.equal(manifest.project, integration.projectId);
  else await fs.access(path.join(evidenceDirectory, `${prefix}.backend.log`));
  const { db, auth, getStorageBucket } = require("../../src/config/firebase");
  assert.equal(db.projectId, integration.projectId);
  const siteId = `${prefix}-site`, cohortId = `${prefix}-cohort`, staffId = `${prefix}-staff`;
  const visitDate = manifest?.visitDate || "2099-01-01";
  assert.match(visitDate, /^\d{4}-\d{2}-\d{2}$/);
  const visitId = require("../../src/services/sampleMonitoringVisit.service")._test.id(cohortId, visitDate);
  if (manifest) assert.equal(manifest.visitId, visitId);
  const siteRef = db.collection("sites").doc(siteId), cohortRef = db.collection("verifiedPlantingCohorts").doc(cohortId);
  const visitRef = db.collection("sampleMonitoringVisits").doc(visitId);
  const [site, cohort, visit] = await Promise.all([siteRef.get(), cohortRef.get(), visitRef.get()]);
  if (!manifest) assert.ok(site.exists && cohort.exists && visit.exists, "Legacy recovery lacks independent fixture ownership records");
  if (site.exists) assert.equal(site.data().testFixture, prefix);
  if (cohort.exists) { assert.equal(cohort.data().testFixture, prefix); assert.equal(cohort.data().source.siteId, siteId); }
  if (visit.exists) {
    assert.equal(visit.data().createdBy, staffId);
    assert.equal(visit.data().cohortId, cohortId);
    assert.equal(visit.data().siteId, siteId);
  }
  const users = [];
  for (const role of ["admin", "staff", "participant", "otherStaff"]) {
    const uid = `${prefix}-${role}`, profileRef = db.collection("users").doc(uid);
    const [profile, user] = await Promise.all([profileRef.get(), auth.getUser(uid).catch(missing)]);
    if (profile.exists) assert.equal(profile.data().testFixture, prefix);
    if (user) assert.equal(user.email.toLowerCase(), `${role}.${prefix}@example.test`.toLowerCase());
    users.push({ profileRef, user, uid });
  }
  const originals = await db.collection("sampleMonitoringOriginalVerifications").where("visitId", "==", visitId).get();
  for (const doc of originals.docs) { assert.equal(doc.data().actorId,staffId); assert.equal(doc.data().cohortId,cohortId); assert.equal(doc.data().siteId,siteId); }
  const captures = await db.collection("evidenceCaptureSessions").where("visitId", "==", visitId).get();
  for (const doc of captures.docs) {
    assert.equal(doc.data().actorId, staffId);
    assert.equal(doc.data().cohortId, cohortId);
    assert.equal(doc.data().siteId, siteId);
  }
  const hashes = await db.collection("sampleMonitoringEvidenceHashes").where("visitId", "==", visitId).get();
  const operations = await db.collection("evidenceWorkflowOperations").where("binding.visitId", "==", visitId).get();
  for (const doc of operations.docs) {
    assert.equal(doc.data().workflow, "sample-monitoring");
    assert.equal(doc.data().binding.cohortId, cohortId);
    assert.equal(doc.data().binding.siteId, siteId);
  }
  const entries = (visit.data()?.sampleAssessments || []).flatMap(item =>
    (item.evidenceHistory || []).filter(entry => entry.privateEvidence).map(entry => ({ ...entry, sampleId: item.sampleId })));
  const references = entries.map(entry => entry.privateEvidence);
  const { rid } = require("../../src/services/sampleMonitoringEvidence.service");
  const intentIds = new Set(operations.docs.flatMap(doc => doc.data().intentIds || []));
  references.forEach(ref => intentIds.add(ref.uploadIntentId));
  const candidates = await db.collection("evidenceUploadIntents").where("actorId", "==", staffId).get();
  const intents = candidates.docs.filter(doc => intentIds.has(doc.id));
  for (const doc of intents) {
    const row = doc.data();
    assert.equal(row.actorKind, "user");
    assert.equal(row.evidenceType, "sample-monitoring");
    assert.equal(row.bucket, process.env.FIREBASE_STORAGE_BUCKET);
    assert.equal(row.objectName, `evidence/v1/sample-monitoring/${row.recordId}/${doc.id}`);
  }
  const objects = new Set(intents.map(doc => doc.data().objectName));
  for (const entry of entries) {
    const ref = entry.privateEvidence;
    assert.equal(ref.bucket, process.env.FIREBASE_STORAGE_BUCKET);
    assert.match(ref.uploadIntentId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    assert.equal(ref.objectName, `evidence/v1/sample-monitoring/${rid(visitId, entry.sampleId, entry.revision)}/${ref.uploadIntentId}`);
    const intent = intents.find(doc => doc.id === ref.uploadIntentId);
    if (intent) assert.equal(ref.objectName, intent.data().objectName);
    objects.add(ref.objectName);
  }
  const bucket = getStorageBucket();
  assert.equal(bucket.name, process.env.FIREBASE_STORAGE_BUCKET);
  const existingObjects = new Set();
  for (const name of objects) {
    const file = bucket.file(name);
    const [exists] = await file.exists();
    if (exists) {
      const [metadata] = await file.getMetadata();
      assert.equal(metadata.metadata?.uploadIntentId, name.split("/").at(-1));
      assert.equal(metadata.metadata?.actorScope, createHash("sha256").update(staffId).digest("hex"));
      existingObjects.add(name);
    }
  }
  const quotaActor = createHash("sha256").update(JSON.stringify(["v1", "user", staffId])).digest("hex");
  const quota = await db.collection("evidenceQuotaReservations").where("actorKey", "==", quotaActor).get();
  const days = await db.collection("evidenceQuotaDays").where("actorKey", "==", quotaActor).get();
  const audits = await db.collection("evidenceQuotaAudit").where("actorKey", "==", quotaActor).get();
  const information = await db.collection("sampleMonitoringInformationRequests").where("visitId", "==", visitId).get();
  const informationNotifications = [];
  for (const doc of information.docs) {
    const row = doc.data();
    assert.equal(row.cohortId, cohortId); assert.equal(row.siteId, siteId);
    assert.ok([staffId, `${prefix}-admin`].includes(row.requestedBy));
    assert.equal(row.recipientUserId, `${prefix}-participant`);
    assert.equal(row.sourceRequestId, `${prefix}-source`);
    assert.equal(row.plantingReportId, `${prefix}-report`);
    const notices = await db.collection("notifications").where("relatedRecordId", "==", doc.id).get();
    for (const notice of notices.docs) {
      assert.equal(notice.data().relatedRecordType, "sampleMonitoringInformation");
      assert.ok([row.requestedBy, row.recipientUserId].includes(notice.data().recipientUserId));
      informationNotifications.push(notice);
    }
  }
  const sourceRecords = [];
  for (const [collection, id] of [["seedlingRequests", `${prefix}-source`], ["plantingReports", `${prefix}-report`]]) {
    const doc = await db.collection(collection).doc(id).get();
    if (doc.exists) { assert.equal(doc.data().testFixture, prefix); sourceRecords.push(doc); }
  }
  const combined = manifest?.combinedWorkflow ? await require("./combinedWorkflowFixture").inspect(prefix) : null;
  if (combined) for (const id of combined.intentIds) intentIds.add(id);
  for (const doc of quota.docs) assert.ok(intentIds.has(doc.data().uploadIntentId));
  const counterLedger = manifest?.formAcceptance ? await fs.readFile(path.join(evidenceDirectory, `${prefix}.counter-refs.jsonl`), "utf8")
    .catch(error => { if (error.code === "ENOENT") return ""; throw error; }) : "";
  const counterIds = [...new Set(counterLedger.split("\n").filter(Boolean).map(line => JSON.parse(line)))];
  for (const id of counterIds) assert.ok(typeof id === "string" && id.startsWith(`${prefix}_`) && !id.includes("/"));
  const fixtureCounters = (await Promise.all(counterIds.map(id => db.collection("counters").doc(id).get()))).filter(doc => doc.exists);
  const docs = [...fixtureCounters, ...originals.docs, ...captures.docs, ...hashes.docs, ...operations.docs, ...intents, ...quota.docs, ...days.docs, ...audits.docs,
    ...information.docs, ...informationNotifications, ...sourceRecords, ...(combined?.docs || [])];
  if (dryRun) return { records: docs.length, users: users.filter(item => item.user).length, objects: objects.size, ownershipVerified: true };
  // No mutation precedes the ownership checks above. Errors other than absent
  // resources remain failures, so cleanup can never silently claim success.
  await Promise.all([...objects].map(name => bucket.file(name).delete({ ignoreNotFound: true })));
  if (combined) await require("./combinedWorkflowFixture").cleanupObjects(combined);
  const recordRefs = [...docs.map(doc => doc.ref), visitRef, cohortRef, siteRef, ...users.map(item => item.profileRef)];
  assert.ok(recordRefs.length <= 500, "Fixture cleanup exceeds its bounded atomic batch");
  const batch = db.batch();
  for (const ref of recordRefs) batch.delete(ref);
  await batch.commit();
  await Promise.all(users.filter(item => item.user).map(({ uid }) => auth.deleteUser(uid).catch(missing)));
  await Promise.all(recordRefs.map(async ref => assert.equal((await ref.get()).exists, false)));
  await Promise.all([...objects].map(async name => assert.equal((await bucket.file(name).exists())[0], false)));
  await Promise.all(users.map(async ({ uid }) => assert.equal(await auth.getUser(uid).catch(missing), null)));
  const current = await fs.readFile(fixturePath, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (current?.visitId === visitId) await fs.rm(fixturePath, { force: true });
  await fs.writeFile(manifestPath(prefix), JSON.stringify({ ...manifest, prefix, project: integration.projectId, visitId, cleaned: true }), "utf8");
  return { recordsRemoved: docs.length + [site, cohort, visit].filter(doc => doc.exists).length,
    usersRemoved: users.filter(item => item.user).length, objectsRemoved: existingObjects.size, verified: true };
}
module.exports = { cleanupFixture, fixturePath, manifestPath, evidenceDirectory };
