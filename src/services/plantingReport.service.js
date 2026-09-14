const { db } = require("../config/firebase");

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

const SITE_GPS_TOLERANCE_METERS =
  20;

const MAX_EVIDENCE_PHOTOS =
  10;

const reportCollection =
  db.collection(
    REPORT_COLLECTION
  );


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
    return null;
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

  const quantityReleased =
    Number(
      distribution.quantityReleased
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

  if (
    existingDistributionReport
  ) {
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

const submittedEventId =
  String(
    data.eventId || ""
  ).trim();

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


      // Keep original automated
      // result even after Staff/Admin
      // changes verificationStatus.
      automatedVerificationStatus:
        automatedStatus,

      verificationStatus:
        automatedStatus,


      reviewedBy: "",
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
    const docRef =
      await reportCollection.add(
        reportData
      );

    return {
      id:
        docRef.id,

      ...reportData,
    };
  } catch (error) {
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
    snapshot.docs.map(
      (doc) => ({
        id:
          doc.id,

        ...doc.data(),
      })
    );

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

  return reports;
};


// --------------------------------
// GET PLANTING REPORT BY ID
// --------------------------------
const getPlantingReportById =
  async (id) => {
    const doc =
      await reportCollection
        .doc(id)
        .get();

    if (!doc.exists) {
      throw new Error(
        "Planting report not found."
      );
    }

    return {
      id:
        doc.id,

      ...doc.data(),
    };
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
      snapshot.docs.map(
        (doc) => ({
          id:
            doc.id,

          ...doc.data(),
        })
      );

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

    return reports;
  };


// --------------------------------
// STAFF REVIEW PLANTING REPORT
// --------------------------------
const reviewPlantingReport =
  async (
    id,
    reviewedBy,
    remarks
  ) => {
    const reportRef =
      reportCollection.doc(id);

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

        const allowedStatuses = [
          "Passed Automated Check",
          "Flagged",
        ];

        if (
          !allowedStatuses.includes(
            currentReport
              .verificationStatus
          )
        ) {
          throw new Error(
            "Only reports awaiting staff review can be reviewed."
          );
        }

        const previousStatus =
          currentReport
            .verificationStatus;

        const now =
          Timestamp.now();

        transaction.update(
          reportRef,
          {
            automatedVerificationStatus:
              currentReport
                .automatedVerificationStatus ||
              previousStatus,

            verificationStatus:
              "Reviewed",

            reviewedBy,

            reviewRemarks:
              remarks?.trim() ||
              "",

            reviewedAt:
              now,

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
              "Staff Review",

            previousStatus,

            newStatus:
              "Reviewed",

            performedBy:
              reviewedBy,

            performedByRole:
              "staff",

            remarks:
              remarks?.trim() ||
              "",

            createdAt:
              now,
          }
        );
      }
    );

    const updatedDoc =
      await reportRef.get();

    return {
      id:
        updatedDoc.id,

      ...updatedDoc.data(),
    };
  };


// --------------------------------
// ADMIN APPROVE
// PLANTING REPORT
// --------------------------------
const approvePlantingReport =
  async (
    id,
    approvedBy,
    remarks
  ) => {
    const reportRef =
      reportCollection.doc(id);

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

        if (
          currentReport
            .verificationStatus !==
          "Reviewed"
        ) {
          throw new Error(
            "Only reviewed planting reports can be approved."
          );
        }

        const now =
          Timestamp.now();

        transaction.update(
          reportRef,
          {
            verificationStatus:
              "Approved",

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
              "Admin Approval",

            previousStatus:
              "Reviewed",

            newStatus:
              "Approved",

            performedBy:
              approvedBy,

            performedByRole:
              "admin",

            remarks:
              remarks?.trim() ||
              "",

            createdAt:
              now,
          }
        );
      }
    );

    const updatedDoc =
      await reportRef.get();

    return {
      id:
        updatedDoc.id,

      ...updatedDoc.data(),
    };
  };


// --------------------------------
// ADMIN REJECT
// PLANTING REPORT
// --------------------------------
const rejectPlantingReport =
  async (
    id,
    rejectedBy,
    remarks
  ) => {
    const reportRef =
      reportCollection.doc(id);

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

        if (
          currentReport
            .verificationStatus !==
          "Reviewed"
        ) {
          throw new Error(
            "Only reviewed planting reports can be rejected."
          );
        }

        const now =
          Timestamp.now();

        transaction.update(
          reportRef,
          {
            verificationStatus:
              "Rejected",

            rejectedBy,

            rejectionRemarks:
              remarks?.trim() ||
              "",

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
              "Admin Rejection",

            previousStatus:
              "Reviewed",

            newStatus:
              "Rejected",

            performedBy:
              rejectedBy,

            performedByRole:
              "admin",

            remarks:
              remarks?.trim() ||
              "",

            createdAt:
              now,
          }
        );
      }
    );

    const updatedDoc =
      await reportRef.get();

    return {
      id:
        updatedDoc.id,

      ...updatedDoc.data(),
    };
  };


// --------------------------------
// GET VERIFICATION HISTORY
// --------------------------------
const getPlantingReportVerificationLogs =
  async (id) => {
    const reportDoc =
      await reportCollection
        .doc(id)
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
  reviewPlantingReport,
  approvePlantingReport,
  rejectPlantingReport,
  getPlantingReportVerificationLogs,
};