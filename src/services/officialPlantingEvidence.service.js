const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const images = require("../utils/imageVerification.util");
const { validatePlantingReport } = require("../utils/plantingVerification.util");
const { calculateDistanceMeters, isPointInPolygon } = require("../utils/geo.util");
const { isPointWithinMunicipality } = require("../config/municipality");
const capture = require("./evidenceCaptureSession.service");
const saga = require("./evidenceWorkflow.service");
const fail = (status, message) => Object.assign(new Error(message), { status, fieldErrors: { photos: message } });
const siteSignature = site => saga.canonical({ latitude: site.latitude, longitude: site.longitude,
  coverageRadiusMeters: site.coverageRadiusMeters ?? null, polygon: site.polygon ?? null, status: String(site.status || "").toLowerCase() });
async function context(user, id) {
  if (!user?.uid || String(user.role).toLowerCase() !== "staff") throw fail(user?.uid ? 403 : 401, "MENRO Staff access is required.");
  if (!/^[\w-]{1,128}$/.test(id || "")) throw fail(404, "Official submission not found.");
  const row = await db.collection("plantingContributions").doc(id).get(), data = row.data();
  if (!row.exists || !data.officialStaffReport || data.authenticatedSubmitterUid !== user.uid) throw fail(404, "Official submission not found.");
  const opRef = db.collection("officialPlantingOperations").doc(data.officialOperationId), op = await opRef.get();
  if (!op.exists || op.data().staffId !== user.uid || !op.data().submissionIds.includes(id)) throw fail(404, "Official submission not found.");
  const operation = op.data(), primaryRef = db.collection("plantingContributions").doc(operation.submissionIds[0]);
  const [event, distribution, site] = await Promise.all([db.collection("events").doc(data.eventId).get(), db.collection("distributions").doc(data.requestId).get(), db.collection("sites").doc(data.siteId).get()]);
  if (!event.exists || !distribution.exists || !site.exists || event.data().sourceRequestId !== data.requestId || event.data().plantingSiteId !== data.siteId || distribution.data().status !== "Released" || distribution.data().eventId !== data.eventId || String(site.data().status).toLowerCase() === "inactive" || !Number.isFinite(site.data().latitude) || !Number.isFinite(site.data().longitude)) throw fail(409, "Official release and site require reconciliation.");
  return { data, opRef, operation, primaryRef, site: site.data() };
}
async function upload(user, id, files, input, key) {
  const ctx = await context(user, id);
  if (!saga.enabled()) throw fail(503, "Private planting evidence storage is unavailable.");
  if (!Array.isArray(files) || !files.length || files.length > 10 || files.reduce((n, f) => n + f.buffer.length, 0) > 40 * 1024 * 1024) throw fail(400, "Provide 1 to 10 original planting photos within the approved upload limits.");
  const revision = Number(input.expectedRevision);
  if (!/^\d+$/.test(String(input.expectedRevision ?? "")) || !Number.isSafeInteger(revision) || revision !== Number(ctx.data.revision || 0)) throw fail(409, "The assessment revision changed. Refresh before capturing again.");
  if (ctx.data.confirmationBasis !== "menro-field-report") throw fail(409, "Release-based confirmation is not photo/GPS verification.");
  const binding = { siteId: ctx.data.siteId, eventId: ctx.data.eventId, distributionId: ctx.data.requestId };
  const result = () => ({ hasEvidence: true, evidenceVerified: true, evidenceSubmissionId: ctx.primaryRef.id });
  return saga.runWorkflow({ actor: { uid: user.uid }, workflow: "planting-contribution", target: `official:${ctx.opRef.id}`, binding: { ...binding, revision },
    payload: { expectedRevision: revision, evidenceManifest: input.evidenceManifest || "" }, files, key }, async operation => {
    if (!operation) throw fail(503, "Private planting evidence storage is unavailable.");
    const sessions = await capture.resolveSubmissionEvidence({ actorId: user.uid, workflow: "planting-report", binding, files, manifest: input.evidenceManifest });
    const prepared = [], seen = new Set();
    for (let index = 0; index < files.length; index++) {
      const file = files[index], imageDetails = await images.validateImageBuffer(file.buffer), imageHash = images.generateImageHash(file.buffer), session = sessions[index];
      if (seen.has(imageHash)) throw fail(409, "Duplicate planting image detected."); seen.add(imageHash);
      const metadata = session ? { latitude: session.latitude, longitude: session.longitude,
        capturedAt: session.capturedAtClient.toDate ? session.capturedAtClient.toDate().toISOString() : new Date(Number(session.capturedAtClient.seconds ?? session.capturedAtClient._seconds) * 1000).toISOString(), gpsStatus: "browser-session" } : await images.extractImageMetadata(file.buffer);
      if (!session && images.isClearlyScreenshot({ fileName: file.originalname, metadata, imageDetails })) throw fail(400, "Screenshot images are not accepted as planting evidence.");
      const latitude = metadata.latitude, longitude = metadata.longitude;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !isPointWithinMunicipality(latitude, longitude)) throw fail(400, "Original photo GPS within Bulan is required. Device coordinates cannot replace EXIF GPS.");
      const verification = validatePlantingReport({ submittedLatitude: latitude, submittedLongitude: longitude, plantingDate: ctx.data.plantingDate, metadata });
      const radius = Number(ctx.site.coverageRadiusMeters), distance = calculateDistanceMeters(latitude, longitude, Number(ctx.site.latitude), Number(ctx.site.longitude));
      const siteValid = Number.isFinite(radius) && radius > 0 ? distance <= radius : Array.isArray(ctx.site.polygon) && ctx.site.polygon.length >= 3 ? isPointInPolygon(latitude, longitude, ctx.site.polygon) : distance <= 50;
      // Field evidence must actually satisfy the established location/time checks.
      // A release-only declaration never enters this path.
      if (!siteValid || !verification.timestampValid || !verification.gpsValid) throw fail(422, "Verify the photo's original location and planting timestamp before uploading.");
      const prior = await db.collection("plantingEvidenceHashes").doc(imageHash).get();
      if (prior.exists) throw fail(409, "Duplicate planting image detected.");
      const older = await Promise.all([db.collection("plantingReports").where("imageHash", "==", imageHash).limit(1).get(),
        db.collection("plantingReports").where("imageHashes", "array-contains", imageHash).limit(1).get(),
        db.collection("plantingContributions").where("imageHashes", "array-contains", imageHash).limit(1).get()]);
      if (older.some(snapshot => snapshot.docs.length)) throw fail(409, "Duplicate planting image detected.");
      prepared.push({ imageHash, imageDetails, metadata, latitude, longitude, gpsMetadataPresent: true, timestampMetadataPresent: true, gpsValid: true, timestampValid: true,
        siteGpsValid: true, siteGpsDistanceMeters: distance, siteCoverageRadiusMeters: Number.isFinite(radius) && radius > 0 ? radius : null,
        locationSource: session ? "Browser Capture Session" : "Photo Metadata (EXIF)", automatedStatus: "Passed Automated Check", suspiciousFlags: [] });
    }
    const photos = [];
    for (let index = 0; index < prepared.length; index++) photos.push({ ...prepared[index], hasEvidence: true,
      privateEvidence: await saga.workflow().upload(operation, index, files[index], { recordId: ctx.primaryRef.id, evidenceType: "planting-contribution" }) });
    await db.runTransaction(async tx => {
      const complete = await saga.workflow().prepareLink(tx, operation), consume = await capture.prepareConsumption(tx, sessions);
      const [op, ...rows] = await Promise.all([tx.get(ctx.opRef), ...ctx.operation.submissionIds.map(rowId => tx.get(db.collection("plantingContributions").doc(rowId)))]);
      const hashes = await Promise.all(photos.map(photo => tx.get(db.collection("plantingEvidenceHashes").doc(photo.imageHash))));
      const [site, event, distribution] = await Promise.all([tx.get(db.collection("sites").doc(ctx.data.siteId)),
        tx.get(db.collection("events").doc(ctx.data.eventId)), tx.get(db.collection("distributions").doc(ctx.data.requestId))]);
      if (!site.exists || siteSignature(site.data()) !== siteSignature(ctx.site) || !event.exists || event.data().plantingSiteId !== ctx.data.siteId || event.data().sourceRequestId !== ctx.data.requestId || !distribution.exists || distribution.data().eventId !== ctx.data.eventId || distribution.data().status !== "Released") throw fail(409, "The registered site or release changed. Refresh and verify new evidence before uploading.");
      if (!op.exists || op.data().staffId !== user.uid || op.data().evidenceVerified || rows.some(row => !row.exists || row.data().staffReviewStatus !== "Pending Review" || row.data().authenticatedSubmitterUid !== user.uid || Number(row.data().revision || 0) !== revision)) throw fail(409, "The official submission changed or has already been reviewed.");
      if (hashes.some(hash => hash.exists)) throw fail(409, "Duplicate planting image detected.");
      complete({ collection: "plantingContributions", recordId: ctx.primaryRef.id }); consume(ctx.primaryRef.id);
      for (const photo of photos) tx.create(db.collection("plantingEvidenceHashes").doc(photo.imageHash), { reportId: ctx.data.reportId, contributionId: ctx.primaryRef.id, eventId: ctx.data.eventId, createdAt: Timestamp.now() });
      for (const row of rows) tx.update(row.ref, { hasVerifiedPlantingEvidence: true, officialEvidenceSubmissionId: ctx.primaryRef.id,
        ...(row.id === ctx.primaryRef.id ? { photos, imageHashes: photos.map(photo => photo.imageHash) } : {}) });
      tx.update(ctx.opRef, { evidenceVerified: true, evidenceSubmissionId: ctx.primaryRef.id, evidenceRevision: revision });
    });
    return result();
  }, async () => {
    const op = await ctx.opRef.get(); if (!op.data()?.evidenceVerified) throw fail(409, "Evidence linkage could not be confirmed."); return result();
  });
}
module.exports = { upload };
