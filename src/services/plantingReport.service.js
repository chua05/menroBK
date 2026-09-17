const { db } = require("../config/firebase");
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
    verificationStatus: workflowStatus(data.verificationStatus),
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
  // 3. VERIFY PARTICIPANT
  // --------------------------------
  if (
    distribution.participantId !==
    data.participantId
  ) {
    throw new Error(
      "You cannot submit a report for another participant's distribution."
    );
  }


  // --------------------------------
  // 4. VERIFY DISTRIBUTION STATUS
  // --------------------------------
  if (
    distribution.status !==
    "Released"
  ) {
    throw new Error(
      "Only released distributions can have planting reports."
    );
  }


  // --------------------------------
  // 5. VALIDATE QUANTITY
  // --------------------------------
  const quantityPlanted =
    Number(
      data.quantityPlanted
    );

  const quantityReleased = Number(
    distribution.totalQuantityReleased ?? distribution.quantityReleased
  );

  if (
    !Number.isInteger(
      quantityPlanted
    ) ||
    quantityPlanted <= 0
  ) {
    throw new Error(
      "Quantity planted must be a positive integer."
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
      "Quantity planted cannot exceed the released quantity."
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
}


  // --------------------------------
  // 8. VALIDATE SUBMITTED GPS
  // --------------------------------
  const submittedLatitude =
    Number(
      data.latitude
    );

  const submittedLongitude =
    Number(
      data.longitude
    );

  if (
    Number.isNaN(
      submittedLatitude
    ) ||
    submittedLatitude < -90 ||
    submittedLatitude > 90
  ) {
    throw new Error(
      "Latitude must be between -90 and 90."
    );
  }

  if (
    Number.isNaN(
      submittedLongitude
    ) ||
    submittedLongitude < -180 ||
    submittedLongitude > 180
  ) {
    throw new Error(
      "Longitude must be between -180 and 180."
    );
  }


  // --------------------------------
  // 9. COMPARE CAPTURED GPS
  // WITH REGISTERED SITE
  // --------------------------------
  const siteGpsDistanceMeters =
    calculateDistanceMeters(
      submittedLatitude,
      submittedLongitude,
      siteLatitude,
      siteLongitude
    );

  const siteGpsValid =
    siteGpsDistanceMeters <=
    SITE_GPS_TOLERANCE_METERS;


  // --------------------------------
  // 10. PARSE LOCATION
  // CAPTURE TIME
  // --------------------------------
  const locationCapturedAtTimestamp =
    toTimestampOrNull(
      data.locationCapturedAt
    );


  // --------------------------------
  // 11. PARSE GPS ACCURACY
  // --------------------------------
  const parsedAccuracy =
    data.accuracy !==
      undefined &&
    data.accuracy !==
      null &&
    data.accuracy !== ""
      ? Number(
          data.accuracy
        )
      : null;

  const gpsAccuracyMeters =
    Number.isFinite(
      parsedAccuracy
    ) &&
    parsedAccuracy >= 0
      ? parsedAccuracy
      : null;


  // --------------------------------
  // 12. VALIDATE ALL PHOTOS
  // BEFORE SAVING ANYTHING
  // --------------------------------
  const preparedPhotos = [];

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


    // Existing automated
    // photo verification
    const photoVerification =
      validatePlantingReport({
        submittedLatitude,
        submittedLongitude,
        plantingDate:
          data.plantingDate,
        metadata,
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


    // Registered site check
    if (!siteGpsValid) {
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


    const photoAutomatedStatus =
      photoFlags.length > 0
        ? "Flagged"
        : photoVerification
            .automatedStatus;


    preparedPhotos.push({
      file,

      imageHash,

      imageDetails,

      metadata,

      gpsMetadataPresent:
        photoVerification
          .gpsMetadataPresent,

      timestampMetadataPresent:
        photoVerification
          .timestampMetadataPresent,

      gpsDistanceMeters:
        photoVerification
          .gpsDistanceMeters,

      gpsValid:
        photoVerification
          .gpsValid,

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

  if (!siteGpsValid) {
    reportFlags.add(
      "OUTSIDE_REGISTERED_SITE"
    );
  }

  const suspiciousFlags =
    Array.from(
      reportFlags
    );

  const automatedStatus =
    suspiciousFlags.length > 0 ||
    preparedPhotos.some(
      (photo) =>
        photo.automatedStatus ===
        "Flagged"
    )
      ? "Flagged"
      : "Passed Automated Check";


  // --------------------------------
  // 14. SAVE ALL PHOTOS
  // --------------------------------
  const uploadedPhotos = [];
  let persisted = false;

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
        toTimestampOrNull(
          preparedPhoto
            .metadata
            .capturedAt
        );


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
        },

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


    const now =
      Timestamp.now();


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

      inventoryId:
        distribution.inventoryId ||
        "",

      participantId:
        data.participantId,

      participantName:
        distribution.participantName ||
        "",

      participantType:
        data.participantType ||
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
        distribution.species ||
        "",

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
      // GPS CAPTURED BY PARTICIPANT
      // --------------------------------
      latitude:
        submittedLatitude,

      longitude:
        submittedLongitude,

      gpsAccuracyMeters,

      locationCapturedAt:
        locationCapturedAtTimestamp,


      // --------------------------------
      // REGISTERED SITE GPS
      // --------------------------------
      siteLatitude,

      siteLongitude,

      siteGpsDistanceMeters,

      siteGpsValid,

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
      const inventoryId = data.inventoryId ||
        (allocatedItems.length === 1 ? allocatedItems[0].inventoryId : "");
      if (!inventoryId) throw new Error("Select a released seedling item for this submission.");
      const allocation = allocatedItems.find((item) => item.inventoryId === inventoryId);
      if (!allocation || !linkedEvent.allocationReleasedAt) {
        throw new Error("Seedling item has not been released for this event.");
      }
      const contributionRef = contributionCollection.doc();
      let parentId;
      await db.runTransaction(async (transaction) => {
        const eventRef = db.collection(EVENT_COLLECTION).doc(submittedEventId);
        const eventDoc = await transaction.get(eventRef);
        if (!eventDoc.exists) throw new Error("Selected planting event was not found.");
        const event = eventDoc.data();
        const currentAllocation = (event.seedlingItems || []).find((item) => item.inventoryId === inventoryId);
        if (!event.allocationReleasedAt || !currentAllocation) {
          throw new Error("Seedling item has not been released for this event.");
        }
        const current = Number(event.recordedSeedlingsByInventory?.[inventoryId] || 0);
        if (current + quantityPlanted > Number(currentAllocation.quantity)) {
          throw new Error("Quantity planted exceeds the remaining event allocation.");
        }
        parentId = `event_${submittedEventId}`;
        const existingSubmissions = await transaction.get(contributionCollection
          .where("reportId", "==", parentId));
        const hashDocs = await Promise.all(uploadedPhotos.map((photo) =>
          transaction.get(evidenceHashCollection.doc(photo.imageHash))));
        if (hashDocs.some((doc) => doc.exists)) {
          throw new Error("Duplicate planting image detected.");
        }
        if (existingSubmissions.docs.some((doc) =>
          doc.data().contributorId === data.participantId ||
          doc.data().participantType === "requester")) {
          throw new Error("Requester has already submitted planting evidence for this event.");
        }
        const parent = await parentForEventInTransaction(
          transaction, submittedEventId, event, now, quantityPlanted
        );
        if (parent.data.verificationStatus !== "Draft") {
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
            updatedAt: now,
          });
        }
        transaction.create(contributionRef, {
          reportId: parentId,
          requestId: event.sourceRequestId,
          eventId: submittedEventId,
          participantId: data.participantId,
          contributorId: data.participantId,
          contributorName: distribution.participantName || "",
          participantType: "requester",
          inventoryId,
          species: currentAllocation.species,
          quantity: quantityPlanted,
          recordedAt: now,
          photos: uploadedPhotos,
          imageHashes: uploadedPhotos.map((photo) => photo.imageHash),
          automatedVerificationStatus: automatedStatus,
          suspiciousFlags,
          plantingDate: data.plantingDate,
          latitude: submittedLatitude,
          longitude: submittedLongitude,
          siteGpsValid,
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

    const docRef = await reportCollection.add(reportData);
    persisted = true;
    return { id: docRef.id, ...reportData };
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
    const snapshot =
      await reportCollection
        .where(
          "participantId",
          "==",
          participantId
        )
        .get();

    const reports =
      snapshot.docs.map(withWorkflowStatus);

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
