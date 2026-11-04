const { createHash, randomUUID } = require("node:crypto");
const { db, getStorageBucket } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { resolveEvidenceStorageConfig } = require("../config/evidenceStorage");
const { validateRequestLetterFile } = require("./requestLetterStorage.service");
const fail = (status, message) => Object.assign(new Error(message), { status });
function storageConfig() {
  const storage = resolveEvidenceStorageConfig();
  if (!storage.cloudWorkflow || !storage.cloudRead || !storage.bucket) throw fail(503, "Private attendance storage is unavailable. The report can be submitted without attendance documentation.");
  return storage;
}
function identifier(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
async function context(user, id, write) {
  if (!user?.uid) throw fail(401, "Authentication is required.");
  if (!identifier(id)) throw fail(404, "Attendance file not found.");
  if (!(write ? ["staff"] : ["staff", "admin"]).includes(user.role)) throw fail(403, "MENRO access is required.");
  const contributionRef = db.collection("plantingContributions").doc(id), contribution = await contributionRef.get();
  if (!contribution.exists || contribution.data().officialStaffReport !== true || !identifier(contribution.data().officialOperationId)) throw fail(404, "Attendance file not found.");
  if (user.role === "staff" && contribution.data().authenticatedSubmitterUid !== user.uid) throw fail(404, "Attendance file not found.");
  const operationRef = db.collection("officialPlantingOperations").doc(contribution.data().officialOperationId);
  const operation = await operationRef.get();
  if (!operation.exists || operation.data().reportId !== contribution.data().reportId || !operation.data().submissionIds.includes(id)) throw fail(404, "Attendance file not found.");
  return { operationRef, operation: operation.data() };
}
function boundPath(operationRef, descriptor) {
  return descriptor && descriptor.objectName === `planting-attendance/v1/${operationRef.id}/${descriptor.sha256}` && /^[a-f0-9]{64}$/.test(descriptor.sha256);
}
async function uploadAttendance(user, id, file) {
  const config = storageConfig(), { operationRef, operation: initialOperation } = await context(user, id, true);
  if (!file || !["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)) throw fail(400, "Attendance must be a PDF, JPEG or PNG file not larger than 10 MB.");
  let validated;
  try { validated = await validateRequestLetterFile(file); } catch { throw fail(400, "Attendance must be a valid, safe PDF, JPEG or PNG file not larger than 10 MB."); }
  if (initialOperation.attendance) {
    if (initialOperation.attendance.sha256 !== validated.sha256) throw fail(409, "Attendance is immutable. Keep the original file with this submission.");
    return { hasAttendance: true };
  }
  const lease = randomUUID(), nowMillis = Date.now();
  const objectName = `planting-attendance/v1/${operationRef.id}/${validated.sha256}`;
  const bucket = getStorageBucket();
  if (bucket.name !== config.bucket) throw fail(503, "Private attendance storage is unavailable.");
  const quota = require("./evidenceUploadQuota.service").createEvidenceUploadQuota(), actor = quota.serverActor({ uid: user.uid });
  const reservationHash = createHash("sha256").update(`attendance:${operationRef.id}`).digest("hex");
  const intentId = `${reservationHash.slice(0, 8)}-${reservationHash.slice(8, 12)}-${reservationHash.slice(12, 16)}-${reservationHash.slice(16, 20)}-${reservationHash.slice(20, 32)}`;
  let completed = false, attempted = false, claimed = false;
  try {
    // Reserve once for this immutable submission, including exact retries.
    const quotaDay = initialOperation.attendanceIntent?.quotaDay || quota.today();
    await quota.reserve(actor, { intentId, day: quotaDay, fileCount: 1, byteCount: validated.sizeBytes });
    await db.runTransaction(async tx => {
      const opDoc = await tx.get(operationRef); const op = opDoc.data();
      if (!opDoc.exists || op.staffId !== user.uid) throw fail(404, "Attendance file not found.");
      if (op.attendance) {
        if (op.attendance.sha256 !== validated.sha256) throw fail(409, "Attendance is immutable. Keep the original file with this submission.");
        completed = true; return;
      }
      const rows = await Promise.all(op.submissionIds.map(row => tx.get(db.collection("plantingContributions").doc(row))));
      if (rows.some(row => !row.exists || row.data().staffReviewStatus !== "Pending Review")) throw fail(409, "Attendance cannot be changed after Admin review.");
      if (op.attendanceIntent && (op.attendanceIntent.sha256 !== validated.sha256 || op.attendanceIntent.sizeBytes !== validated.sizeBytes)) throw fail(409, "Retry the same attendance file or submit an authorized correction.");
      if (op.attendanceLeaseUntil > nowMillis) throw fail(409, "An attendance upload is already in progress. Check the report before retrying.");
      if (Number(op.attendanceAttempts || 0) >= 3) throw fail(409, "Attendance upload attempts are exhausted. Contact MENRO; the report remains saved.");
      tx.update(operationRef, { attendanceIntent: { objectName, sha256: validated.sha256, sizeBytes: validated.sizeBytes, contentType: validated.contentType, bucket: config.bucket, intentId, quotaDay },
        attendanceLease: lease, attendanceLeaseUntil: nowMillis + 120000, attendanceAttempts: Number(op.attendanceAttempts || 0) + 1 });
      claimed = true;
    });
    if (completed) return { hasAttendance: true };
    await db.runTransaction(tx => quota.beginInTransaction(tx, actor, intentId, lease)); attempted = true;
    const object = bucket.file(objectName);
    try { await object.save(validated.bytes, { resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: validated.contentType, cacheControl: "private, no-store", metadata: { sha256: validated.sha256 } } }); }
    catch (error) { if (Number(error.code) !== 412) throw error; }
    const [metadata] = await object.getMetadata();
    if (String(metadata.size) !== String(validated.sizeBytes)) throw fail(503, "Private attendance integrity verification failed.");
    const [bytes] = await object.download();
    if (String(metadata.size) !== String(validated.sizeBytes) || metadata.metadata?.sha256 !== validated.sha256 || createHash("sha256").update(bytes).digest("hex") !== validated.sha256) throw fail(503, "Private attendance integrity verification failed.");
    const descriptor = { objectName, bucket: config.bucket, generation: String(metadata.generation), contentType: validated.contentType, sha256: validated.sha256, sizeBytes: validated.sizeBytes, uploadedAt: metadata.timeCreated };
    await db.runTransaction(async tx => {
      const opDoc = await tx.get(operationRef), op = opDoc.data();
      if (!opDoc.exists || op.staffId !== user.uid || op.attendanceLease !== lease || op.attendance || !boundPath(operationRef, descriptor)) throw fail(409, "Attendance upload changed. Refresh the report.");
      const rows = await Promise.all(op.submissionIds.map(row => tx.get(db.collection("plantingContributions").doc(row))));
      if (rows.some(row => !row.exists || row.data().staffReviewStatus !== "Pending Review")) throw fail(409, "Attendance cannot be changed after Admin review.");
      await quota.finalizeInTransaction(tx, actor, intentId, { uploadIntentId: intentId, generation: descriptor.generation, sizeBytes: descriptor.sizeBytes, uploadedAt: descriptor.uploadedAt });
      tx.update(operationRef, { attendance: descriptor, attendanceLease: "", attendanceLeaseUntil: 0, attendanceUploadedAt: Timestamp.now() });
      for (const row of rows) tx.update(db.collection("plantingContributions").doc(row.id), { attendanceAvailable: true });
    });
    completed = true; return { hasAttendance: true };
  } catch (error) {
    // Keep a private, fixture-owned intent for explicit reconciliation after a
    // crash. Never delete a possibly linked object belonging to another attempt.
    if (claimed && !completed) await db.runTransaction(async tx => {
      const doc = await tx.get(operationRef);
      if (doc.exists && !doc.data().attendance && doc.data().attendanceLease === lease) tx.update(operationRef, { attendanceLease: "", attendanceLeaseUntil: 0 });
    }).catch(() => {});
    if (claimed && !attempted) await quota.releaseUnused(actor, intentId).catch(() => {});
    throw error;
  }
}
async function streamAttendance(user, id, response) {
  const storage = resolveEvidenceStorageConfig();
  if (!storage.cloudRead || !storage.bucket) throw fail(503, "Private attendance retrieval is unavailable.");
  const { operationRef, operation } = await context(user, id, false), descriptor = operation.attendance;
  if (!boundPath(operationRef, descriptor) || descriptor.bucket !== storage.bucket) throw fail(404, "Attendance file not found.");
  const bucket = getStorageBucket();
  if (bucket.name !== descriptor.bucket) throw fail(503, "Private attendance retrieval is unavailable.");
  const object = bucket.file(descriptor.objectName, { generation: descriptor.generation });
  const [metadata] = await object.getMetadata();
  if (String(metadata.generation) !== descriptor.generation || String(metadata.size) !== String(descriptor.sizeBytes) || descriptor.sizeBytes > 10 * 1024 * 1024) throw fail(503, "Private attendance integrity verification failed.");
  const [bytes] = await object.download();
  if (String(metadata.generation) !== descriptor.generation || String(bytes.length) !== String(descriptor.sizeBytes) || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) throw fail(503, "Private attendance integrity verification failed.");
  response.setHeader("Content-Type", descriptor.contentType); response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  response.setHeader("Content-Disposition", `attachment; filename="attendance.${descriptor.contentType === "application/pdf" ? "pdf" : descriptor.contentType === "image/png" ? "png" : "jpg"}"`);
  response.end(bytes);
}
// Explicit maintenance/fixture cleanup: caller must establish operation ownership
// and terminal lifecycle externally. No collection-wide deletion or timer job.
async function cleanupAttendanceObject(operationId, expectedRequestId) {
  const storage = storageConfig();
  if (!storage.storageEmulator || !require("../config/integrationEnvironment").validateIntegrationEnvironment().integration) throw fail(403, "Explicit attendance fixture cleanup requires the approved demo emulator environment.");
  if (!identifier(operationId) || !identifier(expectedRequestId)) throw fail(400, "Invalid cleanup context.");
  const ref = db.collection("officialPlantingOperations").doc(operationId), doc = await ref.get();
  if (!doc.exists) return { deleted: false };
  const op = doc.data();
  if (op.requestId !== expectedRequestId || op.attendanceLeaseUntil > Date.now()) throw fail(409, "Attendance cleanup ownership or lease mismatch.");
  const descriptor = op.attendance || op.attendanceIntent;
  if (!descriptor) return { deleted: false };
  if (!boundPath(ref, descriptor) || descriptor.bucket !== storage.bucket) throw fail(409, "Attendance cleanup binding mismatch.");
  const bucket = getStorageBucket(); if (bucket.name !== storage.bucket) throw fail(503, "Private attendance storage is unavailable.");
  const object = bucket.file(descriptor.objectName);
  try {
    const [metadata] = await object.getMetadata();
    if (metadata.metadata?.sha256 !== descriptor.sha256 || descriptor.generation && String(metadata.generation) !== descriptor.generation) throw fail(409, "Attendance cleanup integrity mismatch.");
    await object.delete({ ifGenerationMatch: metadata.generation }); return { deleted: true };
  } catch (error) { if (Number(error.code) === 404) return { deleted: false }; throw error; }
}
module.exports = { uploadAttendance, streamAttendance, cleanupAttendanceObject };
