const { randomUUID } = require("crypto");

const {
  db,
  bucket,
} = require("../config/firebase");

const {
  Timestamp,
} = require("firebase-admin/firestore");

const {
  generateImageHash,
  validateImageBuffer,
  extractImageMetadata,
} = require("../utils/imageVerification.util");

const {
  validatePlantingReport,
} = require("../utils/plantingVerification.util");

const REPORT_COLLECTION = "plantingReports";
const DISTRIBUTION_COLLECTION = "distributions";

const reportCollection = db.collection(
  REPORT_COLLECTION
);

// UPLOAD PHOTO TO FIREBASE STORAGE
const uploadPlantingPhotoToStorage = async ({
  file,
  participantId,
}) => {
  const extensionMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };

  const extension =
    extensionMap[file.mimetype];

  if (!extension) {
    throw new Error(
      "Unsupported image file type."
    );
  }

  const filePath =
    `planting-reports/${participantId}/` +
    `${Date.now()}-${randomUUID()}.${extension}`;

  const downloadToken = randomUUID();

  const storageFile = bucket.file(filePath);

  await storageFile.save(file.buffer, {
    resumable: false,

    metadata: {
      contentType: file.mimetype,

      metadata: {
        originalName:
          file.originalname,

        firebaseStorageDownloadTokens:
          downloadToken,
      },
    },
  });

  const encodedPath =
    encodeURIComponent(filePath);

  const photoURL =
    `https://firebasestorage.googleapis.com/v0/b/` +
    `${bucket.name}/o/${encodedPath}` +
    `?alt=media&token=${downloadToken}`;

  return {
    filePath,
    photoURL,
  };
};

// FIND DUPLICATE IMAGE HASH
const findReportByImageHash = async (
  imageHash
) => {
  const snapshot = await reportCollection
    .where("imageHash", "==", imageHash)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];

  return {
    id: doc.id,
    ...doc.data(),
  };
};

// FIND EXISTING REPORT FOR DISTRIBUTION
const findReportByDistributionId = async (
  distributionId
) => {
  const snapshot = await reportCollection
    .where(
      "distributionId",
      "==",
      distributionId
    )
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];

  return {
    id: doc.id,
    ...doc.data(),
  };
};

