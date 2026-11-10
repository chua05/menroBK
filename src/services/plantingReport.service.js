const { db } = require("../config/firebase");
const { nextRecordNumber } = require("../utils/recordNumber.util");
const {
  createNotificationInTransaction,
  getRoleRecipientsInTransaction,
} = require("./notification.service");
const { activationState, buildEarlyMonitoringPolicy, shiftCalendarDate } = require("../utils/earlyMonitoring.util");
const { parentForEventInTransaction, reportDetails, normalizeSubmission } = require("./parentPlantingReport.service");
const { ensureCohortForAuthoritativeReportInTransaction } = require("./verifiedPlantingCohort.service");
const { availableForReporting, progressFor, wholeQuantity } = require("../utils/plantingBalance.util");
const {
  FINAL_REPORT_VERSION, finalReportIdFor, isFinalReportRow, parseFinalItems, finalRowsFor,
  assertNoActiveFinalReport, nextFinalRevision, sortGroupRows,
} = require("../utils/finalPlantingReport.util");

// One final Planting Report per event is required for new event-linked
// submissions. Set PLANTING_FINAL_REPORT_ENFORCED=false only to exercise the
// legacy per-type path (historical-compatibility tests, emergency rollback).
const finalReportEnforced = () => String(process.env.PLANTING_FINAL_REPORT_ENFORCED ?? "true").trim().toLowerCase() !== "false";

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
const { isPointWithinMunicipality } = require("../config/municipality");
const {
  WORKFLOW_STATUS,
  deriveWorkflowStatus,
  deriveStandaloneWorkflowStatus,
  requiredReason,
  optionalRemarks,
  fail: workflowFail,
} = require("../utils/plantingReviewWorkflow.util");


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
  50;

const MAX_EVIDENCE_PHOTOS =
  10;

const NON_REPORTABLE_EVENT_STATUSES = new Set([
  "cancelled", "canceled", "rejected", "deleted", "archived",
]);

const eventDateValue = (event) => String(
  event?.date || event?.eventDate || event?.startDate || ""
).slice(0, 10);

const eventStartDate = (event) => {
  const date = eventDateValue(event);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = /^\d{2}:\d{2}/.test(String(event?.startTime || ""))
    ? String(event.startTime).slice(0, 5)
    : "00:00";
  const value = new Date(`${date}T${time}:00+08:00`);
  return Number.isNaN(value.getTime()) ? null : value;
};

const assertReportableEvent = (event, now = new Date()) => {
  if (event?.archived === true) {
    throw new Error("The selected planting event is archived.");
  }
  const statuses = [event?.status, event?.recordStatus]
    .map((value) => String(value || "").trim().toLowerCase());
  if (statuses.some((status) => NON_REPORTABLE_EVENT_STATUSES.has(status))) {
    throw new Error("The selected planting event is cancelled, rejected, or unavailable.");
  }
  if (!["authorized", "scheduled", "approved", "completed"].includes(statuses[1])) {
    throw new Error("The selected planting event is not available for planting reports.");
  }
  const startsAt = eventStartDate(event);
  // Legacy event records may predate the official date field. They remain
  // reportable, but new/current records are always checked against their date.
  if (!startsAt) return null;
  if (startsAt.getTime() > now.getTime()) {
    throw new Error("Planting reports cannot be submitted before the planting event begins.");
  }
  return eventDateValue(event);
};

const PHOTO_EXIF_LOCATION_SOURCE =
  "Photo Metadata (EXIF)";

const normalizeBarangay = (value) => String(value || "")
  .trim()
  .replace(/Ã±/gi, "n")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase();

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
  const rawStatus = String(data.verificationStatus || "").trim();
  const legacyAutomatedStatus = ["Flagged", "Passed Automated Check"]
    .includes(rawStatus)
    ? rawStatus
    : undefined;
  const needsReview = ["Flagged", "Reviewed", "Pending Review"]
    .includes(rawStatus) || data.automatedVerificationStatus === "Flagged";
  const verificationStatus = ["Verified", "Needs Review", "Invalid"].includes(rawStatus)
    ? rawStatus
    : needsReview ? "Needs Review" : "Verified";
  const rawReviewStatus = String(data.staffReviewStatus || rawStatus).trim();
  const staffReviewStatus = ["Not Required", "Pending Review", "Accepted", "Rejected"]
    .includes(data.staffReviewStatus)
    ? data.staffReviewStatus
    : rawReviewStatus === "Rejected" ? "Rejected"
      : ["Approved", "Accepted"].includes(rawReviewStatus) ? "Accepted"
        : verificationStatus === "Verified" ? "Not Required" : "Pending Review";
  const workflowStage = data.reportType === "parent" ? undefined
    : deriveStandaloneWorkflowStatus(data, workflowStatus(rawStatus));
  return {
    id: doc.id,
    ...data,
    verificationStatus,
    staffReviewStatus,
    ...(workflowStage ? { workflowStatus: workflowStage,
      correctionAllowed: workflowStage === WORKFLOW_STATUS.RETURNED && !data.correctedByReportId } : {}),
    ...(data.automatedVerificationStatus === undefined && legacyAutomatedStatus
      ? { automatedVerificationStatus: legacyAutomatedStatus }
      : {}),
  };
};

const participantSafeReport = (report, participantId) => {
  if (report.reportType !== "parent") return report;
  const ownSubmissions = (report.submissions || []).filter(
    (submission) => submission.contributorId === participantId
  );
  const ownLatest = ownSubmissions[ownSubmissions.length - 1] || null;
  return {
    ...report,
    submissions: (report.submissions || []).map((submission) => ({
      ...submission,
      participantContactNumber: submission.contributorId === participantId
        ? submission.participantContactNumber || ""
        : "",
      submittedByContactNumber: submission.contributorId === participantId
        ? submission.submittedByContactNumber || ""
        : "",
    })),
    submittedByName: ownLatest?.submittedByName || ownLatest?.contributorName || "",
    submittedByType: ownLatest?.submittedBySector || ownLatest?.participantUserType || "",
    participantContactNumber: report.participantId === participantId
      ? report.participantContactNumber || ""
      : "",
    organizationAffiliation: ownLatest?.organizationAffiliation || "",
    participantBarangay: ownLatest?.participantBarangay || "",
  };
};

