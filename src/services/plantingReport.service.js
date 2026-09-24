const { db } = require("../config/firebase");
const { nextRecordNumber } = require("../utils/recordNumber.util");
const { createNotificationInTransaction } = require("./notification.service");
const { parentForEventInTransaction, reportDetails } = require("./parentPlantingReport.service");

const {
  createVerificationLogInTransaction,
  getVerificationLogsByPlantingReportId,
} = require(
  "./verificationLog.service"
);

const {
  savePlantingPhoto,
  deletePlantingPhoto,
} = require(
  "./fileStorage.service"
);

const {
  Timestamp,
} = require(
  "firebase-admin/firestore"
);

const {
  generateImageHash,
  validateImageBuffer,
  extractImageMetadata,
  isClearlyScreenshot,
} = require(
  "../utils/imageVerification.util"
);

const {
  validatePlantingReport,
} = require(
  "../utils/plantingVerification.util"
);

const {
  calculateDistanceMeters,
  isPointInPolygon,
} = require(
  "../utils/geo.util"
);


const REPORT_COLLECTION =
  "plantingReports";

const DISTRIBUTION_COLLECTION =
  "distributions";

const SITE_COLLECTION =
  "sites";

const EVENT_COLLECTION =
  "events";
const contributionCollection = db.collection("plantingContributions");
const evidenceHashCollection = db.collection("plantingEvidenceHashes");

const SITE_GPS_TOLERANCE_METERS =
  20;

const MAX_EVIDENCE_PHOTOS =
  10;

const PHOTO_EXIF_LOCATION_SOURCE =
  "Photo Metadata (EXIF)";

const DEVICE_CAPTURE_LOCATION_SOURCE =
  "Device Location at Capture";

const automatedVerificationStatus = (flags) =>
  flags.length === 0 ? "Passed Automated Check" : "Flagged";

const reportCollection =
  db.collection(
    REPORT_COLLECTION
  );

const reportRefFor = (id) => {
  if (typeof id !== "string" || !id.trim() || id.includes("/")) {
    throw new Error("Invalid planting report ID.");
  }
  return reportCollection.doc(id);
};

// Legacy unfinalized records are presented as pending without rewriting Firestore.
const LEGACY_PENDING_STATUSES = [
  "Passed Automated Check",
  "Flagged",
  "Reviewed",
];

const workflowStatus = (status) =>
  LEGACY_PENDING_STATUSES.includes(status)
    ? "Pending Review"
    : status;

const withWorkflowStatus = (doc) => {
  const data = doc.data();
  const legacyAutomatedStatus = ["Flagged", "Passed Automated Check"]
    .includes(data.verificationStatus)
    ? data.verificationStatus
    : undefined;
  return {
    id: doc.id,
    ...data,
    verificationStatus: data.reportType === "parent" && data.verificationStatus === "Draft"
      ? "Pending" : workflowStatus(data.verificationStatus),
    ...(data.automatedVerificationStatus === undefined && legacyAutomatedStatus
      ? { automatedVerificationStatus: legacyAutomatedStatus }
      : {}),
  };
};


// --------------------------------
// FIND DUPLICATE IMAGE HASH
//
// Supports:
//
// Legacy reports:
// imageHash
//
// New reports:
// imageHashes[]
// --------------------------------
const findReportByImageHash = async (
  imageHash
) => {
  // Legacy single-photo reports
  const legacySnapshot =
    await reportCollection
      .where(
        "imageHash",
        "==",
        imageHash
      )
      .limit(1)
      .get();

  if (
    !legacySnapshot.empty
  ) {
    const doc =
      legacySnapshot.docs[0];

    return {
      id: doc.id,
      ...doc.data(),
    };
  }


  // New multiple-photo reports
  const multiPhotoSnapshot =
    await reportCollection
      .where(
        "imageHashes",
        "array-contains",
        imageHash
      )
      .limit(1)
      .get();

  if (
    multiPhotoSnapshot.empty
  ) {
    const contributionSnapshot = await contributionCollection
      .where("imageHashes", "array-contains", imageHash).limit(1).get();
    return contributionSnapshot.empty ? null : {
      id: contributionSnapshot.docs[0].id,
      ...contributionSnapshot.docs[0].data(),
    };
  }

  const doc =
    multiPhotoSnapshot.docs[0];

  return {
    id: doc.id,
    ...doc.data(),
  };
};


// --------------------------------
// FIND EXISTING REPORT
// FOR DISTRIBUTION
// --------------------------------
const findReportByDistributionId =
  async (distributionId) => {
    const snapshot =
      await reportCollection
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

    const doc =
      snapshot.docs[0];

    return {
      id: doc.id,
      ...doc.data(),
    };
  };


// --------------------------------
// CONVERT DATE TO FIRESTORE
// TIMESTAMP WHEN VALID
// --------------------------------
const toTimestampOrNull = (
  value
) => {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return Timestamp.fromDate(
    date
  );
};


