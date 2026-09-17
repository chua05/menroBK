const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { generateImageHash, validateImageBuffer, extractImageMetadata } = require("../utils/imageVerification.util");
const { validatePlantingReport } = require("../utils/plantingVerification.util");
const { calculateDistanceMeters } = require("../utils/geo.util");
const { savePlantingPhoto, deletePlantingPhoto } = require("./fileStorage.service");

const contributions = db.collection("plantingContributions");
const reports = db.collection("plantingReports");
const events = db.collection("events");
const evidenceHashes = db.collection("plantingEvidenceHashes");

async function attachEvidence(eventId, participantId, contributionId, files, input) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 10) {
    throw new Error("Provide 1 to 10 original planting evidence photos.");
  }
  const plantingDate = String(input?.plantingDate || "");
  const latitude = Number(input?.latitude);
  const longitude = Number(input?.longitude);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plantingDate) ||
      Number.isNaN(new Date(`${plantingDate}T00:00:00Z`).getTime()) ||
      new Date(`${plantingDate}T00:00:00Z`).toISOString().slice(0, 10) !== plantingDate ||
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Valid planting date and GPS coordinates are required.");
  }
  const contributionRef = contributions.doc(contributionId);
  const [contributionDoc, eventDoc] = await Promise.all([
    contributionRef.get(), events.doc(eventId).get(),
  ]);
  if (!contributionDoc.exists || contributionDoc.data().eventId !== eventId ||
      contributionDoc.data().participantId !== participantId || !eventDoc.exists) {
    throw new Error("Planting contribution not found.");
  }
  const event = eventDoc.data();
  if (!contributionDoc.data().reportId) {
    throw new Error("Planting contribution has no parent report.");
  }
  const reportRef = reports.doc(contributionDoc.data().reportId);
  const reportDoc = await reportRef.get();
  if (!reportDoc.exists || reportDoc.data().verificationStatus !== "Draft") {
    throw new Error("Planting report is no longer accepting evidence.");
  }
  if (!Number.isFinite(Number(event.latitude)) || !Number.isFinite(Number(event.longitude))) {
    throw new Error("The event has no valid planting site coordinates.");
  }
  const siteDistance = calculateDistanceMeters(
    latitude, longitude, Number(event.latitude), Number(event.longitude)
  );
  const photos = [];
  const saved = [];
  let persisted = false;
  const seen = new Set();
  try {
    for (const file of files) {
      const imageDetails = await validateImageBuffer(file.buffer);
      const imageHash = generateImageHash(file.buffer);
      if (seen.has(imageHash)) throw new Error("Duplicate evidence photos were detected.");
      seen.add(imageHash);
      const [legacy, older, other] = await Promise.all([
        reports.where("imageHash", "==", imageHash).limit(1).get(),
        reports.where("imageHashes", "array-contains", imageHash).limit(1).get(),
        contributions.where("imageHashes", "array-contains", imageHash).limit(1).get(),
      ]);
      if (!legacy.empty || !older.empty || !other.empty) {
        throw new Error("Duplicate planting image detected.");
      }
      const metadata = await extractImageMetadata(file.buffer);
      const verification = validatePlantingReport({
        submittedLatitude: latitude,
        submittedLongitude: longitude,
        plantingDate,
        metadata,
      });
      const flags = [...verification.suspiciousFlags];
      if (siteDistance > 20) flags.push("OUTSIDE_REGISTERED_SITE");
      const stored = await savePlantingPhoto({ file, participantId });
      saved.push(stored.filePath);
      photos.push({
        photoURL: stored.photoURL,
        photoPath: stored.filePath,
        imageHash,
        imageDetails,
        metadata,
        gpsMetadataPresent: verification.gpsMetadataPresent,
        timestampMetadataPresent: verification.timestampMetadataPresent,
        gpsDistanceMeters: verification.gpsDistanceMeters,
        gpsValid: verification.gpsValid,
        timestampValid: verification.timestampValid,
        siteGpsDistanceMeters: siteDistance,
        siteGpsValid: siteDistance <= 20,
        suspiciousFlags: flags,
        automatedStatus: flags.length ? "Flagged" : verification.automatedStatus,
      });
    }
    await db.runTransaction(async (transaction) => {
      const [latestContribution, latestReport, ...hashDocs] = await Promise.all([
        transaction.get(contributionRef),
        transaction.get(reportRef),
        ...photos.map((photo) => transaction.get(evidenceHashes.doc(photo.imageHash))),
      ]);
      if (!latestContribution.exists || latestContribution.data().participantId !== participantId ||
          latestContribution.data().eventId !== eventId || latestContribution.data().photos?.length) {
        throw new Error("Planting contribution is unavailable for evidence upload.");
      }
      if (!latestReport.exists || latestReport.data().verificationStatus !== "Draft") {
        throw new Error("Planting report is no longer accepting evidence.");
      }
      if (hashDocs.some((doc) => doc.exists)) throw new Error("Duplicate planting image detected.");
      const now = Timestamp.now();
      for (const photo of photos) {
        transaction.create(evidenceHashes.doc(photo.imageHash), {
          reportId: reportRef.id, contributionId, eventId, createdAt: now,
        });
      }
      transaction.update(contributionRef, {
        photos,
        imageHashes: photos.map((photo) => photo.imageHash),
        plantingDate,
        latitude,
        longitude,
        automatedVerificationStatus: photos.some((photo) => photo.automatedStatus === "Flagged")
          ? "Flagged" : "Passed Automated Check",
        suspiciousFlags: [...new Set(photos.flatMap((photo) => photo.suspiciousFlags))],
        updatedAt: now,
      });
      transaction.update(reportRef, { updatedAt: now });
    });
    persisted = true;
    const updated = await contributionRef.get();
    return { id: updated.id, ...updated.data() };
  } catch (error) {
    if (!persisted) {
      await Promise.all(saved.map((path) => deletePlantingPhoto(path).catch(() => {})));
    }
    throw error;
  }
}

module.exports = { attachEvidence };