// CREATE PLANTING REPORT
const createPlantingReport = async (
  data,
  file
) => {
  const distributionRef = db
    .collection(DISTRIBUTION_COLLECTION)
    .doc(data.distributionId);

  const distributionDoc =
    await distributionRef.get();

  if (!distributionDoc.exists) {
    throw new Error(
      "Distribution record not found."
    );
  }

  const distribution =
    distributionDoc.data();

  // Participant can only submit for their own distribution.
  if (
    distribution.participantId !==
    data.participantId
  ) {
    throw new Error(
      "You cannot submit a report for another participant's distribution."
    );
  }

  // Only released distributions can be planted.
  if (distribution.status !== "Released") {
    throw new Error(
      "Only released distributions can have planting reports."
    );
  }

  const quantityPlanted =
    Number(data.quantityPlanted);

  const quantityReleased =
    Number(distribution.quantityReleased);

  if (
    !Number.isInteger(quantityReleased) ||
    quantityReleased <= 0
  ) {
    throw new Error(
      "The linked distribution has an invalid released quantity."
    );
  }

  if (
    quantityPlanted >
    quantityReleased
  ) {
    throw new Error(
      "Quantity planted cannot exceed the released quantity."
    );
  }

  // One planting report per distribution.
  const existingDistributionReport =
    await findReportByDistributionId(
      data.distributionId
    );

  if (existingDistributionReport) {
    throw new Error(
      "A planting report already exists for this distribution."
    );
  }

  // Confirm that the uploaded buffer is a real image.
  const imageDetails =
    await validateImageBuffer(
      file.buffer
    );

  // Generate exact image hash.
  const imageHash =
    generateImageHash(file.buffer);

  const duplicateReport =
    await findReportByImageHash(
      imageHash
    );

  if (duplicateReport) {
    throw new Error(
      "Duplicate planting image detected."
    );
  }

  // Extract EXIF GPS, timestamp, and device data.
  const metadata =
    await extractImageMetadata(
      file.buffer
    );

  const submittedLatitude =
    Number(data.latitude);

  const submittedLongitude =
    Number(data.longitude);

  // Run automated GPS and timestamp checks.
  const automatedVerification =
    validatePlantingReport({
      submittedLatitude,
      submittedLongitude,
      plantingDate:
        data.plantingDate,
      metadata,
    });

  let uploadedImage = null;

  try {
    uploadedImage =
      await uploadPlantingPhotoToStorage({
        file,
        participantId:
          data.participantId,
      });

    const now = Timestamp.now();

    let capturedAtTimestamp = null;

    if (metadata.capturedAt) {
      const capturedAtDate =
        new Date(
          metadata.capturedAt
        );

      if (
        !Number.isNaN(
          capturedAtDate.getTime()
        )
      ) {
        capturedAtTimestamp =
          Timestamp.fromDate(
            capturedAtDate
          );
      }
    }

    const reportData = {
      distributionId:
        data.distributionId,

      requestId:
        distribution.requestId,

      inventoryId:
        distribution.inventoryId,

      participantId:
        data.participantId,

      participantName:
        distribution.participantName,

      organization:
        distribution.organization,

      species:
        distribution.species,

      quantityReleased,

      quantityPlanted,

      plantingDate:
        data.plantingDate,

      plantingLocation:
        data.plantingLocation,

      latitude:
        submittedLatitude,

      longitude:
        submittedLongitude,

      remarks:
        data.remarks?.trim() || "",

      photoURL:
        uploadedImage.photoURL,

      photoPath:
        uploadedImage.filePath,

      imageHash,

      imageDetails: {
        width:
          imageDetails.width,

        height:
          imageDetails.height,

        format:
          imageDetails.format,
      },

      metadata: {
        latitude:
          metadata.latitude,

        longitude:
          metadata.longitude,

        capturedAt:
          capturedAtTimestamp,

        make:
          metadata.deviceMake || "",

        model:
          metadata.deviceModel || "",
      },

      duplicateDetected: false,

      gpsMetadataPresent:
        automatedVerification
          .gpsMetadataPresent,

      timestampMetadataPresent:
        automatedVerification
          .timestampMetadataPresent,

      gpsDistanceMeters:
        automatedVerification
          .gpsDistanceMeters,

      gpsValid:
        automatedVerification
          .gpsValid,

      timestampValid:
        automatedVerification
          .timestampValid,

      suspiciousFlags:
        automatedVerification
          .suspiciousFlags,

      verificationStatus:
        automatedVerification
          .automatedStatus,

      reviewedBy: "",
      approvedBy: "",
      rejectedBy: "",

      createdAt: now,
      updatedAt: now,
    };

    const docRef =
      await reportCollection.add(
        reportData
      );

    return {
      id: docRef.id,
      ...reportData,
    };
  } catch (error) {
    // Remove uploaded image if saving the report fails.
    if (uploadedImage?.filePath) {
      try {
        await bucket
          .file(
            uploadedImage.filePath
          )
          .delete({
            ignoreNotFound: true,
          });
      } catch (cleanupError) {
        console.error(
          "Failed to clean up uploaded planting photo:",
          cleanupError
        );
      }
    }

    throw error;
  }
};

// GET ALL PLANTING REPORTS
const getAllPlantingReports = async (
  {
    verificationStatus,
    participantId,
    distributionId,
  } = {}
) => {
  const snapshot =
    await reportCollection.get();

  let reports =
    snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

  if (verificationStatus) {
    reports = reports.filter(
      (report) =>
        report.verificationStatus
          ?.toLowerCase() ===
        verificationStatus.toLowerCase()
    );
  }

  if (participantId) {
    reports = reports.filter(
      (report) =>
        report.participantId ===
        participantId
    );
  }

  if (distributionId) {
    reports = reports.filter(
      (report) =>
        report.distributionId ===
        distributionId
    );
  }

  return reports;
};

// GET PLANTING REPORT BY ID
const getPlantingReportById = async (
  id
) => {
  const doc = await reportCollection
    .doc(id)
    .get();

  if (!doc.exists) {
    throw new Error(
      "Planting report not found."
    );
  }

  return {
    id: doc.id,
    ...doc.data(),
  };
};

// GET REPORTS OF CURRENT PARTICIPANT
const getPlantingReportsByParticipantId =
  async (participantId) => {
    const snapshot =
      await reportCollection
        .where(
          "participantId",
          "==",
          participantId
        )
        .get();

    return snapshot.docs.map(
      (doc) => ({
        id: doc.id,
        ...doc.data(),
      })
    );
  };

module.exports = {
  createPlantingReport,
  getAllPlantingReports,
  getPlantingReportById,
  getPlantingReportsByParticipantId,
};