// --------------------------------
// CREATE PLANTING REPORT
// --------------------------------
const createPlantingReport = async (
  data,
  files
) => {
  // --------------------------------
  // 1. VALIDATE PHOTO COUNT
  // --------------------------------
  const evidenceFiles =
    Array.isArray(files)
      ? files
      : [];

  if (
    evidenceFiles.length === 0
  ) {
    throw new Error(
      "At least one planting evidence photo is required."
    );
  }

  if (
    evidenceFiles.length >
    MAX_EVIDENCE_PHOTOS
  ) {
    throw new Error(
      "A maximum of 10 planting evidence photos is allowed."
    );
  }


  // --------------------------------
  // 2. GET DISTRIBUTION
  // --------------------------------
  const distributionRef = db
    .collection(
      DISTRIBUTION_COLLECTION
    )
    .doc(
      data.distributionId
    );

  const distributionDoc =
    await distributionRef.get();

  if (
    !distributionDoc.exists
  ) {
    throw new Error(
      "Distribution record not found."
    );
  }

  const distribution =
    distributionDoc.data();


  // --------------------------------
  // 3. VERIFY DISTRIBUTION STATUS
  // --------------------------------
  if (
    distribution.status !==
    "Released"
  ) {
    throw new Error(
      "Only released distributions can have planting reports."
    );
  }

  const distributionItems = Array.isArray(distribution.items)
    ? distribution.items
    : [];
  const selectedDistributionItem = distributionItems.length > 0
    ? distributionItems.find((item) =>
        String(item.inventoryId || "") === String(data.inventoryId || "")) ||
      (distributionItems.length === 1 ? distributionItems[0] : null)
    : null;

  if (distributionItems.length > 0 && !selectedDistributionItem) {
    throw new Error("Select a released sapling tree item for this submission.");
  }

  const plantingDate = data.plantingDate;
  if (typeof plantingDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(plantingDate) ||
      Number.isNaN(Date.parse(`${plantingDate}T00:00:00Z`)) ||
      new Date(`${plantingDate}T00:00:00Z`).toISOString().slice(0, 10) !== plantingDate) {
    throw new Error("A valid planting date is required.");
  }


  // --------------------------------
  // 5. VALIDATE QUANTITY
  // --------------------------------
  const quantityPlanted =
    Number(
      data.quantityPlanted
    );

  const quantityReleased = Number(
    selectedDistributionItem?.releasedQuantity ??
    selectedDistributionItem?.quantity ??
    distribution.totalQuantityReleased ??
    distribution.quantityReleased
  );

  const requestedQuantity = Number(
    selectedDistributionItem?.requestedQuantity ??
    selectedDistributionItem?.quantity ??
    distribution.requestedQuantity ??
    quantityReleased
  );

  if (
    !Number.isInteger(
      quantityPlanted
    ) ||
    quantityPlanted <= 0
  ) {
    throw new Error(
      "Please enter a valid quantity of planted saplings."
    );
  }

  if (
    !Number.isInteger(
      quantityReleased
    ) ||
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
      "The quantity planted cannot exceed the remaining released sapling quantity."
    );
  }


  // --------------------------------
  // 6. ONE REPORT PER DISTRIBUTION
  // --------------------------------
  const existingDistributionReport =
    await findReportByDistributionId(
      data.distributionId
    );

  if (existingDistributionReport && !distribution.eventId) {
    throw new Error(
      "A planting report already exists for this distribution."
    );
  }


  // --------------------------------
  // 7. GET REGISTERED
  // PLANTING SITE
  // --------------------------------
  const siteRef = db
    .collection(
      SITE_COLLECTION
    )
    .doc(
      data.siteId
    );

  const siteDoc =
    await siteRef.get();

  if (!siteDoc.exists) {
    throw new Error(
      "Planting site not found."
    );
  }

  const site =
    siteDoc.data();

  if (
    site.status === "inactive"
  ) {
    throw new Error(
      "The selected planting site is inactive."
    );
  }

  const siteLatitude =
    Number(
      site.latitude
    );

  const siteLongitude =
    Number(
      site.longitude
    );

  if (
    Number.isNaN(
      siteLatitude
    ) ||
    siteLatitude < -90 ||
    siteLatitude > 90 ||
    Number.isNaN(
      siteLongitude
    ) ||
    siteLongitude < -180 ||
    siteLongitude > 180
  ) {
    throw new Error(
      "The selected planting site has invalid coordinates."
    );
  }


  
// VALIDATE EVENT RELATIONSHIP
let linkedEvent = null;

const submittedEventId = String(data.eventId || distribution.eventId || "").trim();
const isOriginalRequester = distribution.participantId === data.participantId;
let eventParticipationId = null;
if (distribution.eventId && submittedEventId !== distribution.eventId) {
  throw new Error("Selected event does not match the released distribution.");
}

