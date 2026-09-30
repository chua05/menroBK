const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { generateImageHash, validateImageBuffer, extractImageMetadata, isClearlyScreenshot } = require("../utils/imageVerification.util");
const { validatePlantingReport } = require("../utils/plantingVerification.util");
const { calculateDistanceMeters, isPointInPolygon, isPointInGeoJsonFeatureCollection } = require("../utils/geo.util");
const { savePlantingPhoto, deletePlantingPhoto } = require("./fileStorage.service");
const jubanBarangayBoundaries = require("../data/juban-barangays.json");

const contributions = db.collection("plantingContributions");
const reports = db.collection("plantingReports");
const events = db.collection("events");
const evidenceHashes = db.collection("plantingEvidenceHashes");

async function attachEvidence(eventId, participantId, contributionId, files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 10) {
    throw new Error("Provide 1 to 10 original planting evidence photos.");
  }
  const plantingDateValue = (await events.doc(eventId).get()).data()?.date;
  const plantingDateObject = typeof plantingDateValue?.toDate === "function"
    ? plantingDateValue.toDate()
    : new Date(plantingDateValue);
  const plantingDate = Number.isNaN(plantingDateObject.getTime())
    ? ""
    : plantingDateObject.toISOString().slice(0, 10);
  if (!plantingDate) throw new Error("The planting event has no valid event date.");
  const contributionRef = contributions.doc(contributionId);
  const [contributionDoc, eventDoc] = await Promise.all([
    contributionRef.get(), events.doc(eventId).get(),
  ]);
  if (!contributionDoc.exists || contributionDoc.data().eventId !== eventId ||
      contributionDoc.data().participantId !== participantId || !eventDoc.exists) {
    throw new Error("Planting contribution not found.");
  }
  const event = eventDoc.data();
  const siteDoc = event.plantingSiteId
    ? await db.collection("sites").doc(event.plantingSiteId).get()
    : null;
  if (!siteDoc?.exists) throw new Error("The planting event has no registered planting site.");
  const site = siteDoc.data();
  const siteLatitude = Number(site.latitude);
  const siteLongitude = Number(site.longitude);
  if (!Number.isFinite(siteLatitude) || siteLatitude < -90 || siteLatitude > 90 ||
      !Number.isFinite(siteLongitude) || siteLongitude < -180 || siteLongitude > 180) {
    throw new Error("The selected planting site has invalid coordinates.");
  }
  if (!contributionDoc.data().reportId) {
    throw new Error("Planting contribution has no parent report.");
  }
  const reportRef = reports.doc(contributionDoc.data().reportId);
  const reportDoc = await reportRef.get();
  const acceptingStatuses = ["Draft", "Pending", "Pending Review", "Awaiting Submission", "Partial"];
  if (!reportDoc.exists || !acceptingStatuses.includes(reportDoc.data().verificationStatus)) {
    throw new Error("Planting report is no longer accepting evidence.");
  }
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
      if (isClearlyScreenshot({ fileName: file.originalname, metadata, imageDetails })) {
        throw new Error("Screenshot images are not accepted as planting evidence.");
      }
      if (metadata.gpsStatus === "missing") throw new Error("Verification Failed — No GPS Metadata");
      if (metadata.gpsStatus === "unparseable") throw new Error("Verification Failed — GPS Metadata Unreadable");
      if (metadata.gpsStatus !== "valid" || !Number.isFinite(metadata.latitude) || !Number.isFinite(metadata.longitude) ||
          metadata.latitude < -90 || metadata.latitude > 90 || metadata.longitude < -180 || metadata.longitude > 180) {
        throw new Error("The photo contains invalid GPS coordinates.");
      }
      const photoLatitude = Number(metadata.latitude);
      const photoLongitude = Number(metadata.longitude);
      if (!isPointInGeoJsonFeatureCollection(photoLatitude, photoLongitude, jubanBarangayBoundaries)) {
        throw new Error("The photo is outside the Municipality of Juban.");
      }
      const verification = validatePlantingReport({
        submittedLatitude: photoLatitude,
        submittedLongitude: photoLongitude,
        plantingDate,
        metadata,
      });
      if (verification.suspiciousFlags.includes("FUTURE_IMAGE_TIMESTAMP")) {
        throw new Error("Photo capture timestamp is in the future and cannot be verified.");
      }
      const siteDistance = calculateDistanceMeters(photoLatitude, photoLongitude, siteLatitude, siteLongitude);
      const radius = Number(site.coverageRadiusMeters);
      const hasRadius = Number.isFinite(radius) && radius > 0;
      const hasPolygon = !hasRadius && Array.isArray(site.polygon) && site.polygon.length >= 3;
      const siteValid = hasRadius
        ? siteDistance <= radius
        : hasPolygon ? isPointInPolygon(photoLatitude, photoLongitude, site.polygon) : siteDistance <= 20;
      const flags = [...verification.suspiciousFlags];
      if (!siteValid) flags.push("OUTSIDE_REGISTERED_SITE");
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
        latitude: photoLatitude,
        longitude: photoLongitude,
        locationSource: "Photo Metadata (EXIF)",
        siteGpsDistanceMeters: siteDistance,
        siteGpsValid: siteValid,
        siteCoverageRadiusMeters: hasRadius ? radius : null,
        siteLocationStatus: siteValid ? "Within Assigned Site" : "Outside Assigned Site",
        municipalityScope: "inside",
        siteMatch: siteValid,
        suspiciousFlags: flags,
        automatedStatus: flags.length ? "Flagged" : "Passed Automated Check",
      });
    }
    await db.runTransaction(async (transaction) => {
      const eventRef = events.doc(eventId);
      const [latestContribution, latestReport, latestEvent, ...hashDocs] = await Promise.all([
        transaction.get(contributionRef),
        transaction.get(reportRef),
        transaction.get(eventRef),
        ...photos.map((photo) => transaction.get(evidenceHashes.doc(photo.imageHash))),
      ]);
      if (!latestContribution.exists || latestContribution.data().participantId !== participantId ||
          latestContribution.data().eventId !== eventId || latestContribution.data().photos?.length) {
        throw new Error("Planting contribution is unavailable for evidence upload.");
      }
      if (!latestReport.exists || !acceptingStatuses.includes(latestReport.data().verificationStatus)) {
        throw new Error("Planting report is no longer accepting evidence.");
      }
      if (!latestEvent.exists || latestEvent.data().allocationReleasedAt == null) {
        throw new Error("Seedlings have not been released for this event.");
      }
      if (hashDocs.some((doc) => doc.exists)) throw new Error("Duplicate planting image detected.");
      const now = Timestamp.now();
      const currentEvent = latestEvent.data();
      const inventoryId = latestContribution.data().inventoryId;
      const allocation = (currentEvent.seedlingItems || []).find((item) => item.inventoryId === inventoryId);
      if (!allocation) throw new Error("Seedling item is not allocated to this event.");
      const currentRecorded = Number(currentEvent.recordedSeedlingsByInventory?.[inventoryId] || 0);
      const remaining = Math.max(0, Number(allocation.quantity) - currentRecorded);
      const quantity = Number(latestContribution.data().quantity || 0);
      if (quantity > remaining) {
        throw new Error(`Quantity exceeds the remaining reportable quantity. Only ${remaining} trees remain available for reporting.`);
      }
      const hasNeedsReview = photos.some((photo) => photo.automatedStatus === "Flagged");
      const verificationStatus = hasNeedsReview ? "Needs Review" : "Verified";
      const staffReviewStatus = hasNeedsReview ? "Pending Review" : "Not Required";
      const report = latestReport.data();
      const released = Number(report.quantityReleased || currentEvent.seedlingTotalQuantity || 0);
      const active = Number(report.activeSubmittedQuantity || 0) + quantity;
      const accepted = Number(report.acceptedQuantity || 0) + (verificationStatus === "Verified" ? quantity : 0);
      const pending = Number(report.pendingReviewQuantity || 0) + (staffReviewStatus === "Pending Review" ? quantity : 0);
      const reportingProgress = released > 0 && accepted >= released && pending === 0
        ? "Completed"
        : released > 0 && active >= released && pending > 0
          ? "Fully Reported — Awaiting Review"
          : active > 0 ? "Partial" : "Awaiting Submission";
      const recorded = { ...(currentEvent.recordedSeedlingsByInventory || {}), [inventoryId]: currentRecorded + quantity };
      for (const photo of photos) {
        transaction.create(evidenceHashes.doc(photo.imageHash), {
          reportId: reportRef.id, contributionId, eventId, createdAt: now,
        });
      }
      transaction.update(contributionRef, {
        photos,
        imageHashes: photos.map((photo) => photo.imageHash),
        plantingDate,
        latitude: photos[0].latitude,
        longitude: photos[0].longitude,
        locationSource: "Photo Metadata (EXIF)",
        photoCapturedAt: photos[0].metadata.capturedAt || null,
        verificationStatus,
        staffReviewStatus,
        automatedVerificationStatus: hasNeedsReview ? "Flagged" : "Passed Automated Check",
        verificationDetails: [...new Set(photos.flatMap((photo) => photo.suspiciousFlags))],
        evidencePending: false,
        suspiciousFlags: [...new Set(photos.flatMap((photo) => photo.suspiciousFlags))],
        updatedAt: now,
      });
      transaction.update(eventRef, {
        recordedSeedlingsByInventory: recorded,
        recordedSeedlingQuantity: Number(currentEvent.recordedSeedlingQuantity || 0) + quantity,
        remainingSeedlingQuantity: Math.max(0, Number(currentEvent.seedlingTotalQuantity || 0) -
          Number(currentEvent.recordedSeedlingQuantity || 0) - quantity),
        updatedAt: now,
      });
      transaction.update(reportRef, {
        quantityPlanted: active,
        activeSubmittedQuantity: active,
        acceptedQuantity: accepted,
        pendingReviewQuantity: pending,
        remainingAvailableQuantity: Math.max(0, released - active),
        reportingProgress,
        verificationStatus: reportingProgress,
        updatedAt: now,
      });
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