const participantCanAccessReport = async (report, participantId) => {
  if (report.participantId === participantId || (report.submissions || []).some(
    (submission) => submission.contributorId === participantId || submission.participantId === participantId
  )) return true;
  if (!report.eventId) return false;
  const snapshot = await db.collection("eventParticipants").where("eventId", "==", report.eventId).get();
  return snapshot.docs.some((doc) => {
    const participant = doc.data();
    return participant.userId === participantId || participant.participantId === participantId || doc.id === participantId;
  });
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
async function createPlantingReport(data, files) {
  const { idempotencyKey, items, ...payload } = data;
  if (items !== undefined) {
    // Final report: per-type leftovers (+ reasons); planted is computed per type.
    payload.finalItems = parseFinalItems(items);
    payload.inventoryId = payload.finalItems[0].inventoryId;
    payload.quantityPlanted = 0;
    payload.leftoverQuantity = 0;
    payload.confirmationMode = "final";
  }
  if (payload.leftoverQuantity != null && payload.leftoverQuantity !== "" && !wholeQuantity(payload.leftoverQuantity)) {
    throw Object.assign(new Error("Leftovers must be a nonnegative whole number."), { status: 400, fieldErrors: { leftoverQuantity: "Enter a nonnegative whole number." } });
  }
  const { runWorkflow } = require("./evidenceWorkflow.service");
  const fingerprintPayload = Object.fromEntries(["distributionId", "inventoryId", "siteId", "barangay",
    "quantityPlanted", "plantingDate", "plantingLocation", "eventId", "eventName", "remarks",
    "submittedByName", "submittedBySector", "submittedByContactNumber"].map(key => [key, payload[key]]));
  if (Number(payload.leftoverQuantity || 0) !== 0) fingerprintPayload.leftoverQuantity = Number(payload.leftoverQuantity);
  if (payload.confirmationMode === "final") fingerprintPayload.confirmationMode = "final";
  if (payload.finalItems) fingerprintPayload.finalItems = payload.finalItems;
  if (payload.correctionOf !== undefined && payload.correctionOf !== "") {
    if (typeof payload.correctionOf !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.correctionOf)) {
      throw Object.assign(new Error("Invalid correction reference."), { status: 400 });
    }
    fingerprintPayload.correctionOf = payload.correctionOf;
  }
  if (payload.confirmationMode && !["final", "partial"].includes(payload.confirmationMode)) throw Object.assign(new Error("Select a final or partial planting confirmation."), { status: 400 });
  return runWorkflow({ actor: { uid: data.participantId }, workflow: "planting-report",
    key: idempotencyKey, payload: fingerprintPayload, files },
  operation => createPlantingReportImpl({ ...payload, workflowOperation: operation }, files),
  async link => ({ ...await getPlantingReportById(link.recordId), ...(link.contributionId ? { participantSubmissionId: link.contributionId } : {}) }));
}
const createPlantingReportImpl = async (
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
    throw new Error("Select a released seedling tree item for this submission.");
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
  const leftoverQuantity = data.leftoverQuantity == null || data.leftoverQuantity === "" ? 0 : data.leftoverQuantity;
  if (!wholeQuantity(leftoverQuantity)) throw Object.assign(new Error("Leftovers must be a nonnegative whole number."), { status: 400, fieldErrors: { leftoverQuantity: "Enter a nonnegative whole number." } });
  const leftovers = Number(leftoverQuantity);


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
    (data.confirmationMode === "final" ? quantityPlanted < 0 : quantityPlanted <= 0)
  ) {
    throw new Error(
      "Please enter a valid quantity of planted seedlings."
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

  // --------------------------------
  // 6. ONE REPORT PER DISTRIBUTION
  // --------------------------------
  const existingDistributionReport =
    await findReportByDistributionId(
      data.distributionId
    );

  if (existingDistributionReport && !distribution.eventId) {
    // A standalone report returned for correction may be replaced once by its
    // own corrected resubmission; every other duplicate stays blocked.
    const existingReports = (await reportCollection.where("distributionId", "==", data.distributionId).get()).docs
      .map((doc) => ({ id: doc.id, ...doc.data() }));
    const returned = existingReports.find((report) => report.id === data.correctionOf);
    const correctable = returned && returned.participantId === data.participantId && !returned.correctedByReportId &&
      deriveStandaloneWorkflowStatus(returned, workflowStatus(String(returned.verificationStatus || ""))) === WORKFLOW_STATUS.RETURNED &&
      existingReports.every((report) => report.id === returned.id || report.correctedByReportId);
    if (!correctable) {
      throw new Error(
        "A planting report already exists for this distribution."
      );
    }
  } else if (data.correctionOf && !distribution.eventId) {
    throw workflowFail(409, "Only your own planting report returned for correction can be resubmitted.");
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

  if (!normalizeBarangay(data.barangay) ||
      normalizeBarangay(site.barangay) !== normalizeBarangay(data.barangay)) {
    throw new Error(
      "The selected planting site does not belong to the selected barangay."
    );
  }

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

  const savedCoverageRadiusMeters = Number(
    site.coverageRadiusMeters
  );
  const hasSavedCoverageRadius =
    Number.isFinite(savedCoverageRadiusMeters) &&
    savedCoverageRadiusMeters > 0;
  const hasLegacySitePolygon =
    !hasSavedCoverageRadius &&
    Array.isArray(site.polygon) &&
    site.polygon.length >= 3;


  
// VALIDATE EVENT RELATIONSHIP
let linkedEvent = null;

const submittedEventId = String(data.eventId || distribution.eventId || "").trim();
const isOriginalRequester = distribution.participantId === data.participantId;
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

  const officialEventDate = assertReportableEvent(linkedEvent);
  if (officialEventDate && plantingDate !== officialEventDate) {
    throw new Error("Planting event date does not match the selected event.");
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

  const eventBarangay = normalizeBarangay(linkedEvent.barangay);
  const siteBarangay = normalizeBarangay(site.barangay);

  if (
    eventBarangay !==
    siteBarangay
  ) {
    throw new Error(
      "The selected planting event does not belong to the selected barangay."
    );
  }

}

if (data.finalItems && !linkedEvent?.sourceRequestId) throw Object.assign(new Error("A final planting report requires an authoritative linked release and event."), { status: 409 });
if (!linkedEvent?.sourceRequestId && leftovers > 0) throw Object.assign(new Error("Leftovers require an authoritative linked release and event."), { status: 409, fieldErrors: { leftoverQuantity: "MENRO must reconcile this legacy release before recording leftovers." } });
if (!linkedEvent?.sourceRequestId && quantityPlanted > quantityReleased) {
  throw new Error(`Quantity exceeds the remaining reportable quantity. Only ${quantityReleased} trees remain available for reporting.`);
}


  // --------------------------------
  // 12. VALIDATE ALL PHOTOS
  // BEFORE SAVING ANYTHING
  // --------------------------------
  const preparedPhotos = [];

  // Never trust client/device coordinates as planting-photo evidence.
  const locationSource = PHOTO_EXIF_LOCATION_SOURCE;

  const captureEvidence = await require("./evidenceCaptureSession.service").resolveSubmissionEvidence({
    actorId: data.participantId,
    workflow: "planting-report",
    binding: { siteId: data.siteId, eventId: submittedEventId, distributionId: data.distributionId },
    files: evidenceFiles,
    manifest: data.evidenceManifest,
  });

  const submissionHashes =
    new Set();
  const verificationTimestamp = Timestamp.now();

  for (let fileIndex = 0; fileIndex < evidenceFiles.length; fileIndex += 1) {
    const file = evidenceFiles[fileIndex];
    const browserCapture = captureEvidence[fileIndex];
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
    const metadata = browserCapture ? {
      latitude: browserCapture.latitude,
      longitude: browserCapture.longitude,
      capturedAt: typeof browserCapture.capturedAtClient?.toDate === "function"
        ? browserCapture.capturedAtClient.toDate().toISOString()
        : new Date(Number(browserCapture.capturedAtClient?._seconds ?? browserCapture.capturedAtClient?.seconds) * 1000).toISOString(),
      gpsStatus: "browser-session",
    } : await extractImageMetadata(file.buffer);

    if (!browserCapture && isClearlyScreenshot({ fileName: file.originalname, metadata, imageDetails })) {
      throw new Error(
        "Screenshot images are not accepted as planting evidence. Please upload the original geotagged photo."
      );
    }

    const hasPhotoGpsValues = metadata.latitude !== null && metadata.latitude !== undefined &&
      metadata.longitude !== null && metadata.longitude !== undefined;
    const photoLatitude = hasPhotoGpsValues ? Number(metadata.latitude) : NaN;
    const photoLongitude = hasPhotoGpsValues ? Number(metadata.longitude) : NaN;
    const hasValidPhotoGps =
      Number.isFinite(photoLatitude) && photoLatitude >= -90 && photoLatitude <= 90 &&
      Number.isFinite(photoLongitude) && photoLongitude >= -180 && photoLongitude <= 180;

    if (!hasValidPhotoGps) {
      throw new Error(
        metadata.gpsStatus === "unparseable"
          ? "GPS metadata was found but could not be read from this photo. Please upload the original geotagged photo."
          : hasPhotoGpsValues || metadata.gpsStatus === "invalid"
            ? "This photo contains invalid GPS coordinates. Please upload an original geotagged photo with valid location information."
            : "GPS location metadata was not found in this photo. Please upload the original geotagged photo and try again."
      );
    }

    const insideBulan = isPointWithinMunicipality(photoLatitude, photoLongitude);

    if (!insideBulan) {
      throw new Error(
        "Your photo is outside the Municipality of Bulan coverage area. Please use a photo taken within Bulan and try again."
      );
    }


    // Existing automated
    // photo verification
    const verificationMetadata = metadata;

    const photoVerification =
      validatePlantingReport({
        // The shared validator handles metadata presence and capture-time checks.
        // Site verification is performed below against the saved center/radius.
        submittedLatitude: photoLatitude,
        submittedLongitude: photoLongitude,
        plantingDate:
          data.plantingDate,
        metadata: verificationMetadata,
      });

    if (photoVerification.suspiciousFlags.includes("FUTURE_IMAGE_TIMESTAMP")) {
      throw new Error("Photo capture timestamp is in the future and cannot be verified.");
    }


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
    const photoSiteValid = hasSavedCoverageRadius
      ? photoSiteDistanceMeters <= savedCoverageRadiusMeters
      : hasLegacySitePolygon
        ? isPointInPolygon(photoLatitude, photoLongitude, site.polygon)
        : photoSiteDistanceMeters <= SITE_GPS_TOLERANCE_METERS;

    if (browserCapture && !photoSiteValid) {
      throw new Error("Browser camera evidence must be captured within the assigned planting site.");
    }

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

      locationSource: browserCapture ? "Browser Capture Session" : locationSource,

      evidenceSource: browserCapture ? "browser-camera" : "original-exif",

      captureSessionAuditId: browserCapture?.id || null,

      locationAccuracyMeters: browserCapture?.accuracyMeters ?? null,

      locationCapturedAt: toTimestampOrNull(metadata.capturedAt),

      photoCapturedAt: toTimestampOrNull(metadata.capturedAt),

      gpsMetadataPresent: browserCapture ? false : photoVerification.gpsMetadataPresent,

      timestampMetadataPresent: photoVerification.timestampMetadataPresent,

      // GPS validity and assigned-site matching are separate results.
      // Reaching this point means the original photo has valid EXIF GPS.
      gpsValid: true,

      // Keep the legacy distance field while also naming the site comparison explicitly.
      gpsDistanceMeters: photoSiteDistanceMeters,

      siteGpsDistanceMeters: photoSiteDistanceMeters,

      siteGpsValid: photoSiteValid,

      siteCoverageRadiusMeters: hasSavedCoverageRadius
        ? savedCoverageRadiusMeters
        : null,

      siteLocationStatus: photoSiteValid
        ? "Within Assigned Site"
        : "Outside Assigned Site",

      municipalityScope: "inside",

      siteMatch: photoSiteValid,

      locationVerificationStatus: photoSiteValid
        ? "site_match"
        : "site_mismatch",

      requiresStaffReview: !photoSiteValid,

      verifiedAt: verificationTimestamp,

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
  const submissionVerificationStatus = automatedStatus === "Passed Automated Check"
    ? "Verified" : "Needs Review";
  const submissionStaffReviewStatus = "Pending Review";


  // --------------------------------
  // 14. SAVE ALL PHOTOS
  // --------------------------------
  const uploadedPhotos = [];
  const operation = data.workflowOperation;
  let persisted = false;
  const now = verificationTimestamp;

  try {
    for (
      const preparedPhoto of
      preparedPhotos
    ) {
      const privateEvidence = operation ? await require("./evidenceWorkflow.service").workflow().upload(
        operation, uploadedPhotos.length, preparedPhoto.file, {
          recordId: operation.targetId,
          evidenceType: linkedEvent?.sourceRequestId ? "planting-contribution" : "planting-report",
          verification: {
            capturedAt: preparedPhoto.metadata.capturedAt || null,
            latitude: preparedPhoto.latitude,
            longitude: preparedPhoto.longitude,
            gpsValid: preparedPhoto.gpsValid,
            timestampValid: preparedPhoto.timestampValid,
            siteGpsValid: preparedPhoto.siteGpsValid,
            suspiciousFlags: preparedPhoto.suspiciousFlags,
            evidenceSource: preparedPhoto.evidenceSource,
            locationSource: preparedPhoto.locationSource,
            locationAccuracyMeters: preparedPhoto.locationAccuracyMeters,
            verificationPolicyVersion: 1,
          },
        }) : null;
      const uploadedImage = privateEvidence ? { photoURL: "", filePath: "" } :
        await savePlantingPhoto({
          file:
            preparedPhoto.file,

          participantId:
            data.participantId,
        });


      const capturedAtTimestamp =
        preparedPhoto.photoCapturedAt;


      uploadedPhotos.push({
        ...(privateEvidence ? { privateEvidence, hasEvidence: true } : {}),
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

        evidenceSource:
          preparedPhoto.evidenceSource,

        captureSessionAuditId:
          preparedPhoto.captureSessionAuditId,

        verificationPolicyVersion: 1,

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

        municipalityScope:
          preparedPhoto.municipalityScope,

        siteMatch:
          preparedPhoto.siteMatch,

        locationVerificationStatus:
          preparedPhoto.locationVerificationStatus,

        requiresStaffReview:
          preparedPhoto.requiresStaffReview,

        verifiedAt:
          preparedPhoto.verifiedAt,

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

      authenticatedSubmitterUid:
        data.participantId,

      submittedByName:
        data.submittedByName,

      submittedBySector:
        data.submittedBySector,

      submittedByContactNumber:
        data.submittedByContactNumber,

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
      confirmationMode: data.confirmationMode || "partial",

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

      locationSource: primaryPhoto.locationSource,

      evidenceSource: primaryPhoto.evidenceSource,

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

      municipalityScope: "inside",

      siteMatch: siteGpsValid,

      locationVerificationStatus: siteGpsValid
        ? "site_match"
        : "site_mismatch",

      requiresStaffReview: !siteGpsValid,

      verifiedAt: now,

      siteGpsToleranceMeters:
        hasSavedCoverageRadius
          ? savedCoverageRadiusMeters
          : SITE_GPS_TOLERANCE_METERS,

      siteCoverageRadiusMeters: hasSavedCoverageRadius
        ? savedCoverageRadiusMeters
        : null,


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
      technicalVerificationStatus:
        submissionVerificationStatus,
      staffReviewStatus: submissionStaffReviewStatus,
      staffApprovalRequired: true,
      requiresStaffReview: true,
      submissionWorkflowVersion: 2,


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
    if (activationState().enabled) reportData.earlyMonitoringOriginalSubmittedAt = now;


    // --------------------------------
    // 17. SAVE TO FIRESTORE
    // --------------------------------
    if (linkedEvent?.sourceRequestId) {
      const allocatedItems = linkedEvent.seedlingItems || [];
      const inventoryId = selectedDistributionItem?.inventoryId || data.inventoryId ||
        (allocatedItems.length === 1 ? allocatedItems[0].inventoryId : "");
      if (!inventoryId) throw new Error("Select a released seedling tree item for this submission.");
      const allocation = allocatedItems.find((item) => item.inventoryId === inventoryId);
      if (!allocation || !linkedEvent.allocationReleasedAt) {
        throw new Error("Seedling tree item has not been released for this event.");
      }
      const contributionRef = operation ? contributionCollection.doc(operation.targetId) : contributionCollection.doc();
      let parentId;
      await db.runTransaction(async (transaction) => {
        const complete = operation ? await require("./evidenceWorkflow.service").workflow().prepareLink(transaction, operation) : null;
        const consumeCaptures = await require("./evidenceCaptureSession.service").prepareConsumption(transaction, captureEvidence);
        const staffRecipients = await getRoleRecipientsInTransaction(transaction, ["staff"]);
        const eventRef = db.collection(EVENT_COLLECTION).doc(submittedEventId);
        const eventDoc = await transaction.get(eventRef);
        if (!eventDoc.exists) throw new Error("Selected planting event was not found.");
        const event = eventDoc.data();
        assertReportableEvent(event);
        if (String(event.plantingSiteId || "") !== String(data.siteId) ||
            normalizeBarangay(event.barangay) !== normalizeBarangay(site.barangay)) {
          throw new Error("The selected planting event does not match the selected site and barangay.");
        }
        if (data.finalItems) {
          // ONE FINAL PLANTING REPORT (v4): every released type with a remaining
          // balance in one submission; one geotagged evidence set for the group.
          if (!event.allocationReleasedAt) throw new Error("Seedling tree item has not been released for this event.");
          parentId = `event_${submittedEventId}`;
          const existingRows = (await transaction.get(contributionCollection.where("reportId", "==", parentId))).docs
            .map((doc) => ({ id: doc.id, ...doc.data() }));
          let correctedRows = [];
          if (data.correctionOf) {
            const target = existingRows.find((row) => row.id === data.correctionOf);
            correctedRows = !target ? [] : isFinalReportRow(target)
              ? existingRows.filter((row) => row.finalReportGroupId === target.finalReportGroupId) : [target];
            if (!correctedRows.length || correctedRows.some((row) => row.officialStaffReport === true ||
                (row.contributorId || row.participantId) !== data.participantId || row.correctedBySubmission ||
                deriveWorkflowStatus(row) !== WORKFLOW_STATUS.RETURNED)) {
              throw workflowFail(409, "Only your own planting report returned for correction can be resubmitted.");
            }
          }
          assertNoActiveFinalReport(existingRows);
          const balances = (event.seedlingItems || []).map((item) => ({
            inventoryId: item.inventoryId, species: item.species,
            remaining: Math.max(0, Number(item.quantity || 0) - Number(event.recordedSeedlingsByInventory?.[item.inventoryId] || 0) -
              Number(event.pendingSeedlingsByInventory?.[item.inventoryId] || 0) - Number(event.leftoverSeedlingsByInventory?.[item.inventoryId] || 0)),
          }));
          const rows = finalRowsFor(data.finalItems, balances);
          const hashDocs = await Promise.all(uploadedPhotos.map((photo) => transaction.get(evidenceHashCollection.doc(photo.imageHash))));
          if (hashDocs.some((doc) => doc.exists)) throw new Error("Duplicate planting image detected.");
          const planted = rows.reduce((sum, row) => sum + row.quantity, 0);
          const leftoverTotal = rows.reduce((sum, row) => sum + row.leftoverQuantity, 0);
          const totalReleased = Number(event.seedlingTotalQuantity || 0);
          const parent = await parentForEventInTransaction(transaction, submittedEventId, event, now, planted,
            "Fully Reported — Awaiting Review", { activeSubmittedQuantity: planted, declaredLeftoverQuantity: leftoverTotal,
              acceptedQuantity: 0, pendingReviewQuantity: planted,
              reportingProgress: progressFor({ released: totalReleased, active: planted, accepted: 0, pending: planted,
                leftovers: leftoverTotal, pendingLeftovers: leftoverTotal }) });
          if (!parent.created && !["Draft", "Pending", "Pending Review", "Awaiting Submission", "Partial",
            "Fully Reported — Awaiting Review"].includes(parent.data.reportingProgress || parent.data.verificationStatus)) {
            throw workflowFail(409, "This planting report has already been finalized.");
          }
          // All reads are done; writes follow.
          if (complete) complete({ collection: "plantingReports", recordId: parentId, contributionId: contributionRef.id });
          consumeCaptures(`${parentId}:${contributionRef.id}`);
          const recorded = { ...(event.recordedSeedlingsByInventory || {}) };
          const leftoverLedger = { ...(event.leftoverSeedlingsByInventory || {}) };
          for (const row of rows) {
            recorded[row.inventoryId] = Number(recorded[row.inventoryId] || 0) + row.quantity;
            leftoverLedger[row.inventoryId] = Number(leftoverLedger[row.inventoryId] || 0) + row.leftoverQuantity;
          }
          transaction.update(eventRef, {
            recordedSeedlingsByInventory: recorded, leftoverSeedlingsByInventory: leftoverLedger,
            recordedSeedlingQuantity: Number(event.recordedSeedlingQuantity || 0) + planted,
            leftoverSeedlingQuantity: Number(event.leftoverSeedlingQuantity || 0) + leftoverTotal,
            officialReportingVersion: Number(event.officialReportingVersion || 0) + 1,
            remainingSeedlingQuantity: Math.max(0, event.seedlingItems.reduce((sum, item) => sum + availableForReporting(event, item), 0) - planted - leftoverTotal),
            updatedAt: now,
          });
          if (!parent.created) {
            const nextActive = Number(parent.data.activeSubmittedQuantity ?? parent.data.quantityPlanted ?? 0) + planted;
            const nextPending = Number(parent.data.pendingReviewQuantity || 0) + planted;
            const nextLeftovers = Number(parent.data.declaredLeftoverQuantity || 0) + leftoverTotal;
            const nextPendingLeftovers = Number(parent.data.pendingReviewLeftoverQuantity || 0) + leftoverTotal;
            const nextProgress = progressFor({ released: totalReleased || Number(parent.data.quantityReleased || 0), active: nextActive,
              accepted: Number(parent.data.acceptedQuantity || 0), pending: nextPending, leftovers: nextLeftovers,
              acceptedLeftovers: Number(parent.data.acceptedLeftoverQuantity || 0), pendingLeftovers: nextPendingLeftovers });
            transaction.update(parent.ref, {
              quantityPlanted: nextActive, activeSubmittedQuantity: nextActive, pendingReviewQuantity: nextPending,
              declaredLeftoverQuantity: nextLeftovers, pendingReviewLeftoverQuantity: nextPendingLeftovers,
              remainingAvailableQuantity: Math.max(0, (totalReleased || Number(parent.data.quantityReleased || 0)) - nextActive - nextLeftovers),
              reportingProgress: nextProgress, verificationStatus: nextProgress, submittedAt: now, updatedAt: now,
              ...(!parent.data.earlyMonitoringOriginalSubmittedAt && activationState().enabled ? { earlyMonitoringOriginalSubmittedAt: now } : {}),
            });
          }
          const finalReportId = finalReportIdFor(submittedEventId);
          const finalReportRevision = nextFinalRevision(existingRows);
          const correctionFor = (inventory) => correctedRows.find((row) => row.inventoryId === inventory) || null;
          const shared = {
            workflowStatus: WORKFLOW_STATUS.PENDING_REVIEW, reportId: parentId, requestId: event.sourceRequestId, eventId: submittedEventId,
            participantId: data.participantId, contributorId: data.participantId,
            contributorName: data.participantName || distribution.participantName || "", authenticatedSubmitterUid: data.participantId,
            submittedByName: data.submittedByName, submittedBySector: data.submittedBySector, submittedByContactNumber: data.submittedByContactNumber,
            participantType: isOriginalRequester ? "requester" : "participant", participantUserType: data.participantType || "",
            participantBarangay: data.participantBarangay || "", organizationAffiliation: data.organizationAffiliation || "",
            participantContactNumber: data.participantContactNumber || "", recordedAt: now,
            automatedVerificationStatus: automatedStatus, verificationStatus: submissionVerificationStatus,
            staffReviewStatus: submissionStaffReviewStatus, staffApprovalRequired: true, submissionWorkflowVersion: FINAL_REPORT_VERSION,
            confirmationMode: "final", finalReportId, finalReportGroupId: contributionRef.id, finalReportRevision,
            ...(correctedRows.length ? { finalReportCorrectionOfGroup: correctedRows[0].finalReportGroupId || correctedRows[0].id } : {}),
            verificationDetails: suspiciousFlags, reviewedBy: "", reviewedByName: "", reviewedAt: null, rejectionReason: "", suspiciousFlags,
            plantingDate: data.plantingDate, latitude: photoLatitude, longitude: photoLongitude, locationSource,
            gpsAccuracyMeters: primaryPhoto.locationAccuracyMeters, locationCapturedAt: primaryPhoto.locationCapturedAt,
            photoCapturedAt: primaryPhoto.photoCapturedAt, gpsMetadataPresent: allGpsMetadataPresent, gpsValid: allGpsValid,
            siteGpsDistanceMeters, siteCoverageRadiusMeters: hasSavedCoverageRadius ? savedCoverageRadiusMeters : null,
            siteGpsToleranceMeters: hasSavedCoverageRadius ? savedCoverageRadiusMeters : SITE_GPS_TOLERANCE_METERS,
            siteGpsValid, siteLocationStatus, municipalityScope: "inside", siteMatch: siteGpsValid,
            locationVerificationStatus: siteGpsValid ? "site_match" : "site_mismatch", requiresStaffReview: true, verifiedAt: now,
          };
          rows.forEach((row, index) => {
            const allocation = (event.seedlingItems || []).find((item) => item.inventoryId === row.inventoryId) || {};
            const distributionItem = distributionItems.find((item) => String(item.inventoryId || "") === row.inventoryId) || {};
            const prior = correctionFor(row.inventoryId);
            const ref = index === 0 ? contributionRef : contributionCollection.doc(`${contributionRef.id}-${index}`);
            transaction.create(ref, {
              ...shared, finalReportGroupIndex: index,
              inventoryId: row.inventoryId, species: allocation.species || row.species,
              requestedQuantity: Number(distributionItem.requestedQuantity ?? allocation.quantity ?? 0),
              releasedQuantity: Number(distributionItem.releasedQuantity ?? distributionItem.quantity ?? allocation.quantity ?? 0),
              quantity: row.quantity, leftoverQuantity: row.leftoverQuantity, leftoverReason: row.leftoverReason,
              // The group's single evidence set lives on its first row.
              photos: index === 0 ? uploadedPhotos : [], imageHashes: index === 0 ? uploadedPhotos.map((photo) => photo.imageHash) : [],
              ...(index === 0 ? {} : { evidenceSubmissionId: contributionRef.id }),
              ...(prior ? { correctionOf: prior.id, revision: Number(prior.revision || 0) + 1 } : { revision: 0 }),
            });
          });
          for (const photo of uploadedPhotos) {
            transaction.create(evidenceHashCollection.doc(photo.imageHash), {
              reportId: parentId, contributionId: contributionRef.id, eventId: submittedEventId, createdAt: now,
            });
          }
          for (const row of correctedRows) {
            transaction.update(contributionCollection.doc(row.id), { correctedBySubmission: contributionRef.id, correctedAt: now, updatedAt: now });
          }
          const submitterName = data.submittedByName || data.participantName || distribution.participantName || "a participant";
          createVerificationLogInTransaction(transaction, {
            plantingReportId: parentId, submissionId: contributionRef.id,
            action: correctedRows.length ? "Participant Resubmission" : "Participant Final Report Submission",
            previousStatus: correctedRows.length ? WORKFLOW_STATUS.RETURNED : "", newStatus: WORKFLOW_STATUS.PENDING_REVIEW,
            performedBy: data.participantId, performedByRole: "participant", performedByName: submitterName,
            remarks: correctedRows.length ? `Corrected final report ${correctedRows[0].finalReportGroupId || correctedRows[0].id}.` : "", createdAt: now,
          });
          staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
            notificationId: `planting_report_submitted_staff_${parentId}_${contributionRef.id}_${recipient.id}`,
            recipientUserId: recipient.id, type: "planting_report_submitted_staff", title: "New Planting Report Submitted",
            message: `${submitterName} submitted the final planting report for ${linkedEvent?.name || site.siteName || parentId}.`,
            relatedRecordType: "plantingReport", relatedRecordId: parentId, relatedSubrecordId: contributionRef.id, createdAt: now,
            details: { submitterName, eventName: linkedEvent?.name || "", siteName: site.siteName || "", submittedAt: now },
          }));
          createNotificationInTransaction(transaction, {
            notificationId: `planting_report_submitted_${parentId}_${contributionRef.id}_${data.participantId}`,
            recipientUserId: data.participantId, type: "planting_report_submitted", title: "Planting Report Submitted",
            message: "Your final planting report was submitted and is pending MENRO Staff verification.",
            relatedRecordType: "plantingReport", relatedRecordId: parentId, relatedSubrecordId: contributionRef.id, createdAt: now,
          });
          if (suspiciousFlags.length > 0 || automatedStatus === "Flagged") {
            staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
              notificationId: `planting_evidence_flagged_${parentId}_${contributionRef.id}_${recipient.id}`,
              recipientUserId: recipient.id, type: "planting_evidence_flagged", title: "Planting Evidence Requires Review",
              message: `Evidence submitted by ${submitterName} has verification findings requiring Staff review.`,
              relatedRecordType: "plantingReport", relatedRecordId: parentId, relatedSubrecordId: contributionRef.id, createdAt: now,
              details: { suspiciousFlags },
            }));
          }
          return;
        }
        if (finalReportEnforced()) {
          throw workflowFail(409, "Submit one final planting report covering every released seedling type.");
        }
        const currentAllocation = (event.seedlingItems || []).find((item) => item.inventoryId === inventoryId);
        if (!event.allocationReleasedAt || !currentAllocation) {
          throw new Error("Seedling tree item has not been released for this event.");
        }
        const current = Number(event.recordedSeedlingsByInventory?.[inventoryId] || 0);
        const reserved = Number(event.pendingSeedlingsByInventory?.[inventoryId] || 0);
        const remaining = Math.max(0, Number(currentAllocation.quantity) - current - reserved - Number(event.leftoverSeedlingsByInventory?.[inventoryId] || 0));
        if (data.confirmationMode === "final" && (quantityPlanted + leftovers !== remaining || remaining <= 0)) {
          throw Object.assign(new Error("The final confirmation must cover the current remaining released balance. Refresh before submitting."), { status: 409, fieldErrors: { quantityPlanted: "Final planted = current remaining reportable quantity minus final leftovers." } });
        }
        if (quantityPlanted + leftovers > remaining) {
          const message = `Quantity exceeds the remaining reportable quantity. Only ${remaining} trees remain available for reporting.`;
          throw Object.assign(new Error(message), { status: 400, fieldErrors: { quantityPlanted: message } });
        }
        parentId = `event_${submittedEventId}`;
        // A correction links to the submission MENRO Staff returned. The new
        // evidence still passed every geotag check above; history stays immutable.
        let correctionRef = null, correction = null;
        if (data.correctionOf) {
          correctionRef = contributionCollection.doc(data.correctionOf);
          const prior = await transaction.get(correctionRef);
          correction = prior.exists ? prior.data() : null;
          if (!correction || correction.officialStaffReport === true || correction.reportId !== parentId ||
              (correction.contributorId || correction.participantId) !== data.participantId ||
              correction.inventoryId !== inventoryId || correction.correctedBySubmission ||
              deriveWorkflowStatus(correction) !== WORKFLOW_STATUS.RETURNED) {
            throw workflowFail(409, "Only your own submission returned for correction can be resubmitted for the same event and seedling.");
          }
        }
        const hashDocs = await Promise.all(uploadedPhotos.map((photo) =>
          transaction.get(evidenceHashCollection.doc(photo.imageHash))));
        if (hashDocs.some((doc) => doc.exists)) {
          throw new Error("Duplicate planting image detected.");
        }
        const initialProgress = quantityPlanted + leftovers >= Number(event.seedlingTotalQuantity || 0) &&
          submissionStaffReviewStatus === "Pending Review"
          ? "Fully Reported — Awaiting Review"
          : quantityPlanted >= Number(event.seedlingTotalQuantity || 0)
            ? "Completed" : "Partial";
        const parent = await parentForEventInTransaction(
          transaction, submittedEventId, event, now, quantityPlanted, initialProgress, {
            activeSubmittedQuantity: quantityPlanted,
            declaredLeftoverQuantity: leftovers,
            acceptedQuantity: 0,
            pendingReviewQuantity: quantityPlanted,
            reportingProgress: initialProgress,
          }
        );
        if (complete) complete({ collection: "plantingReports", recordId: parentId, contributionId: contributionRef.id });
        consumeCaptures(`${parentId}:${contributionRef.id}`);
        if (!parent.created && !["Draft", "Pending", "Pending Review", "Awaiting Submission", "Partial",
          "Fully Reported — Awaiting Review", "Fully Reported â€” Awaiting Review"].includes(parent.data.verificationStatus)) {
          throw new Error("This planting report has already been finalized.");
        }
        const recorded = { ...(event.recordedSeedlingsByInventory || {}) };
        recorded[inventoryId] = current + quantityPlanted;
        transaction.update(eventRef, {
          recordedSeedlingsByInventory: recorded,
          officialReportingVersion: Number(event.officialReportingVersion || 0) + 1,
          recordedSeedlingQuantity: Number(event.recordedSeedlingQuantity || 0) + quantityPlanted,
          ...(leftovers ? { leftoverSeedlingsByInventory: { ...(event.leftoverSeedlingsByInventory || {}), [inventoryId]: Number(event.leftoverSeedlingsByInventory?.[inventoryId] || 0) + leftovers }, leftoverSeedlingQuantity: Number(event.leftoverSeedlingQuantity || 0) + leftovers } : {}),
          remainingSeedlingQuantity: Math.max(0, event.seedlingItems.reduce((sum, item) => sum + availableForReporting(event, item), 0) - quantityPlanted - leftovers),
          updatedAt: now,
        });
        if (!parent.created) {
          const nextActive = Number(parent.data.activeSubmittedQuantity ?? parent.data.quantityPlanted ?? 0) + quantityPlanted;
          const nextAccepted = Number(parent.data.acceptedQuantity || 0);
          const nextPending = Number(parent.data.pendingReviewQuantity || 0) + quantityPlanted;
          const totalReleased = Number(event.seedlingTotalQuantity || parent.data.quantityReleased || 0);
          const nextProgress = progressFor({ released: totalReleased, active: nextActive, accepted: nextAccepted, pending: nextPending,
            leftovers: Number(parent.data.declaredLeftoverQuantity || 0) + leftovers, acceptedLeftovers: Number(parent.data.acceptedLeftoverQuantity || 0), pendingLeftovers: Number(parent.data.pendingReviewLeftoverQuantity || 0) + leftovers });
          transaction.update(parent.ref, {
            quantityPlanted: Number(parent.data.quantityPlanted || 0) + quantityPlanted,
            activeSubmittedQuantity: nextActive,
            acceptedQuantity: nextAccepted,
            ...(leftovers ? { declaredLeftoverQuantity: Number(parent.data.declaredLeftoverQuantity || 0) + leftovers, pendingReviewLeftoverQuantity: Number(parent.data.pendingReviewLeftoverQuantity || 0) + leftovers } : {}),
            pendingReviewQuantity: nextPending,
            remainingAvailableQuantity: Math.max(0, totalReleased - nextActive - Number(parent.data.declaredLeftoverQuantity || 0) - leftovers),
            reportingProgress: nextProgress,
            verificationStatus: nextProgress,
            submittedAt: now,
            updatedAt: now,
            ...(!parent.data.earlyMonitoringOriginalSubmittedAt && activationState().enabled
              ? { earlyMonitoringOriginalSubmittedAt: now } : {}),
          });
        }
        if (correctionRef) {
          transaction.update(correctionRef, { correctedBySubmission: contributionRef.id, correctedAt: now, updatedAt: now });
          createVerificationLogInTransaction(transaction, {
            plantingReportId: parentId, submissionId: contributionRef.id, action: "Participant Resubmission",
            previousStatus: WORKFLOW_STATUS.RETURNED, newStatus: WORKFLOW_STATUS.PENDING_REVIEW,
            performedBy: data.participantId, performedByRole: "participant",
            performedByName: data.submittedByName || data.participantName || "",
            remarks: `Corrected submission ${correctionRef.id}.`, createdAt: now,
          });
        }
        transaction.create(contributionRef, {
          workflowStatus: WORKFLOW_STATUS.PENDING_REVIEW,
          ...(correctionRef ? { correctionOf: correctionRef.id, revision: Number(correction.revision || 0) + 1 } : { revision: 0 }),
          reportId: parentId,
          requestId: event.sourceRequestId,
          eventId: submittedEventId,
          participantId: data.participantId,
          contributorId: data.participantId,
          contributorName: data.participantName || distribution.participantName || "",
          authenticatedSubmitterUid: data.participantId,
          submittedByName: data.submittedByName,
          submittedBySector: data.submittedBySector,
          submittedByContactNumber: data.submittedByContactNumber,
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
          ...(leftovers ? { leftoverQuantity: leftovers } : {}),
          recordedAt: now,
          photos: uploadedPhotos,
          imageHashes: uploadedPhotos.map((photo) => photo.imageHash),
          automatedVerificationStatus: automatedStatus,
          verificationStatus: submissionVerificationStatus,
          staffReviewStatus: submissionStaffReviewStatus,
          staffApprovalRequired: true,
          submissionWorkflowVersion: 2,
          verificationDetails: suspiciousFlags,
          reviewedBy: "",
          reviewedByName: "",
          reviewedAt: null,
          rejectionReason: "",
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
          siteCoverageRadiusMeters: hasSavedCoverageRadius
            ? savedCoverageRadiusMeters
            : null,
          siteGpsToleranceMeters: hasSavedCoverageRadius
            ? savedCoverageRadiusMeters
            : SITE_GPS_TOLERANCE_METERS,
          siteGpsValid,
          siteLocationStatus,
          municipalityScope: "inside",
          siteMatch: siteGpsValid,
          locationVerificationStatus: siteGpsValid ? "site_match" : "site_mismatch",
          requiresStaffReview: true,
          verifiedAt: now,
        });
        for (const photo of uploadedPhotos) {
          transaction.create(evidenceHashCollection.doc(photo.imageHash), {
            reportId: parentId,
            contributionId: contributionRef.id,
            eventId: submittedEventId,
            createdAt: now,
          });
        }
        const submitterName = data.submittedByName || data.participantName ||
          distribution.participantName || "a participant";
        staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
          notificationId: `planting_report_submitted_staff_${parentId}_${contributionRef.id}_${recipient.id}`,
          recipientUserId: recipient.id,
          type: "planting_report_submitted_staff",
          title: "New Planting Report Submitted",
          message: `${submitterName} submitted planting evidence for ${linkedEvent?.name || site.siteName || parentId}.`,
          relatedRecordType: "plantingReport",
          relatedRecordId: parentId,
          relatedSubrecordId: contributionRef.id,
          createdAt: now,
          details: { submitterName, eventName: linkedEvent?.name || "", siteName: site.siteName || "", submittedAt: now },
        }));
        createNotificationInTransaction(transaction, {
          notificationId: `planting_report_submitted_${parentId}_${contributionRef.id}_${data.participantId}`,
          recipientUserId: data.participantId,
          type: "planting_report_submitted",
          title: "Planting Report Submitted",
          message: "Your planting report was submitted and is pending MENRO Staff verification.",
          relatedRecordType: "plantingReport",
          relatedRecordId: parentId,
          relatedSubrecordId: contributionRef.id,
          createdAt: now,
        });
        if (suspiciousFlags.length > 0 || automatedStatus === "Flagged") {
          staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
            notificationId: `planting_evidence_flagged_${parentId}_${contributionRef.id}_${recipient.id}`,
            recipientUserId: recipient.id,
            type: "planting_evidence_flagged",
            title: "Planting Evidence Requires Review",
            message: `Evidence submitted by ${submitterName} has verification findings requiring Staff review.`,
            relatedRecordType: "plantingReport",
            relatedRecordId: parentId,
            relatedSubrecordId: contributionRef.id,
            createdAt: now,
            details: { suspiciousFlags },
          }));
        }
      });
      persisted = true;
      const doc = await reportCollection.doc(parentId).get();
      return { ...await reportDetails(doc.id, doc.data()), participantSubmissionId: contributionRef.id };
    }

    const docRef = operation ? reportCollection.doc(operation.targetId) : reportCollection.doc();
    const hashRefs = uploadedPhotos.map((photo) => evidenceHashCollection.doc(photo.imageHash));
    let reportNumber = "";
    await db.runTransaction(async (transaction) => {
      const complete = operation ? await require("./evidenceWorkflow.service").workflow().prepareLink(transaction, operation) : null;
      const consumeCaptures = await require("./evidenceCaptureSession.service").prepareConsumption(transaction, captureEvidence);
      const staffRecipients = await getRoleRecipientsInTransaction(transaction, ["staff"]);
      const hashDocs = await Promise.all(hashRefs.map((hashRef) => transaction.get(hashRef)));
      if (hashDocs.some((hashDoc) => hashDoc.exists)) {
        throw new Error("Duplicate planting image detected.");
      }
      const correctionRef = data.correctionOf ? reportCollection.doc(data.correctionOf) : null;
      const correctionDoc = correctionRef ? await transaction.get(correctionRef) : null;
      if (correctionRef && (!correctionDoc.exists || correctionDoc.data().correctedByReportId ||
          correctionDoc.data().participantId !== data.participantId)) {
        throw workflowFail(409, "This returned planting report was already corrected.");
      }
      reportNumber = await nextRecordNumber(transaction, {
        prefix: "RPT",
        counterKey: "plantingReports",
        date: typeof now?.toDate === "function" ? now.toDate() : new Date(),
        timestamp: now,
      });
      if (complete) complete({ collection: "plantingReports", recordId: docRef.id });
      consumeCaptures(docRef.id);
      transaction.create(docRef, { ...reportData, reportNumber, workflowStatus: WORKFLOW_STATUS.PENDING_REVIEW,
        ...(correctionRef ? { correctionOf: correctionRef.id, revision: Number(correctionDoc.data().revision || 0) + 1 } : { revision: 0 }) });
      if (correctionRef) {
        transaction.update(correctionRef, { correctedByReportId: docRef.id, correctedAt: now, updatedAt: now });
        createVerificationLogInTransaction(transaction, {
          plantingReportId: docRef.id, action: "Participant Resubmission",
          previousStatus: WORKFLOW_STATUS.RETURNED, newStatus: WORKFLOW_STATUS.PENDING_REVIEW,
          performedBy: data.participantId, performedByRole: "participant",
          performedByName: data.submittedByName || data.participantName || "",
          remarks: `Corrected planting report ${correctionRef.id}.`, createdAt: now,
        });
      }
      hashRefs.forEach((hashRef) => transaction.create(hashRef, {
        reportId: docRef.id,
        createdAt: now,
      }));
      const submitterName = data.submittedByName || data.participantName ||
        distribution.participantName || "a participant";
      staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
        notificationId: `planting_report_submitted_staff_${docRef.id}_${recipient.id}`,
        recipientUserId: recipient.id,
        type: "planting_report_submitted_staff",
        title: "New Planting Report Submitted",
        message: `${submitterName} submitted planting evidence for ${site.siteName || docRef.id}.`,
        relatedRecordType: "plantingReport",
        relatedRecordId: docRef.id,
        createdAt: now,
        details: { reportNumber, submitterName, eventName: linkedEvent?.name || "", siteName: site.siteName || "", submittedAt: now },
      }));
      createNotificationInTransaction(transaction, {
        notificationId: `planting_report_submitted_${docRef.id}_${data.participantId}`,
        recipientUserId: data.participantId,
        type: "planting_report_submitted",
        title: "Planting Report Submitted",
        message: `${reportNumber} was submitted and is pending MENRO Staff verification.`,
        relatedRecordType: "plantingReport",
        relatedRecordId: docRef.id,
        createdAt: now,
      });
      if (suspiciousFlags.length > 0 || automatedStatus === "Flagged") {
        staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
          notificationId: `planting_evidence_flagged_${docRef.id}_${recipient.id}`,
          recipientUserId: recipient.id,
          type: "planting_evidence_flagged",
          title: "Planting Evidence Requires Review",
          message: `Evidence for ${reportNumber} has verification findings requiring Staff review.`,
          relatedRecordType: "plantingReport",
          relatedRecordId: docRef.id,
          createdAt: now,
          details: { reportNumber, suspiciousFlags },
        }));
      }
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

  // Staff/Admin-only listing (route RBAC). The `participantId` here is a
  // filter, not the viewer, so participant redaction must not be applied —
  // doing so blanked submitter name, barangay, organization and contact
  // details for Staff and Admin.
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
    const [ownedSnapshot, contributionSnapshot, participantSnapshot] = await Promise.all([
      reportCollection
        .where(
          "participantId",
          "==",
          participantId
        )
        .get(),
      contributionCollection.where("contributorId", "==", participantId).get(),
      db.collection("eventParticipants").get(),
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
    const authorizedEventIds = new Set(participantSnapshot.docs
      .filter((doc) => {
        const participant = doc.data();
        return participant.userId === participantId || participant.participantId === participantId || doc.id === participantId;
      })
      .map((doc) => doc.data().eventId).filter(Boolean));
    if (authorizedEventIds.size) {
      const sharedSnapshot = await reportCollection.get();
      sharedSnapshot.docs.filter((doc) => authorizedEventIds.has(doc.data().eventId))
        .forEach((doc) => reportsById.set(doc.id, withWorkflowStatus(doc)));
    }

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

    const detailed = await Promise.all(reports.map((report) =>
      report.reportType === "parent" ? reportDetails(report.id, report) : report
    ));
    return detailed.map((report) => participantSafeReport(report, participantId));
  };


// --------------------------------
// PLANTING REPORT REVIEW DECISIONS
//
// Participant submissions: MENRO Staff forwards (Reviewed) or returns them for
// correction; only MENRO Admin approves (Completed) or rejects (Rejected) a
// Staff-reviewed submission. Official Staff submissions are decided by Admin
// in officialPlantingReport.service. Only Admin approval accepts planted
// quantities, completes progress and activates monitoring eligibility.
// --------------------------------
const STAFF_REVIEW_ONLY = "Only MENRO Staff can review participant planting reports.";
const ADMIN_DECISION_ONLY = "Only MENRO Admin can approve or reject a planting report after Staff review.";

const reviewActor = (uid, fullName, role) => ({
  uid, fullName: fullName || "", role: String(role || "").toLowerCase(),
});

function assertActorRole(actor, role, message) {
  if (!actor.uid) throw workflowFail(401, "Authentication is required.");
  if (actor.role !== role) throw workflowFail(403, message);
}

function assertAwaitingStaffReview(stage, ledgerPending) {
  if (!ledgerPending || stage !== WORKFLOW_STATUS.PENDING_REVIEW) {
    throw workflowFail(409, "Only planting reports pending Staff review can be forwarded or returned.");
  }
}

function assertAwaitingAdminDecision(stage, ledgerPending) {
  if (ledgerPending && stage === WORKFLOW_STATUS.PENDING_REVIEW) {
    throw workflowFail(409, "MENRO Staff must review and forward this planting report before Admin approval.");
  }
  if (!ledgerPending || stage !== WORKFLOW_STATUS.REVIEWED) {
    throw workflowFail(409, "Only planting reports reviewed by MENRO Staff can be approved or rejected.");
  }
}

const submitterOf = (submission) => submission.contributorId || submission.participantId;

// Releases a pending contribution's planted and leftover quantities back to
// the event balance (Admin rejection and Staff return share this ledger rule).
// Releases one submission, or every row of a final report (`rows`), back to
// the reportable balance in a single set of ledger writes.
function releaseContributionInTransaction(transaction, {
  contributionRef, current, rows, parentRef, parent, eventRef, event, now, contributionUpdate, returned,
}) {
  const entries = rows || [{ ref: contributionRef, current }];
  const quantity = entries.reduce((sum, entry) => sum + Number(entry.current.quantity || 0), 0);
  const leftover = entries.reduce((sum, entry) => sum + Number(entry.current.leftoverQuantity || 0), 0);
  const recorded = { ...(event.recordedSeedlingsByInventory || {}) };
  const leftoverLedger = { ...(event.leftoverSeedlingsByInventory || {}) };
  for (const { current: entry } of entries) {
    recorded[entry.inventoryId] = Math.max(0, Number(recorded[entry.inventoryId] || 0) - Number(entry.quantity || 0));
    if (Number(entry.leftoverQuantity || 0)) {
      leftoverLedger[entry.inventoryId] = Number(leftoverLedger[entry.inventoryId] || 0) - Number(entry.leftoverQuantity || 0);
    }
  }
  const nextActive = Math.max(0, Number(parent.activeSubmittedQuantity ?? parent.quantityPlanted ?? 0) - quantity);
  const nextPending = Math.max(0, Number(parent.pendingReviewQuantity || 0) - quantity);
  const released = Number(parent.quantityReleased || event.seedlingTotalQuantity || 0);
  const accepted = Number(parent.acceptedQuantity || 0);
  const reportingProgress = progressFor({ released, active: nextActive, accepted, pending: nextPending,
    leftovers: Number(parent.declaredLeftoverQuantity || 0) - leftover, acceptedLeftovers: Number(parent.acceptedLeftoverQuantity || 0), pendingLeftovers: Number(parent.pendingReviewLeftoverQuantity || 0) - leftover });
  entries.forEach((entry) => transaction.update(entry.ref, contributionUpdate));
  transaction.update(eventRef, {
    recordedSeedlingsByInventory: recorded,
    ...(leftover ? { leftoverSeedlingsByInventory: leftoverLedger, leftoverSeedlingQuantity: Number(event.leftoverSeedlingQuantity || 0) - leftover } : {}),
    recordedSeedlingQuantity: Math.max(0, Number(event.recordedSeedlingQuantity || 0) - quantity),
    officialReportingVersion: Number(event.officialReportingVersion || 0) + 1,
    remainingSeedlingQuantity: Math.min(Number(event.seedlingTotalQuantity || 0),
      (event.seedlingItems || []).reduce((sum, item) => sum + availableForReporting(event, item), 0) + quantity + leftover),
    updatedAt: now,
  });
  transaction.update(parentRef, {
    quantityPlanted: nextActive, activeSubmittedQuantity: nextActive,
    pendingReviewQuantity: nextPending,
    ...(leftover ? { declaredLeftoverQuantity: Number(parent.declaredLeftoverQuantity || 0) - leftover, pendingReviewLeftoverQuantity: Number(parent.pendingReviewLeftoverQuantity || 0) - leftover } : {}),
    ...(returned
      ? { returnedQuantity: Number(parent.returnedQuantity || 0) + quantity }
      : { rejectedQuantity: Number(parent.rejectedQuantity || 0) + quantity }),
    remainingAvailableQuantity: Math.max(0, released - nextActive - Number(parent.declaredLeftoverQuantity || 0) + leftover),
    reportingProgress,
    verificationStatus: reportingProgress,
    updatedAt: now,
  });
}

async function loadContributionLedgerInTransaction(transaction, current) {
  const parentRef = reportRefFor(current.reportId);
  const eventRef = db.collection(EVENT_COLLECTION).doc(current.eventId);
  const [parentDoc, eventDoc] = await Promise.all([transaction.get(parentRef), transaction.get(eventRef)]);
  if (!parentDoc.exists || !eventDoc.exists) throw new Error("Planting report not found.");
  return { parentRef, parent: parentDoc.data(), eventRef, event: eventDoc.data() };
}

function notifyStaffReviewerInTransaction(transaction, submission, { key, recordId, subrecordId, approved, reason, now }) {
  const staffId = submission.staffReviewedBy;
  if (!staffId) return;
  createNotificationInTransaction(transaction, {
    notificationId: `planting_report_admin_${approved ? "approved" : "rejected"}_staff_${key}_${staffId}`,
    recipientUserId: staffId,
    type: approved ? "planting_report_approved" : "planting_report_rejected",
    title: approved ? "Reviewed Planting Report Approved" : "Reviewed Planting Report Rejected",
    message: approved
      ? "MENRO Admin approved the planting report you forwarded."
      : `MENRO Admin rejected the planting report you forwarded. Reason: ${reason}`,
    relatedRecordType: "plantingReport", relatedRecordId: recordId,
    ...(subrecordId ? { relatedSubrecordId: subrecordId } : {}), createdAt: now,
  });
}

// The rows a review decision applies to: every row of a final report (v4),
// or just the one legacy submission. Reads only; call before any write.
async function decisionRowsInTransaction(transaction, contributionRef, currentDoc) {
  const current = { ...currentDoc.data(), id: currentDoc.id || contributionRef.id };
  if (!isFinalReportRow(current)) return [{ ref: contributionRef, current }];
  const snapshot = await transaction.get(contributionCollection.where("finalReportGroupId", "==", current.finalReportGroupId));
  const rows = sortGroupRows(snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }))
    .filter((row) => row.reportId === current.reportId));
  if (!rows.some((row) => row.id === current.id)) throw workflowFail(409, "The final planting report changed. Refresh and try again.");
  return rows.map((row) => ({ ref: contributionCollection.doc(row.id), current: row }));
}