if (submittedEventId) {
  const eventRef = db
    .collection(
      EVENT_COLLECTION
    )
    .doc(
      submittedEventId
    );

  const eventDoc =
    await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error(
      "Selected planting event was not found."
    );
  }

  linkedEvent =
    eventDoc.data();

  if (linkedEvent.sourceRequestId && linkedEvent.sourceRequestId !== distribution.requestId) {
    throw new Error("Selected event does not match the released distribution.");
  }

  if (distribution.plantingSiteId && distribution.plantingSiteId !== data.siteId) {
    throw new Error("Selected planting site does not match the released distribution.");
  }

  if (
    linkedEvent.archived === true
  ) {
    throw new Error(
      "The selected planting event is archived."
    );
  }

  if (
    String(
      linkedEvent.status || ""
    )
      .trim()
      .toLowerCase() ===
    "cancelled"
  ) {
    throw new Error(
      "The selected planting event has been cancelled."
    );
  }

  const eventRecordStatus =
    String(
      linkedEvent.recordStatus ||
        ""
    )
      .trim()
      .toLowerCase();

  const allowedEventStatuses = [
    "authorized",
    "scheduled",
    "approved",
    "completed",
  ];

  if (
    !allowedEventStatuses.includes(
      eventRecordStatus
    )
  ) {
    throw new Error(
      "The selected planting event is not available for planting reports."
    );
  }

  const eventSiteId =
    String(
      linkedEvent.plantingSiteId ||
        ""
    );

  if (
    eventSiteId !==
    String(data.siteId)
  ) {
    throw new Error(
      "The selected planting event does not belong to the selected planting site."
    );
  }

  const eventBarangay =
    String(
      linkedEvent.barangay ||
        ""
    )
      .trim()
      .toLowerCase();

  const siteBarangay =
    String(
      site.barangay ||
        ""
    )
      .trim()
      .toLowerCase();

  if (
    eventBarangay !==
    siteBarangay
  ) {
    throw new Error(
      "The selected planting event does not belong to the selected barangay."
    );
  }

  if (!isOriginalRequester) {
    const participationSnapshot = await db
      .collection("eventParticipants")
      .where("userId", "==", data.participantId)
      .get();
    const participationDoc = participationSnapshot.docs.find((doc) => {
      const participant = doc.data();
      return participant.eventId === submittedEventId &&
        participant.participantType === "participant";
    });
    if (!participationDoc) {
      throw new Error("You are not registered for the selected planting event.");
    }
    eventParticipationId = participationDoc.id;
  }

}

