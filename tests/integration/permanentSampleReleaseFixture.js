// Local-only pre-existing data for release-control acceptance. Not a public API.
const assert = require("node:assert/strict");
const { randomBytes, createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { evidenceDirectory } = require("./phase3cBrowserFixtureCleanup");
const path = require("node:path");
const snapshotPath = prefix => path.join(evidenceDirectory, `${prefix}.release.json`);
async function snapshot(prefix, visitId) {
  const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");
  assert.equal(validateIntegrationEnvironment().projectId, "demo-menro-phase3c-isolated");
  const { db, getStorageBucket } = require("../../src/config/firebase");
  const actorId = `${prefix}-staff`, cohortId = `${prefix}-cohort`;
  const quotaActor = createHash("sha256").update(JSON.stringify(["v1", "user", actorId])).digest("hex");
  const queries = [
    db.collection("sampleMonitoringVisits").doc(visitId).get(),
    db.collection("verifiedPlantingCohorts").doc(cohortId).get(),
    ...["evidenceCaptureSessions", "sampleMonitoringEvidenceHashes", "sampleMonitoringInformationRequests"].map(name => db.collection(name).where("visitId", "==", visitId).get()),
    db.collection("evidenceWorkflowOperations").where("binding.visitId", "==", visitId).get(),
    db.collection("evidenceUploadIntents").where("actorId", "==", actorId).get(),
    db.collection("notifications").where("recipientUserId", "in", [actorId, `${prefix}-admin`, `${prefix}-participant`]).where("relatedRecordType", "==", "sampleMonitoringInformation").get(),
    ...["evidenceQuotaReservations", "evidenceQuotaDays", "evidenceQuotaAudit"].map(name => db.collection(name).where("actorKey", "==", quotaActor).get()),
  ];
  const rows = await Promise.all(queries);
  const visit = rows[0].data(); assert.equal(visit.createdBy, actorId); assert.equal(visit.cohortId, cohortId);
  const docs = rows.flatMap((row, i) => row.docs ? row.docs.map(doc => [i, doc.id, doc.data()]) : [[i, row.id, row.data()]]);
  docs.sort((a, b) => JSON.stringify(a.slice(0, 2)).localeCompare(JSON.stringify(b.slice(0, 2))));
  const references = visit.sampleAssessments.flatMap(row => row.evidenceHistory || []).map(row => row.privateEvidence).filter(Boolean);
  const hashes = [];
  for (const ref of references) {
    const bucket = getStorageBucket(); assert.equal(ref.bucket, bucket.name);
    const file = bucket.file(ref.objectName); assert.equal((await file.exists())[0], true);
    const [bytes] = await file.download(); hashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  const actorScope = createHash("sha256").update(actorId).digest("hex");
  const [files] = await getStorageBucket().getFiles({ prefix: "evidence/v1/sample-monitoring/" });
  const ownedObjects = [];
  for (const file of files) {
    const [metadata] = await file.getMetadata();
    if (metadata.metadata?.actorScope === actorScope) {
      const [bytes] = await file.download();
      ownedObjects.push(createHash("sha256").update(file.name).update(bytes).digest("hex"));
    }
  }
  ownedObjects.sort();
  return { digest: createHash("sha256").update(JSON.stringify([docs, hashes, ownedObjects])).digest("hex"), records: docs.length, objects: ownedObjects.length };
}
async function seed({ prefix, ids, cohortId, siteId, visit }) {
  assert.equal(process.env.MENRO_PHASE3C_ISOLATED_EMULATORS, "true");
  assert.equal(process.env.MENRO_PHASE3D4_ACCEPTANCE, "true");
  const capture = require("../../src/services/evidenceCaptureSession.service");
  const session = await capture.createCaptureSession({ actorId: ids.staff, actorRole: "staff", workflow: "sample-monitoring", cohortId, siteId,
    visitId: visit.id, sampleId: "TREE-001", samplingPlanVersion: 1, baselineVersion: 1, visitVersion: 0, assessmentRevision: 0 });
  // Actual image bytes, actual session/nonce and unchanged production validation.
  // This seeded history is not a claim of physical/browser camera acceptance.
  const bytes = await require("sharp")(randomBytes(16 * 16 * 3), { raw: { width: 16, height: 16, channels: 3 } }).jpeg().toBuffer();
  const file = { buffer: bytes, mimetype: "image/jpeg", size: bytes.length, originalname: "release-fixture.jpg" };
  const verified = await capture.verifyCaptureSession({ actorId: ids.staff, actorRole: "staff", sessionId: session.captureSessionId,
    nonce: session.nonce, file, capturedAt: new Date().toISOString(), latitude: 12.662301, longitude: 123.932983, accuracy: 5 });
  await require("../../src/services/sampleMonitoringEvidence.service").upload({ actorId: ids.staff, visitId: visit.id, sampleId: "TREE-001",
    assessmentRevision: 0, expectedVisitVersion: 0, files: [file], idempotencyKey: "release_existing_photo", evidenceManifest: [{ source: "browser-camera",
      captureSessionId: session.captureSessionId, nonce: session.nonce, verificationId: verified.verificationId, imageSha256: verified.imageSha256 }] });
  const { db } = require("../../src/config/firebase");
  const info = require("../../src/services/sampleMonitoringInformation.service").createService({ db, enabled: () => true, now: () => Date.now(),
    notify: (tx, row) => tx.create(db.collection("notifications").doc(row.notificationId), row) });
  const question = await info.create({ actorId: ids.staff, actorRole: "staff", visitId: visit.id, question: "Release fixture access question", key: "release_question" });
  const answered = await info.create({ actorId: ids.staff, actorRole: "staff", visitId: visit.id, question: "Historical answered question", key: "release_history" });
  await info.answer({ actorId: ids.participant, actorRole: "participant", requestId: answered.id, answer: "Historical fixture answer", expectedVersion: 0, key: "release_answer" });
  await fs.writeFile(snapshotPath(prefix), JSON.stringify(await snapshot(prefix, visit.id)), { flag: "wx" });
  return { questionId: question.id, answeredId: answered.id };
}
async function verify(prefix, visitId) {
  const before = JSON.parse(await fs.readFile(snapshotPath(prefix), "utf8"));
  assert.deepEqual(await snapshot(prefix, visitId), before, "Paused requests changed permanent-sample evidence/history");
  return { unchanged: true, records: before.records, objects: before.objects };
}
module.exports = { seed, verify };