// Audit fields naming every row decided together (final reports only).
function groupLogFields(rows) {
  return rows.length > 1 || isFinalReportRow(rows[0]?.current)
    ? { finalReportId: rows[0].current.finalReportId || "", finalReportGroupId: rows[0].current.finalReportGroupId || "",
      submissionIds: rows.map((row) => row.current.id) }
    : {};
}

// Per-species confirmed planted totals after approving `approvedIds`, using the
// same acceptance rule as officialPlantingReport.reviewOfficialSubmission.
async function acceptedTotalsInTransaction(transaction, parentId, approvedIds, expectedAccepted) {
  const approved = new Set([].concat(approvedIds));
  const snapshot = await transaction.get(contributionCollection.where("reportId", "==", parentId));
  const acceptedSeedlingsByInventory = {}, bases = new Set();
  for (const row of snapshot.docs) {
    const data = normalizeSubmission(row.data());
    if ((data.officialStaffReport === true || data.photos?.length || data.finalReportGroupId) && data.verificationStatus !== "Invalid" &&
        (approved.has(row.id) || data.staffReviewStatus === "Accepted" ||
          data.staffApprovalRequired !== true && data.verificationStatus === "Verified" && data.staffReviewStatus === "Not Required")) {
      acceptedSeedlingsByInventory[data.inventoryId] = Number(acceptedSeedlingsByInventory[data.inventoryId] || 0) + Number(data.quantity || 0);
      bases.add(data.confirmationBasis || "documented-participant-report");
    }
  }
  const total = Object.values(acceptedSeedlingsByInventory).reduce((sum, value) => sum + value, 0);
  if (total !== expectedAccepted) {
    throw workflowFail(409, "Confirmed planted quantities require reconciliation before monitoring.");
  }
  return { acceptedSeedlingsByInventory, confirmationBases: [...bases].sort() };
}