if (!isOriginalRequester && !submittedEventId) {
  throw new Error("You are not registered for the selected planting event.");
}


  // --------------------------------
  // 12. VALIDATE ALL PHOTOS
  // BEFORE SAVING ANYTHING
  // --------------------------------
  const preparedPhotos = [];

  const locationSource = data.locationSource === DEVICE_CAPTURE_LOCATION_SOURCE
    ? DEVICE_CAPTURE_LOCATION_SOURCE
    : PHOTO_EXIF_LOCATION_SOURCE;
  const usesDeviceCaptureLocation = locationSource === DEVICE_CAPTURE_LOCATION_SOURCE;
  const submittedLatitude = Number(data.latitude);
  const submittedLongitude = Number(data.longitude);
  const submittedAccuracy = data.accuracy === "" || data.accuracy === undefined
    ? null
    : Number(data.accuracy);
  const submittedLocationCapturedAt = toTimestampOrNull(data.locationCapturedAt);
  const submittedPhotoCapturedAt = toTimestampOrNull(data.photoCapturedAt);

  if (usesDeviceCaptureLocation && (
    !Number.isFinite(submittedLatitude) || submittedLatitude < -90 || submittedLatitude > 90
  )) {
    throw new Error("Latitude must be between -90 and 90.");
  }

  if (usesDeviceCaptureLocation && (
    !Number.isFinite(submittedLongitude) || submittedLongitude < -180 || submittedLongitude > 180
  )) {
    throw new Error("Longitude must be between -180 and 180.");
  }

  if (usesDeviceCaptureLocation && (!submittedLocationCapturedAt || !submittedPhotoCapturedAt)) {
    throw new Error("A valid device location and capture timestamp are required for a photo taken within the system.");
  }

  const submissionHashes =
    new Set();

  for (
    const file of
    evidenceFiles
  ) {
    // Confirm actual image buffer
    const imageDetails =
      await validateImageBuffer(
        file.buffer
      );


    // Generate SHA-256 hash
    const imageHash =
      generateImageHash(
        file.buffer
      );


    // Duplicate inside the
    // same submission
    if (
      submissionHashes.has(
        imageHash
      )
    ) {
      throw new Error(
        "Duplicate evidence photos were detected in this submission."
      );
    }

    submissionHashes.add(
      imageHash
    );


    // Duplicate against
    // previous reports
    const duplicateReport =
      await findReportByImageHash(
        imageHash
      );

    if (duplicateReport) {
      throw new Error(
        "Duplicate planting image detected."
      );
    }


    // Extract EXIF metadata
    const metadata =
      await extractImageMetadata(
        file.buffer
      );

    if (isClearlyScreenshot({ fileName: file.originalname, metadata, imageDetails })) {
      throw new Error(
        "Screenshot images are not accepted as planting evidence. Please upload the original geotagged photo."
      );
    }

    const hasPhotoGpsValues = metadata.latitude !== null && metadata.latitude !== undefined &&
      metadata.longitude !== null && metadata.longitude !== undefined;
    const photoLatitude = usesDeviceCaptureLocation
      ? submittedLatitude
      : hasPhotoGpsValues ? Number(metadata.latitude) : NaN;
    const photoLongitude = usesDeviceCaptureLocation
      ? submittedLongitude
      : hasPhotoGpsValues ? Number(metadata.longitude) : NaN;
    const hasValidPhotoGps =
      Number.isFinite(photoLatitude) && photoLatitude >= -90 && photoLatitude <= 90 &&
      Number.isFinite(photoLongitude) && photoLongitude >= -180 && photoLongitude <= 180;

    if (!hasValidPhotoGps) {
      throw new Error(
        hasPhotoGpsValues && !usesDeviceCaptureLocation
          ? "This photo contains invalid GPS coordinates. Please upload an original geotagged photo with valid location information."
          : "This photo does not contain GPS location metadata. Please upload an original geotagged photo with location information."
      );
    }


    // Existing automated
    // photo verification
    const verificationMetadata = usesDeviceCaptureLocation
      ? {
          ...metadata,
          latitude: photoLatitude,
          longitude: photoLongitude,
          capturedAt: data.photoCapturedAt,
        }
      : metadata;

    const photoVerification =
      validatePlantingReport({
        // The shared validator handles metadata presence and capture-time checks.
        // Site verification is performed below against the saved polygon/center.
        submittedLatitude: photoLatitude,
        submittedLongitude: photoLongitude,
        plantingDate:
          data.plantingDate,
        metadata: verificationMetadata,
      });


    // Create a new array so
    // we do not mutate a shared
    // reference unexpectedly.
    const photoFlags = [
      ...(
        photoVerification
          .suspiciousFlags ||
        []
      ),
    ];


    const photoSiteDistanceMeters = calculateDistanceMeters(
      photoLatitude,
      photoLongitude,
      siteLatitude,
      siteLongitude
    );
    const hasSitePolygon = Array.isArray(site.polygon) && site.polygon.length >= 3;
    const photoSiteValid = hasSitePolygon
      ? isPointInPolygon(photoLatitude, photoLongitude, site.polygon)
      : photoSiteDistanceMeters <= SITE_GPS_TOLERANCE_METERS;

    // Registered site check using authoritative photo EXIF coordinates.
    if (!photoSiteValid) {
      if (
        !photoFlags.includes(
          "OUTSIDE_REGISTERED_SITE"
        )
      ) {
        photoFlags.push(
          "OUTSIDE_REGISTERED_SITE"
        );
      }
    }


    const photoAutomatedStatus = automatedVerificationStatus(photoFlags);


    preparedPhotos.push({
      file,

      imageHash,

      imageDetails,

      metadata,

      latitude: photoLatitude,

      longitude: photoLongitude,

      locationSource,

      locationAccuracyMeters: usesDeviceCaptureLocation && Number.isFinite(submittedAccuracy)
        ? submittedAccuracy
        : null,

      locationCapturedAt: usesDeviceCaptureLocation
        ? submittedLocationCapturedAt
        : toTimestampOrNull(metadata.capturedAt),

      photoCapturedAt: usesDeviceCaptureLocation
        ? submittedPhotoCapturedAt
        : toTimestampOrNull(metadata.capturedAt),

      gpsMetadataPresent:
        usesDeviceCaptureLocation
          ? false
          : photoVerification.gpsMetadataPresent,

      timestampMetadataPresent:
        usesDeviceCaptureLocation
          ? false
          : photoVerification.timestampMetadataPresent,

      // GPS validity and assigned-site matching are separate results.
      // Reaching this point means the original photo has valid EXIF GPS.
      gpsValid: true,

      // Keep the legacy distance field while also naming the site comparison explicitly.
      gpsDistanceMeters: photoSiteDistanceMeters,

      siteGpsDistanceMeters: photoSiteDistanceMeters,

      siteGpsValid: photoSiteValid,

      siteLocationStatus: photoSiteValid
        ? "Within Assigned Site"
        : "Outside Assigned Site",

      timestampValid:
        photoVerification
          .timestampValid,

      suspiciousFlags:
        photoFlags,

      automatedStatus:
        photoAutomatedStatus,
    });
  }


  // --------------------------------
  // 13. BUILD REPORT-LEVEL
  // VERIFICATION RESULT
  // --------------------------------
  const reportFlags =
    new Set();

  preparedPhotos.forEach(
    (photo) => {
      (
        photo.suspiciousFlags ||
        []
      ).forEach(
        (flag) => {
          reportFlags.add(
            flag
          );
        }
      );
    }
  );

  const suspiciousFlags =
    Array.from(
      reportFlags
    );

  const automatedStatus = automatedVerificationStatus(suspiciousFlags);


  // --------------------------------
  // 14. SAVE ALL PHOTOS
  // --------------------------------
  const uploadedPhotos = [];
  let persisted = false;
  const now = Timestamp.now();

  try {
    for (
      const preparedPhoto of
      preparedPhotos
    ) {
      const uploadedImage =
        await savePlantingPhoto({
          file:
            preparedPhoto.file,

          participantId:
            data.participantId,
        });


      const capturedAtTimestamp =
        preparedPhoto.photoCapturedAt;


      uploadedPhotos.push({
        photoURL:
          uploadedImage.photoURL,

        photoPath:
          uploadedImage.filePath,

        imageHash:
          preparedPhoto.imageHash,

        imageDetails: {
          width:
            preparedPhoto
              .imageDetails
              .width,

          height:
            preparedPhoto
              .imageDetails
              .height,

          format:
            preparedPhoto
              .imageDetails
              .format,
        },

        metadata: {
          latitude:
            preparedPhoto
              .metadata
              .latitude,

          longitude:
            preparedPhoto
              .metadata
              .longitude,

          capturedAt:
            capturedAtTimestamp,

          make:
            preparedPhoto
              .metadata
              .deviceMake ||
            "",

          model:
            preparedPhoto
              .metadata
              .deviceModel ||
            "",

          software:
            preparedPhoto.metadata.software || "",

          orientation:
            preparedPhoto.metadata.orientation ?? null,
        },

        uploadedAt: now,

        latitude:
          preparedPhoto.latitude,

        longitude:
          preparedPhoto.longitude,

        locationSource:
          preparedPhoto.locationSource,

        locationAccuracyMeters:
          preparedPhoto.locationAccuracyMeters,

        locationCapturedAt:
          preparedPhoto.locationCapturedAt,

        photoCapturedAt:
          preparedPhoto.photoCapturedAt,

        gpsMetadataPresent:
          preparedPhoto
            .gpsMetadataPresent,

        timestampMetadataPresent:
          preparedPhoto
            .timestampMetadataPresent,

        gpsDistanceMeters:
          preparedPhoto
            .gpsDistanceMeters,

        gpsValid:
          preparedPhoto
            .gpsValid,

        siteGpsDistanceMeters:
          preparedPhoto
            .siteGpsDistanceMeters,

        siteGpsValid:
          preparedPhoto
            .siteGpsValid,

        siteLocationStatus:
          preparedPhoto
            .siteLocationStatus,

        timestampValid:
          preparedPhoto
            .timestampValid,

        suspiciousFlags:
          preparedPhoto
            .suspiciousFlags,

        automatedStatus:
          preparedPhoto
            .automatedStatus,
      });
    }


    // --------------------------------
    // 15. BACKWARD-COMPATIBLE
    // PRIMARY PHOTO
    //
    // Existing frontend can still
    // read photoURL/photoPath/etc.
    // until PlantingPage.jsx is
    // updated to use photos[].
    // --------------------------------
    const primaryPhoto =
      uploadedPhotos[0];

    const photoLatitude = Number(primaryPhoto.latitude);
    const photoLongitude = Number(primaryPhoto.longitude);
    const photoTakenAt = primaryPhoto.photoCapturedAt;
    const siteGpsDistanceMeters = Number(primaryPhoto.siteGpsDistanceMeters);


    // --------------------------------
    // REPORT-LEVEL SUMMARY
    // --------------------------------
    const allGpsMetadataPresent =
      uploadedPhotos.every(
        (photo) =>
          photo.gpsMetadataPresent
      );

    const allTimestampMetadataPresent =
      uploadedPhotos.every(
        (photo) =>
          photo
            .timestampMetadataPresent
      );

    const allGpsValid =
      uploadedPhotos.every(
        (photo) =>
          photo.gpsValid === true
      );

    const allPhotosWithinAssignedSite = uploadedPhotos.every(
      (photo) => photo.siteGpsValid === true
    );

    const siteGpsValid = allPhotosWithinAssignedSite;
    const siteLocationStatus = allPhotosWithinAssignedSite
      ? "Within Assigned Site"
      : "Outside Assigned Site";

    const allTimestampValid =
      uploadedPhotos.every(
        (photo) =>
          photo.timestampValid ===
          true
      );

    const validGpsDistances =
      uploadedPhotos
    .map((photo) =>
      photo.gpsDistanceMeters
    )
    .filter(
      (distance) =>
        distance !== null &&
        distance !== undefined &&
        Number.isFinite(
          Number(distance)
        )
    )
    .map(
      (distance) =>
        Number(distance)
    );

    const maximumPhotoGpsDistance =
      validGpsDistances.length > 0
        ? Math.max(
            ...validGpsDistances
          )
        : null;


    // --------------------------------
    // 16. CREATE REPORT DATA
    // --------------------------------
    const reportData = {
      distributionId:
        data.distributionId,

      requestId:
        distribution.requestId ||
        "",

      requestNumber:
        distribution.requestNumber ||
        "",

      inventoryId:
        selectedDistributionItem?.inventoryId ||
        distribution.inventoryId ||
        "",

      participantId:
        data.participantId,

      participantName:
        data.participantName ||
        distribution.participantName ||
        "",

      participantType:
        data.participantType ||
        "",

      participantContactNumber:
        data.participantContactNumber ||
        "",

      participantBarangay:
        data.participantBarangay ||
        "",

      organizationAffiliation:
        data
          .organizationAffiliation ||
        "",

      organization:
        distribution.organization ||
        "",

      species:
        selectedDistributionItem?.species ||
        distribution.species ||
        "",

      requestedQuantity,

      quantityReleased,

      quantityPlanted,

      plantingDate:
        data.plantingDate,


      // --------------------------------
      // REGISTERED PLANTING SITE
      // --------------------------------
      siteId:
        data.siteId,

      siteName:
        site.siteName || "",

      barangay:
        site.barangay || "",

      municipality:
        site.municipality || "",

      province:
        site.province || "",

      plantingLocation:
        data.plantingLocation ||
        site.siteName ||
        "",


      
      // EVENT REFERENCE
  
          eventId:
      linkedEvent
        ? linkedEvent.eventId ||
          linkedEvent.id ||
          submittedEventId
        : "",

    eventName:
      linkedEvent
        ? linkedEvent.name || ""
        : "",


      // --------------------------------
      // AUTHORITATIVE GPS EXTRACTED FROM PRIMARY PHOTO EXIF
      // --------------------------------
      latitude:
        photoLatitude,

      longitude:
        photoLongitude,

      gpsAccuracyMeters: primaryPhoto.locationAccuracyMeters,

      locationSource,

      locationCapturedAt:
        primaryPhoto.locationCapturedAt,

      photoTakenAt,


      // --------------------------------
      // REGISTERED SITE GPS
      // --------------------------------
      siteLatitude,

      siteLongitude,

      siteGpsDistanceMeters,

      siteGpsValid,

      siteLocationStatus,

      siteGpsToleranceMeters:
        SITE_GPS_TOLERANCE_METERS,


      remarks:
        data.remarks?.trim() ||
        "",


      // --------------------------------
      // NEW MULTIPLE-PHOTO STRUCTURE
      // --------------------------------
      photoCount:
        uploadedPhotos.length,

      photos:
        uploadedPhotos,

      imageHashes:
        uploadedPhotos.map(
          (photo) =>
            photo.imageHash
        ),


      // --------------------------------
      // TEMPORARY LEGACY PRIMARY
      // PHOTO FIELDS
      //
      // Keep these so the existing
      // frontend does not break.
      // --------------------------------
      photoURL:
        primaryPhoto.photoURL,

      photoPath:
        primaryPhoto.photoPath,

      imageHash:
        primaryPhoto.imageHash,

      imageDetails:
        primaryPhoto.imageDetails,

      metadata:
        primaryPhoto.metadata,


      duplicateDetected:
        false,


      // --------------------------------
      // REPORT-LEVEL PHOTO
      // VERIFICATION SUMMARY
      // --------------------------------
      gpsMetadataPresent:
        allGpsMetadataPresent,

      timestampMetadataPresent:
        allTimestampMetadataPresent,

      gpsDistanceMeters:
        maximumPhotoGpsDistance,

      gpsValid:
        allGpsValid,

      timestampValid:
        allTimestampValid,

      suspiciousFlags,


      // Keep the original automated result after Staff makes a final decision.
      automatedVerificationStatus:
        automatedStatus,

      verificationStatus:
        "Pending Review",


      reviewedBy: "",
      reviewedByName: "",
      reviewRemarks: "",
      reviewedAt: null,

      approvedBy: "",
      approvalRemarks: "",
      approvedAt: null,

      rejectedBy: "",
      rejectionRemarks: "",
      rejectedAt: null,

      createdAt:
        now,

      updatedAt:
        now,
    };


    // --------------------------------
    // 17. SAVE TO FIRESTORE
    // --------------------------------
    if (linkedEvent?.sourceRequestId) {
      const allocatedItems = linkedEvent.seedlingItems || [];
      const inventoryId = selectedDistributionItem?.inventoryId || data.inventoryId ||
        (allocatedItems.length === 1 ? allocatedItems[0].inventoryId : "");
      if (!inventoryId) throw new Error("Select a released sapling tree item for this submission.");
      const allocation = allocatedItems.find((item) => item.inventoryId === inventoryId);
      if (!allocation || !linkedEvent.allocationReleasedAt) {
        throw new Error("Sapling tree item has not been released for this event.");
      }
      const contributionRef = contributionCollection.doc();
      let parentId;
      await db.runTransaction(async (transaction) => {
        const eventRef = db.collection(EVENT_COLLECTION).doc(submittedEventId);
        const eventDoc = await transaction.get(eventRef);
        if (!eventDoc.exists) throw new Error("Selected planting event was not found.");
        const event = eventDoc.data();
        if (!isOriginalRequester) {
          const participationDoc = await transaction.get(
            db.collection("eventParticipants").doc(eventParticipationId)
          );
          const participation = participationDoc.exists ? participationDoc.data() : null;
          if (!participation || participation.userId !== data.participantId ||
              participation.eventId !== submittedEventId ||
              participation.participantType !== "participant") {
            throw new Error("You are not registered for the selected planting event.");
          }
        }
        const currentAllocation = (event.seedlingItems || []).find((item) => item.inventoryId === inventoryId);
        if (!event.allocationReleasedAt || !currentAllocation) {
          throw new Error("Sapling tree item has not been released for this event.");
        }
        const current = Number(event.recordedSeedlingsByInventory?.[inventoryId] || 0);
        if (current + quantityPlanted > Number(currentAllocation.quantity)) {
          throw new Error("The quantity planted cannot exceed the remaining released sapling quantity.");
        }
        parentId = `event_${submittedEventId}`;
        const hashDocs = await Promise.all(uploadedPhotos.map((photo) =>
          transaction.get(evidenceHashCollection.doc(photo.imageHash))));
        if (hashDocs.some((doc) => doc.exists)) {
          throw new Error("Duplicate planting image detected.");
        }
        const parent = await parentForEventInTransaction(
          transaction, submittedEventId, event, now, quantityPlanted, "Pending Review"
        );
        if (!parent.created && !["Draft", "Pending", "Pending Review"].includes(parent.data.verificationStatus)) {
          throw new Error("This planting report has already been finalized.");
        }
        const recorded = { ...(event.recordedSeedlingsByInventory || {}) };
        recorded[inventoryId] = current + quantityPlanted;
        transaction.update(eventRef, {
          recordedSeedlingsByInventory: recorded,
          recordedSeedlingQuantity: Number(event.recordedSeedlingQuantity || 0) + quantityPlanted,
          remainingSeedlingQuantity: Number(event.seedlingTotalQuantity || 0) -
            Number(event.recordedSeedlingQuantity || 0) - quantityPlanted,
          updatedAt: now,
        });
        if (!parent.created) {
          transaction.update(parent.ref, {
            quantityPlanted: Number(parent.data.quantityPlanted || 0) + quantityPlanted,
            verificationStatus: "Pending Review",
            submittedAt: now,
            updatedAt: now,
          });
        }
        transaction.create(contributionRef, {
          reportId: parentId,
          requestId: event.sourceRequestId,
          eventId: submittedEventId,
          participantId: isOriginalRequester ? data.participantId : eventParticipationId,
          contributorId: data.participantId,
          contributorName: data.participantName || distribution.participantName || "",
          participantType: isOriginalRequester ? "requester" : "participant",
          participantUserType: data.participantType || "",
          participantBarangay: data.participantBarangay || "",
          organizationAffiliation: data.organizationAffiliation || "",
          participantContactNumber: data.participantContactNumber || "",
          inventoryId,
          species: currentAllocation.species,
          requestedQuantity,
          releasedQuantity: quantityReleased,
          quantity: quantityPlanted,
          recordedAt: now,
          photos: uploadedPhotos,
          imageHashes: uploadedPhotos.map((photo) => photo.imageHash),
          automatedVerificationStatus: automatedStatus,
          suspiciousFlags,
          plantingDate: data.plantingDate,
          latitude: photoLatitude,
          longitude: photoLongitude,
          locationSource,
          gpsAccuracyMeters: primaryPhoto.locationAccuracyMeters,
          locationCapturedAt: primaryPhoto.locationCapturedAt,
          photoCapturedAt: primaryPhoto.photoCapturedAt,
          gpsMetadataPresent: allGpsMetadataPresent,
          gpsValid: allGpsValid,
          siteGpsDistanceMeters,
          siteGpsValid,
          siteLocationStatus,
        });
        for (const photo of uploadedPhotos) {
          transaction.create(evidenceHashCollection.doc(photo.imageHash), {
            reportId: parentId,
            contributionId: contributionRef.id,
            eventId: submittedEventId,
            createdAt: now,
          });
        }
      });
      persisted = true;
      const doc = await reportCollection.doc(parentId).get();
      return reportDetails(doc.id, doc.data());
    }

    const docRef = reportCollection.doc();
    let reportNumber = "";
    await db.runTransaction(async (transaction) => {
      reportNumber = await nextRecordNumber(transaction, {
        prefix: "RPT",
        counterKey: "plantingReports",
        date: typeof now?.toDate === "function" ? now.toDate() : new Date(),
        timestamp: now,
      });
      transaction.create(docRef, { ...reportData, reportNumber });
    });
    persisted = true;
    return { id: docRef.id, ...reportData, reportNumber };
  } catch (error) {
    if (persisted) throw error;
    // --------------------------------
    // REMOVE ALL PHOTOS ALREADY
    // SAVED IF ANY LATER STEP FAILS
    // --------------------------------
    for (
      const uploadedPhoto of
      uploadedPhotos
    ) {
      if (
        !uploadedPhoto
          ?.photoPath
      ) {
        continue;
      }

      try {
        await deletePlantingPhoto(
          uploadedPhoto.photoPath
        );
      } catch (
        cleanupError
      ) {
        console.error(
          "Failed to clean up uploaded planting photo:",
          cleanupError
        );
      }
    }

    throw error;
  }
};


// --------------------------------
// GET ALL PLANTING REPORTS
// --------------------------------
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
    snapshot.docs.map(withWorkflowStatus);

  if (verificationStatus) {
    reports =
      reports.filter(
        (report) =>
          report
            .verificationStatus
            ?.toLowerCase() ===
          verificationStatus
            .toLowerCase()
      );
  }

  if (participantId) {
    reports =
      reports.filter(
        (report) =>
          report.participantId ===
          participantId
      );
  }

  if (distributionId) {
    reports =
      reports.filter(
        (report) =>
          report.distributionId ===
          distributionId
      );
  }

  reports.sort((a, b) => {
    const aSeconds =
      a.createdAt?._seconds ??
      a.createdAt?.seconds ??
      0;

    const bSeconds =
      b.createdAt?._seconds ??
      b.createdAt?.seconds ??
      0;

    return (
      bSeconds -
      aSeconds
    );
  });

  return Promise.all(reports.map((report) =>
    report.reportType === "parent" ? reportDetails(report.id, report) : report
  ));
};


// --------------------------------
// GET PLANTING REPORT BY ID
// --------------------------------
const getPlantingReportById =
  async (id) => {
    const doc =
      await reportRefFor(id)
        .get();

    if (!doc.exists) {
      throw new Error(
        "Planting report not found."
      );
    }

    return reportDetails(doc.id, withWorkflowStatus(doc));
  };