// --------------------------------
// STAFF FORWARD TO ADMIN (Reviewed)
// --------------------------------
const forwardPlantingReport = async (id, reviewedBy, remarks, reviewedByName, reviewerRole) => {
  const actor = reviewActor(reviewedBy, reviewedByName, reviewerRole);
  assertActorRole(actor, "staff", STAFF_REVIEW_ONLY);
  const note = optionalRemarks(remarks);
  const contributionRef = contributionCollection.doc(id);
  const contributionDoc = await contributionRef.get();
  if (contributionDoc.exists) {
    if (contributionDoc.data().officialStaffReport === true) {
      throw workflowFail(409, "Staff-submitted planting reports go directly to MENRO Admin.");
    }
    let parentId = "";
    await db.runTransaction(async (transaction) => {
      const currentDoc = await transaction.get(contributionRef);
      if (!currentDoc.exists) throw new Error("Planting report submission not found.");
      const rows = await decisionRowsInTransaction(transaction, contributionRef, currentDoc);
      const current = rows[0].current, id = current.id;
      rows.forEach((row) => assertAwaitingStaffReview(deriveWorkflowStatus(row.current), row.current.staffReviewStatus === "Pending Review"));
      parentId = current.reportId;
      const adminRecipients = await getRoleRecipientsInTransaction(transaction, ["admin"]);
      const now = Timestamp.now();
      rows.forEach((row) => transaction.update(row.ref, {
        workflowStatus: WORKFLOW_STATUS.REVIEWED,
        staffReviewedBy: actor.uid, staffReviewedByName: actor.fullName, staffReviewedAt: now,
        staffReviewRemarks: note, updatedAt: now,
      }));
      createVerificationLogInTransaction(transaction, {
        plantingReportId: parentId, submissionId: id, ...groupLogFields(rows), action: "Staff Review — Forwarded to Admin",
        previousStatus: WORKFLOW_STATUS.PENDING_REVIEW, newStatus: WORKFLOW_STATUS.REVIEWED,
        performedBy: actor.uid, performedByRole: "staff", performedByName: actor.fullName, remarks: note, createdAt: now,
      });
      adminRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
        notificationId: `planting_report_forwarded_${parentId}_${id}_${recipient.id}`,
        recipientUserId: recipient.id, type: "planting_report_forwarded",
        title: "Planting Report Ready for Admin Approval",
        message: `${actor.fullName || "MENRO Staff"} reviewed a planting report submission and forwarded it for your approval.`,
        relatedRecordType: "plantingReport", relatedRecordId: parentId, relatedSubrecordId: id, createdAt: now,
      }));
      createNotificationInTransaction(transaction, {
        notificationId: `planting_report_reviewed_${parentId}_${id}_${submitterOf(current)}`,
        recipientUserId: submitterOf(current), type: "planting_report_reviewed",
        title: "Planting Report Reviewed",
        message: "MENRO Staff reviewed your planting report and forwarded it to the MENRO Admin for approval.",
        relatedRecordType: "plantingReport", relatedRecordId: parentId, relatedSubrecordId: id, createdAt: now,
      });
    });
    return getPlantingReportById(parentId);
  }

  const reportRef = reportRefFor(id);
  await db.runTransaction(async (transaction) => {
    const reportDoc = await transaction.get(reportRef);
    if (!reportDoc.exists) throw new Error("Planting report not found.");
    const currentReport = reportDoc.data();
    if (currentReport.officialPlantingWorkflow === true || currentReport.reportType === "parent") {
      throw workflowFail(409, "Review each planting report submission individually.");
    }
    const ledgerPending = workflowStatus(currentReport.verificationStatus) === "Pending Review";
    assertAwaitingStaffReview(deriveStandaloneWorkflowStatus(currentReport, ledgerPending ? "Pending Review" : ""), ledgerPending);
    const adminRecipients = await getRoleRecipientsInTransaction(transaction, ["admin"]);
    const now = Timestamp.now();
    transaction.update(reportRef, {
      workflowStatus: WORKFLOW_STATUS.REVIEWED,
      staffReviewedBy: actor.uid, staffReviewedByName: actor.fullName, staffReviewedAt: now,
      staffReviewRemarks: note, updatedAt: now,
    });
    createVerificationLogInTransaction(transaction, {
      plantingReportId: id, action: "Staff Review — Forwarded to Admin",
      previousStatus: WORKFLOW_STATUS.PENDING_REVIEW, newStatus: WORKFLOW_STATUS.REVIEWED,
      performedBy: actor.uid, performedByRole: "staff", performedByName: actor.fullName, remarks: note, createdAt: now,
    });
    adminRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
      notificationId: `planting_report_forwarded_${id}_${recipient.id}`,
      recipientUserId: recipient.id, type: "planting_report_forwarded",
      title: "Planting Report Ready for Admin Approval",
      message: `${actor.fullName || "MENRO Staff"} reviewed ${currentReport.reportNumber || "a planting report"} and forwarded it for your approval.`,
      relatedRecordType: "plantingReport", relatedRecordId: id, createdAt: now,
    }));
    createNotificationInTransaction(transaction, {
      notificationId: `planting_report_reviewed_${id}_${currentReport.participantId}`,
      recipientUserId: currentReport.participantId, type: "planting_report_reviewed",
      title: "Planting Report Reviewed",
      message: "MENRO Staff reviewed your planting report and forwarded it to the MENRO Admin for approval.",
      relatedRecordType: "plantingReport", relatedRecordId: id, createdAt: now,
    });
  });
  return withWorkflowStatus(await reportRef.get());
};