// --------------------------------
// GET REPORTS OF
// CURRENT PARTICIPANT
// --------------------------------
const getPlantingReportsByParticipantId =
  async (participantId) => {
    const [ownedSnapshot, contributionSnapshot] = await Promise.all([
      reportCollection
        .where(
          "participantId",
          "==",
          participantId
        )
        .get(),
      contributionCollection.where("contributorId", "==", participantId).get(),
    ]);

    const reportsById = new Map(
      ownedSnapshot.docs.map((doc) => [doc.id, withWorkflowStatus(doc)])
    );
    const contributedReportIds = [...new Set(
      contributionSnapshot.docs.map((doc) => doc.data().reportId).filter(Boolean)
    )].filter((id) => !reportsById.has(id));
    const contributedDocs = await Promise.all(
      contributedReportIds.map((id) => reportCollection.doc(id).get())
    );
    contributedDocs
      .filter((doc) => doc.exists)
      .forEach((doc) => reportsById.set(doc.id, withWorkflowStatus(doc)));

    const reports = [...reportsById.values()];

    reports.sort((a, b) => {
      const aSeconds =
        a.createdAt?._seconds ??
        a.createdAt?.seconds ??
        0;

      const bSeconds =
        b.createdAt?._seconds ??
        b.createdAt?.seconds ??
        0;

      return (
        bSeconds -
        aSeconds
      );
    });

    return Promise.all(reports.map((report) =>
      report.reportType === "parent" ? reportDetails(report.id, report) : report
    ));
  };