// --------------------------------
// RETURN FOR CORRECTION
// Staff returns participant reports; Admin returns official Staff reports.
// --------------------------------
const returnPlantingReport = async (id, returnedBy, remarks, returnedByName, reviewerRole, options = {}) => {
  const actor = reviewActor(returnedBy, returnedByName, reviewerRole);
  const reason = requiredReason(remarks, "return");
  const contributionRef = contributionCollection.doc(id);
  const contributionDoc = await contributionRef.get();
  if (contributionDoc.exists && contributionDoc.data().officialStaffReport === true) {
    return require("./officialPlantingReport.service").reviewOfficialSubmission(actor, id, "return", reason, options);
  }
  assertActorRole(actor, "staff", STAFF_REVIEW_ONLY);
  // Participant returns keep their single-reason workflow.
  if (Array.isArray(options.fields) && options.fields.length) {
    throw workflowFail(400, "Field-specific correction applies only to Staff-submitted planting reports.");
  }
  if (contributionDoc.exists) {
    let parentId = "";
    await db.runTransaction(async (transaction) => {
      const currentDoc = await transaction.get(contributionRef);
      if (!currentDoc.exists) throw new Error("Planting report submission not found.");
      const rows = await decisionRowsInTransaction(transaction, contributionRef, currentDoc);
      const current = rows[0].current, id = current.id;
      rows.forEach((row) => assertAwaitingStaffReview(deriveWorkflowStatus(row.current), row.current.staffReviewStatus === "Pending Review"));
      parentId = current.reportId;
      const ledger = await loadContributionLedgerInTransaction(transaction, current);
      const now = Timestamp.now();
      releaseContributionInTransaction(transaction, {
        ...ledger, rows, now, returned: true,
        contributionUpdate: {
          staffReviewStatus: "Rejected", workflowStatus: WORKFLOW_STATUS.RETURNED,
          staffReviewedBy: actor.uid, staffReviewedByName: actor.fullName, staffReviewedAt: now,
          returnedBy: actor.uid, returnedByName: actor.fullName, returnedByRole: "staff", returnedAt: now,
          returnReason: reason, reviewRemarks: reason, updatedAt: now,
        },
      });
      createVerificationLogInTransaction(transaction, {
        plantingReportId: parentId, submissionId: id, ...groupLogFields(rows), action: "Staff Return for Correction",
        previousStatus: WORKFLOW_STATUS.PENDING_REVIEW, newStatus: WORKFLOW_STATUS.RETURNED,
        performedBy: actor.uid, performedByRole: "staff", performedByName: actor.fullName, remarks: reason, createdAt: now,
      });
      createNotificationInTransaction(transaction, {
        notificationId: `planting_report_returned_${parentId}_${id}_${submitterOf(current)}`,
        recipientUserId: submitterOf(current), type: "planting_report_returned",
        title: "Planting Report Returned for Correction",
        message: `MENRO Staff returned your planting report for correction. Reason: ${reason}`,
        relatedRecordType: "plantingReport", relatedRecordId: parentId, relatedSubrecordId: id, createdAt: now,
      });
    });
    return getPlantingReportById(parentId);
  }

  const reportRef = reportRefFor(id);
  await db.runTransaction(async (transaction) => {
    const reportDoc = await transaction.get(reportRef);
    if (!reportDoc.exists) throw new Error("Planting report not found.");
    const currentReport = reportDoc.data();
    if (currentReport.officialPlantingWorkflow === true || currentReport.reportType === "parent") {
      throw workflowFail(409, "Review each planting report submission individually.");
    }
    const ledgerPending = workflowStatus(currentReport.verificationStatus) === "Pending Review";
    assertAwaitingStaffReview(deriveStandaloneWorkflowStatus(currentReport, ledgerPending ? "Pending Review" : ""), ledgerPending);
    const now = Timestamp.now();
    transaction.update(reportRef, {
      verificationStatus: "Rejected", workflowStatus: WORKFLOW_STATUS.RETURNED,
      staffReviewedBy: actor.uid, staffReviewedByName: actor.fullName, staffReviewedAt: now,
      returnedBy: actor.uid, returnedByName: actor.fullName, returnedByRole: "staff", returnedAt: now,
      returnReason: reason, updatedAt: now,
    });
    createVerificationLogInTransaction(transaction, {
      plantingReportId: id, action: "Staff Return for Correction",
      previousStatus: WORKFLOW_STATUS.PENDING_REVIEW, newStatus: WORKFLOW_STATUS.RETURNED,
      performedBy: actor.uid, performedByRole: "staff", performedByName: actor.fullName, remarks: reason, createdAt: now,
    });
    createNotificationInTransaction(transaction, {
      notificationId: `planting_report_returned_${id}_${currentReport.participantId}`,
      recipientUserId: currentReport.participantId, type: "planting_report_returned",
      title: "Planting Report Returned for Correction",
      message: `MENRO Staff returned your planting report for correction. Reason: ${reason}`,
      relatedRecordType: "plantingReport", relatedRecordId: id, createdAt: now,
    });
  });
  return withWorkflowStatus(await reportRef.get());
};

// --------------------------------
// ADMIN APPROVE (Completed)
// --------------------------------
const approvePlantingReport =
  async (
    id,
    approvedBy,
    remarks,
    reviewedByName,
    reviewerRole = "staff"
  ) => {
    const actor = reviewActor(approvedBy, reviewedByName, reviewerRole);
    const note = optionalRemarks(remarks);
    const contributionRef = contributionCollection.doc(id);
    const contributionDoc = await contributionRef.get();
    if (contributionDoc.exists) {
      if (contributionDoc.data().officialStaffReport === true) return require("./officialPlantingReport.service").reviewOfficialSubmission(actor, id, "approve", note);
      assertActorRole(actor, "admin", ADMIN_DECISION_ONLY);
      let parentId = "";
      await db.runTransaction(async (transaction) => {
        const currentDoc = await transaction.get(contributionRef);
        if (!currentDoc.exists) throw new Error("Planting report submission not found.");
        const rows = await decisionRowsInTransaction(transaction, contributionRef, currentDoc);
        const current = rows[0].current, id = current.id;
        rows.forEach((row) => assertAwaitingAdminDecision(deriveWorkflowStatus(row.current), row.current.staffReviewStatus === "Pending Review"));
        parentId = current.reportId;
        const parentRef = reportRefFor(parentId);
        const parentDoc = await transaction.get(parentRef);
        if (!parentDoc.exists) throw new Error("Planting report not found.");
        const parent = parentDoc.data();
        const quantity = rows.reduce((sum, row) => sum + Number(row.current.quantity || 0), 0);
        const leftover = rows.reduce((sum, row) => sum + Number(row.current.leftoverQuantity || 0), 0);
        const accepted = Number(parent.acceptedQuantity || 0) + quantity;
        const pending = Math.max(0, Number(parent.pendingReviewQuantity || 0) - quantity);
        const released = Number(parent.quantityReleased || 0);
        const active = Number(parent.activeSubmittedQuantity ?? parent.quantityPlanted ?? 0);
        const reportingProgress = progressFor({ released, active, accepted, pending,
          leftovers: Number(parent.declaredLeftoverQuantity || 0), acceptedLeftovers: Number(parent.acceptedLeftoverQuantity || 0) + leftover, pendingLeftovers: Number(parent.pendingReviewLeftoverQuantity || 0) - leftover });
        const now = Timestamp.now();
        const earlyMonitoring = !parent.reportingPolicy && reportingProgress === "Completed" && !parent.earlyMonitoring
          ? buildEarlyMonitoringPolicy({
            originalSubmittedAt: parent.earlyMonitoringOriginalSubmittedAt ||
              (activationState().enabled ? now : parent.createdAt),
            verifiedAt: now,
            officialOpeningDate: shiftCalendarDate(String(parent.plantingDate || parent.eventDate || ""), 14),
          }) : null;
        const monitoringRecipients = earlyMonitoring?.applicable
          ? await getRoleRecipientsInTransaction(transaction, ["staff", "admin"]) : [];
        // Reports that also hold official Staff submissions carry per-species
        // confirmed totals that cohorts read. Keep them current here exactly as
        // the official Admin decision does (all reads happen before any write).
        const perSpecies = parent.officialPlantingWorkflow === true
          ? await acceptedTotalsInTransaction(transaction, parentId, rows.map((row) => row.current.id), accepted) : null;
        await ensureCohortForAuthoritativeReportInTransaction(transaction, {
          reportId: parentId,
          report: {
            ...parent,
            acceptedQuantity: accepted,
            ...(perSpecies || {}),
            reportingProgress,
            verificationStatus: reportingProgress,
          },
          now,
        });
        rows.forEach((row) => transaction.update(row.ref, {
          staffReviewStatus: "Accepted", workflowStatus: WORKFLOW_STATUS.COMPLETED,
          reviewedBy: actor.uid, reviewedByName: actor.fullName, reviewedAt: now,
          adminDecisionBy: actor.uid, adminDecisionByName: actor.fullName, adminDecisionAt: now,
          reviewRemarks: note, updatedAt: now,
        }));
        transaction.update(parentRef, {
          acceptedQuantity: accepted, pendingReviewQuantity: pending,
          ...(perSpecies || {}),
          ...(leftover ? { acceptedLeftoverQuantity: Number(parent.acceptedLeftoverQuantity || 0) + leftover, pendingReviewLeftoverQuantity: Number(parent.pendingReviewLeftoverQuantity || 0) - leftover } : {}),
          reportingProgress,
          verificationStatus: reportingProgress,
          updatedAt: now,
          ...(earlyMonitoring ? { earlyMonitoring, earlyMonitoringVerifiedAt: now } : {}),
        });

        if (earlyMonitoring?.applicable) monitoringRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
          notificationId: `early_monitoring_scheduled_${parentId}_${recipient.id}`,
          recipientUserId: recipient.id,
          type: "early_monitoring_scheduled", title: "Early Monitoring Scheduled",
          message: `Early Survival Monitoring opens on ${earlyMonitoring.openingDate}.`,
          relatedRecordType: "monitoring", relatedRecordId: parentId, createdAt: now,
          details: { openingDate: earlyMonitoring.openingDate, deadlineDate: earlyMonitoring.deadlineDate },
        }));
        createVerificationLogInTransaction(transaction, {
          plantingReportId: parentId, submissionId: id, ...groupLogFields(rows), action: "Admin Approval",
          previousStatus: WORKFLOW_STATUS.REVIEWED, newStatus: WORKFLOW_STATUS.COMPLETED,
          performedBy: actor.uid, performedByRole: "admin", performedByName: actor.fullName,
          remarks: note, createdAt: now,
        });
        createNotificationInTransaction(transaction, {
          recipientUserId: submitterOf(current),
          notificationId: `planting_report_accepted_${parentId}_${id}_${submitterOf(current)}`,
          type: "planting_report_accepted", title: "Planting Report Approved",
          message: "MENRO Admin approved your planting report. Your planted quantity is now confirmed.",
          relatedRecordType: "plantingReport", relatedRecordId: parentId,
          relatedSubrecordId: id, createdAt: now,
        });
        notifyStaffReviewerInTransaction(transaction, current, { key: `${parentId}_${id}`, recordId: parentId, subrecordId: id, approved: true, now });
      });
      return getPlantingReportById(parentId);
    }

    assertActorRole(actor, "admin", ADMIN_DECISION_ONLY);
    const reportRef = reportRefFor(id);
    await db.runTransaction(async (transaction) => {
      const reportDoc = await transaction.get(reportRef);
      if (!reportDoc.exists) throw new Error("Planting report not found.");
      const currentReport = reportDoc.data();
      if (currentReport.officialPlantingWorkflow === true) throw Object.assign(new Error("Review each official Staff submission through its Admin decision."), { status: 409 });
      const ledgerPending = workflowStatus(currentReport.verificationStatus) === "Pending Review";
      assertAwaitingAdminDecision(deriveStandaloneWorkflowStatus(currentReport, ledgerPending ? "Pending Review" : ""), ledgerPending);
      const now = Timestamp.now();
      const earlyMonitoring = buildEarlyMonitoringPolicy({
        originalSubmittedAt: currentReport.earlyMonitoringOriginalSubmittedAt || currentReport.createdAt,
        verifiedAt: now,
        officialOpeningDate: shiftCalendarDate(String(currentReport.plantingDate || ""), 14),
      });
      const monitoringRecipients = earlyMonitoring?.applicable
        ? await getRoleRecipientsInTransaction(transaction, ["staff", "admin"]) : [];
      await ensureCohortForAuthoritativeReportInTransaction(transaction, {
        reportId: id,
        report: { ...currentReport, verificationStatus: "Approved" },
        now,
      });
      transaction.update(reportRef, {
        verificationStatus: "Approved", workflowStatus: WORKFLOW_STATUS.COMPLETED,
        reviewedBy: actor.uid, reviewedByName: actor.fullName, reviewedAt: now,
        approvedBy: actor.uid, approvalRemarks: note, approvedAt: now,
        rejectedBy: "", rejectionRemarks: "", rejectedAt: null,
        updatedAt: now,
        ...(earlyMonitoring ? { earlyMonitoring, earlyMonitoringVerifiedAt: now } : {}),
      });
      createVerificationLogInTransaction(transaction, {
        plantingReportId: id, action: "Admin Approval",
        previousStatus: WORKFLOW_STATUS.REVIEWED, newStatus: WORKFLOW_STATUS.COMPLETED,
        performedBy: actor.uid, performedByRole: "admin", performedByName: actor.fullName,
        remarks: note, createdAt: now,
      });
      createNotificationInTransaction(transaction, {
        recipientUserId: currentReport.participantId,
        notificationId: `planting_report_approved_${id}_${currentReport.participantId}`,
        type: "planting_report_approved",
        title: "Planting Report Approved",
        message: "MENRO Admin approved your planting report. Your planted quantity is now confirmed.",
        relatedRecordType: "plantingReport",
        relatedRecordId: id,
        createdAt: now,
      });
      notifyStaffReviewerInTransaction(transaction, currentReport, { key: id, recordId: id, approved: true, now });
      if (earlyMonitoring?.applicable) monitoringRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
        notificationId: `early_monitoring_scheduled_${id}_${recipient.id}`,
        recipientUserId: recipient.id,
        type: "early_monitoring_scheduled", title: "Early Monitoring Scheduled",
        message: `Early Survival Monitoring opens on ${earlyMonitoring.openingDate}.`,
        relatedRecordType: "monitoring", relatedRecordId: id, createdAt: now,
        details: { openingDate: earlyMonitoring.openingDate, deadlineDate: earlyMonitoring.deadlineDate },
      }));
    });

    return withWorkflowStatus(await reportRef.get());
  };