// --------------------------------
// STAFF APPROVE
// PLANTING REPORT
// --------------------------------
const approvePlantingReport =
  async (
    id,
    approvedBy,
    remarks,
    reviewedByName
  ) => {
    const reportRef =
      reportRefFor(id);

    await db.runTransaction(
      async (transaction) => {
        const reportDoc =
          await transaction.get(
            reportRef
          );

        if (
          !reportDoc.exists
        ) {
          throw new Error(
            "Planting report not found."
          );
        }

        const currentReport =
          reportDoc.data();

        if (workflowStatus(currentReport.verificationStatus) !== "Pending Review") {
          throw new Error(
            "Only pending review planting reports can be approved."
          );
        }

        const now =
          Timestamp.now();

        transaction.update(
          reportRef,
          {
            verificationStatus:
              "Approved",

            reviewedBy: approvedBy,
            reviewedByName: reviewedByName || "",
            reviewedAt: now,

            approvedBy,

            approvalRemarks:
              remarks?.trim() ||
              "",

            approvedAt:
              now,

            rejectedBy:
              "",

            rejectionRemarks:
              "",

            rejectedAt:
              null,

            updatedAt:
              now,
          }
        );

        createVerificationLogInTransaction(
          transaction,
          {
            plantingReportId:
              id,

            action:
              "Staff Approval",

            previousStatus:
              currentReport.verificationStatus,

            newStatus:
              "Approved",

            performedBy:
              approvedBy,

            performedByRole:
              "staff",

            remarks:
              remarks?.trim() ||
              "",

            createdAt:
              now,
          }
        );
        createNotificationInTransaction(transaction, {
          recipientUserId: currentReport.participantId,
          type: "planting_report_approved",
          title: "Planting report approved",
          message: "Your planting report has been approved.",
          relatedRecordType: "plantingReport",
          relatedRecordId: id,
          createdAt: now,
        });
      }
    );

    const updatedDoc =
      await reportRef.get();

    return withWorkflowStatus(updatedDoc);
  };


// --------------------------------
// STAFF REJECT
// PLANTING REPORT
// --------------------------------
const rejectPlantingReport =
  async (
    id,
    rejectedBy,
    remarks,
    reviewedByName
  ) => {
    if (typeof remarks !== "string" || !remarks.trim()) {
      throw new Error("Rejection reason is required.");
    }
    const reportRef =
      reportRefFor(id);

    await db.runTransaction(
      async (transaction) => {
        const reportDoc =
          await transaction.get(
            reportRef
          );

        if (
          !reportDoc.exists
        ) {
          throw new Error(
            "Planting report not found."
          );
        }

        const currentReport =
          reportDoc.data();

        if (workflowStatus(currentReport.verificationStatus) !== "Pending Review") {
          throw new Error(
            "Only pending review planting reports can be rejected."
          );
        }

        const now =
          Timestamp.now();

        transaction.update(
          reportRef,
          {
            verificationStatus:
              "Rejected",

            reviewedBy: rejectedBy,
            reviewedByName: reviewedByName || "",
            reviewedAt: now,

            rejectedBy,

            rejectionRemarks:
              remarks.trim(),

            rejectedAt:
              now,

            approvedBy:
              "",

            approvalRemarks:
              "",

            approvedAt:
              null,

            updatedAt:
              now,
          }
        );

        createVerificationLogInTransaction(
          transaction,
          {
            plantingReportId:
              id,

            action:
              "Staff Rejection",

            previousStatus:
              currentReport.verificationStatus,

            newStatus:
              "Rejected",

            performedBy:
              rejectedBy,

            performedByRole:
              "staff",

            remarks:
              remarks.trim(),

            createdAt:
              now,
          }
        );
        createNotificationInTransaction(transaction, {
          recipientUserId: currentReport.participantId,
          type: "planting_report_rejected",
          title: "Planting report rejected",
          message: `Your planting report was rejected. Reason: ${remarks.trim()}`,
          relatedRecordType: "plantingReport",
          relatedRecordId: id,
          createdAt: now,
        });
      }
    );

    const updatedDoc =
      await reportRef.get();

    return withWorkflowStatus(updatedDoc);
  };


// --------------------------------
// GET VERIFICATION HISTORY
// --------------------------------
const getPlantingReportVerificationLogs =
  async (id) => {
    const reportDoc =
      await reportRefFor(id)
        .get();

    if (
      !reportDoc.exists
    ) {
      throw new Error(
        "Planting report not found."
      );
    }

    return await getVerificationLogsByPlantingReportId(
      id
    );
  };


module.exports = {
  createPlantingReport,
  getAllPlantingReports,
  getPlantingReportById,
  getPlantingReportsByParticipantId,
  approvePlantingReport,
  rejectPlantingReport,
  getPlantingReportVerificationLogs,
};