// --------------------------------
// ADMIN REJECT (Rejected, final)
// --------------------------------
const rejectPlantingReport =
  async (
    id,
    rejectedBy,
    remarks,
    reviewedByName,
    reviewerRole = "staff"
  ) => {
    const actor = reviewActor(rejectedBy, reviewedByName, reviewerRole);
    const reason = requiredReason(remarks, "rejection");
    const contributionRef = contributionCollection.doc(id);
    const contributionDoc = await contributionRef.get();
    if (contributionDoc.exists) {
      if (contributionDoc.data().officialStaffReport === true) return require("./officialPlantingReport.service").reviewOfficialSubmission(actor, id, "reject", reason);
      assertActorRole(actor, "admin", ADMIN_DECISION_ONLY);
      let parentId = "";
      await db.runTransaction(async (transaction) => {
        const currentDoc = await transaction.get(contributionRef);
        if (!currentDoc.exists) throw new Error("Planting report submission not found.");
        const rows = await decisionRowsInTransaction(transaction, contributionRef, currentDoc);
        const current = rows[0].current, id = current.id;
        rows.forEach((row) => assertAwaitingAdminDecision(deriveWorkflowStatus(row.current), row.current.staffReviewStatus === "Pending Review"));
        parentId = current.reportId;
        const ledger = await loadContributionLedgerInTransaction(transaction, current);
        const now = Timestamp.now();
        releaseContributionInTransaction(transaction, {
          ...ledger, rows, now, returned: false,
          contributionUpdate: {
            staffReviewStatus: "Rejected", workflowStatus: WORKFLOW_STATUS.REJECTED,
            reviewedBy: actor.uid, reviewedByName: actor.fullName, reviewedAt: now,
            adminDecisionBy: actor.uid, adminDecisionByName: actor.fullName, adminDecisionAt: now,
            rejectionReason: reason, updatedAt: now,
          },
        });
        createVerificationLogInTransaction(transaction, {
          plantingReportId: parentId, submissionId: id, ...groupLogFields(rows), action: "Admin Rejection",
          previousStatus: WORKFLOW_STATUS.REVIEWED, newStatus: WORKFLOW_STATUS.REJECTED,
          performedBy: actor.uid, performedByRole: "admin", performedByName: actor.fullName, remarks: reason, createdAt: now,
        });
        createNotificationInTransaction(transaction, {
          recipientUserId: submitterOf(current),
          notificationId: `planting_report_rejected_${parentId}_${id}_${submitterOf(current)}`,
          type: "planting_report_rejected", title: "Planting Report Rejected",
          message: `MENRO Admin rejected your planting report. Reason: ${reason}`,
          relatedRecordType: "plantingReport", relatedRecordId: parentId,
          relatedSubrecordId: id, createdAt: now,
        });
        notifyStaffReviewerInTransaction(transaction, current, { key: `${parentId}_${id}`, recordId: parentId, subrecordId: id, approved: false, reason, now });
      });
      return getPlantingReportById(parentId);
    }

    assertActorRole(actor, "admin", ADMIN_DECISION_ONLY);
    const reportRef = reportRefFor(id);
    await db.runTransaction(async (transaction) => {
      const reportDoc = await transaction.get(reportRef);
      if (!reportDoc.exists) throw new Error("Planting report not found.");
      const currentReport = reportDoc.data();
      if (currentReport.officialPlantingWorkflow === true) throw Object.assign(new Error("Review each official Staff submission through its Admin decision."), { status: 409 });
      const ledgerPending = workflowStatus(currentReport.verificationStatus) === "Pending Review";
      assertAwaitingAdminDecision(deriveStandaloneWorkflowStatus(currentReport, ledgerPending ? "Pending Review" : ""), ledgerPending);
      const now = Timestamp.now();
      transaction.update(reportRef, {
        verificationStatus: "Rejected", workflowStatus: WORKFLOW_STATUS.REJECTED,
        reviewedBy: actor.uid, reviewedByName: actor.fullName, reviewedAt: now,
        rejectedBy: actor.uid, rejectionRemarks: reason, rejectedAt: now,
        approvedBy: "", approvalRemarks: "", approvedAt: null,
        updatedAt: now,
      });
      createVerificationLogInTransaction(transaction, {
        plantingReportId: id, action: "Admin Rejection",
        previousStatus: WORKFLOW_STATUS.REVIEWED, newStatus: WORKFLOW_STATUS.REJECTED,
        performedBy: actor.uid, performedByRole: "admin", performedByName: actor.fullName, remarks: reason, createdAt: now,
      });
      createNotificationInTransaction(transaction, {
        recipientUserId: currentReport.participantId,
        notificationId: `planting_report_rejected_${id}_${currentReport.participantId}`,
        type: "planting_report_rejected",
        title: "Planting Report Rejected",
        message: `MENRO Admin rejected your planting report. Reason: ${reason}`,
        relatedRecordType: "plantingReport",
        relatedRecordId: id,
        createdAt: now,
      });
      notifyStaffReviewerInTransaction(transaction, currentReport, { key: id, recordId: id, approved: false, reason, now });
    });

    return withWorkflowStatus(await reportRef.get());
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
  participantSafeReport,
  participantCanAccessReport,
  approvePlantingReport,
  rejectPlantingReport,
  forwardPlantingReport,
  returnPlantingReport,
  getPlantingReportVerificationLogs,
  assertReportableEvent,
  eventStartDate,
};
