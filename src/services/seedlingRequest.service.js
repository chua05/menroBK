const {
  db,
} = require("../config/firebase");
const crypto = require("crypto");

const {
  Timestamp,
} = require(
  "firebase-admin/firestore"
);

const {
  calculateInventoryStatus,
} = require(
  "./inventory.service"
);

const siteService = require("./site.service");

const {
  createDistributionRecordInTransaction,
} = require(
  "./distribution.service"
);

const {
  createTreePlantingEventInTransaction,
} = require(
  "./event.service"
);
const {
  createNotificationInTransaction,
  getRoleRecipientsInTransaction,
  createRoleNotificationsInTransaction,
  createOutOfStockNotificationsInTransaction,
  createDistributionNotificationsInTransaction,
} = require("./notification.service");
const {
  activeRegisteredRecipients,
  writeNotifications,
} = require("./eventNotification.service");
const { createInvitationInTransaction } = require("./guestEvent.service");
const { parentForEventInTransaction } = require("./parentPlantingReport.service");
const {
  buildProcessingEstimate,
  manilaDateOnly,
  scheduleFromRequest,
  normalizeSchedule,
  validateReleasePlantingOrder,
  validateFuturePlantingSchedule,
  samePlantingSchedule,
  requestVersion,
  assertExpectedVersion,
} = require("../utils/seedlingRequestSchedule.util");
const {
  IDENTIFICATION_COLLECTION,
  buildIdentificationRecord,
  getMaskedIdentifications,
  revealIdentification,
} = require("./requestIdentification.service");

const COLLECTION =
  "seedlingRequests";

const deriveSeedlingRequestDocumentId = (participantId, clientSubmissionId) =>
  clientSubmissionId
    ? crypto.createHash("sha256").update(`${cleanString(participantId)}:${cleanString(clientSubmissionId)}`)
      .digest("hex").slice(0, 40)
    : "";

// Legacy internal callers predate optimistic versions. HTTP controllers require
// a version; retaining this compatibility here avoids breaking server-side jobs
// and historical tests that call the service directly.
const assertMutationVersion = (request, expectedVersion) => {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === "") return;
  assertExpectedVersion(request, expectedVersion);
};

const INVENTORY_COLLECTION =
  "seedlingInventory";

const SITES_COLLECTION =
  "sites";

const COUNTERS_COLLECTION = "counters";
const REQUEST_COUNTER_DOCUMENT = "seedlingRequests";
const REVIEW_COUNTER_DOCUMENT = "seedlingRequestReviews";
const REQUEST_NUMBER_PATTERN = /^REQ-(\d{4})-(\d{3,})$/;
const REVIEW_ID_PATTERN = /^REV-(\d{4})-(\d{3,})$/;

const stripSensitiveIdentification = (request, { includePrivateDocument = false } = {}) => {
  const sanitized = { ...request };
  for (const field of [
    "identification",
    "identificationType",
    "idNumber",
    "encryptedIdNumber",
    "schoolInstitutionName",
    "ciphertext",
    "iv",
    "authTag",
  ]) delete sanitized[field];
  if (!includePrivateDocument && sanitized.requestLetter?.privateDocument) {
    sanitized.requestLetter = require("./requestLetterStorage.service").publicMetadata(sanitized.requestLetter.privateDocument);
  } else if (sanitized.workflow?.requestLetter) {
    sanitized.requestLetter = { storageStatus: "legacy_metadata_only",
      originalName: cleanString(sanitized.workflow.requestLetter.name) || "Request letter" };
  }
  if (!includePrivateDocument && Array.isArray(sanitized.requestLetterHistory)) {
    sanitized.requestLetterHistory = sanitized.requestLetterHistory.map(entry => entry?.privateDocument ? ({
      ...require("./requestLetterStorage.service").publicMetadata(entry.privateDocument),
      supersededAt: entry.supersededAt || null,
    }) : ({
      storageStatus: "legacy_metadata_only",
      originalName: cleanString(entry?.legacyMetadata?.name) || "Request letter",
      supersededAt: entry?.supersededAt || null,
    }));
  }
  if (sanitized.workflow) sanitized.workflow = { ...sanitized.workflow, requestLetter: undefined };
  return sanitized;
};

const withAdminIdentification = (request, identification) => ({
  ...stripSensitiveIdentification(request),
  ...(identification ? { identification } : {}),
});

const getManilaYear = (value = new Date()) => {
  const date = typeof value?.toDate === "function"
    ? value.toDate()
    : value instanceof Date
      ? value
      : new Date(value);

  return Number(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Manila",
    year: "numeric",
  }).format(Number.isNaN(date.getTime()) ? new Date() : date));
};

const getRecordYear = (data, fields) => {
  const value = fields
    .map((field) => data?.[field])
    .find((candidate) => candidate !== null && candidate !== undefined && candidate !== "");

  return getManilaYear(value || new Date());
};

const getReadableSequenceFloors = (docs) => {
  const request = new Map();
  const review = new Map();

  for (const doc of docs) {
    const data = doc.data();
    const requestMatch = cleanString(data.requestNumber).match(REQUEST_NUMBER_PATTERN);
    const reviewMatch = cleanString(data.reviewId).match(REVIEW_ID_PATTERN);

    if (requestMatch) {
      const year = Number(requestMatch[1]);
      request.set(year, Math.max(request.get(year) || 0, Number(requestMatch[2])));
    }

    if (reviewMatch) {
      const year = Number(reviewMatch[1]);
      review.set(year, Math.max(review.get(year) || 0, Number(reviewMatch[2])));
    }
  }

  return { request, review };
};

const hasSavedStaffReview = (data) => Boolean(
  data?.reviewedAt ||
  data?.reviewedByUid ||
  data?.reviewedBy ||
  data?.reviewedByName ||
  (Array.isArray(data?.reviewHistory) &&
    data.reviewHistory.some((entry) => entry?.action === "reviewed")) ||
  ["Reviewed", "Approved", "Rejected", "Released"].includes(data?.status)
);

const getReadableReviewerName = async (data) => {
  const existingName = cleanString(
    data?.reviewedByName || data?.staffReviewerName || data?.reviewerName
  );
  if (existingName) return existingName;

  const reviewedByUid = cleanString(data?.reviewedByUid || data?.reviewedBy);
  if (reviewedByUid) {
    const userDoc = await db.collection("users").doc(reviewedByUid).get();
    if (userDoc.exists) {
      const user = userDoc.data();
      const resolvedName = cleanString(
        user.fullName || user.name || user.displayName || user.username
      );
      if (resolvedName) return resolvedName;
    }
  }

  return "MENRO Staff";
};

// Persist readable business IDs on legacy records without changing their
// Firestore document IDs or any relationship keys that point to those IDs.
const ensureReadableRequestMetadata = async (doc, floors) => {
  const initialData = doc.data();
  const needsRequestNumber = !REQUEST_NUMBER_PATTERN.test(
    cleanString(initialData.requestNumber)
  );
  const needsReviewMetadata = hasSavedStaffReview(initialData) && (
    !REVIEW_ID_PATTERN.test(cleanString(initialData.reviewId)) ||
    !cleanString(initialData.reviewedByName) ||
    !cleanString(initialData.reviewedByUid) ||
    cleanString(initialData.reviewStatus) !== "Reviewed"
  );

  if (!needsRequestNumber && !needsReviewMetadata) return doc;

  const requestRef = db.collection(COLLECTION).doc(doc.id);
  const reviewerName = needsReviewMetadata
    ? await getReadableReviewerName(initialData)
    : "";
  let migratedData = initialData;

  await db.runTransaction(async (transaction) => {
    const currentDoc = await transaction.get(requestRef);
    if (!currentDoc.exists) throw new Error("Seedling request not found.");

    const currentData = currentDoc.data();
    const update = {};
    const requestNeedsId = !REQUEST_NUMBER_PATTERN.test(
      cleanString(currentData.requestNumber)
    );
    const reviewNeedsId = hasSavedStaffReview(currentData) &&
      !REVIEW_ID_PATTERN.test(cleanString(currentData.reviewId));
    const requestYear = requestNeedsId
      ? getRecordYear(currentData, ["createdAt", "submittedAt", "requestDate"])
      : null;
    const reviewYear = reviewNeedsId
      ? getRecordYear(currentData, [
        "reviewedAt",
        "reviewedDate",
        "decisionAt",
        "updatedAt",
        "createdAt",
      ])
      : null;
    const requestCounterRef = requestNeedsId
      ? db.collection(COUNTERS_COLLECTION)
        .doc(`${REQUEST_COUNTER_DOCUMENT}_${requestYear}`)
      : null;
    const reviewCounterRef = reviewNeedsId
      ? db.collection(COUNTERS_COLLECTION)
        .doc(`${REVIEW_COUNTER_DOCUMENT}_${reviewYear}`)
      : null;
    const requestCounterDoc = requestCounterRef
      ? await transaction.get(requestCounterRef)
      : null;
    const reviewCounterDoc = reviewCounterRef
      ? await transaction.get(reviewCounterRef)
      : null;
    const now = Timestamp.now();

    if (requestNeedsId) {
      const nextNumber = Math.max(
        Number(requestCounterDoc?.data()?.lastNumber || 0),
        Number(floors.request.get(requestYear) || 0)
      ) + 1;
      if (!Number.isSafeInteger(nextNumber) || nextNumber <= 0) {
        throw new Error("Unable to generate the next request number.");
      }

      update.requestNumber = `REQ-${requestYear}-${String(nextNumber).padStart(3, "0")}`;
      if (cleanString(currentData.requestNumber)) {
        update.legacyRequestNumber = cleanString(currentData.requestNumber);
      }
      transaction.set(requestCounterRef, {
        year: requestYear,
        lastNumber: nextNumber,
        updatedAt: now,
      }, { merge: true });
    }

    if (hasSavedStaffReview(currentData)) {
      const reviewedByUid = cleanString(
        currentData.reviewedByUid || currentData.reviewedBy
      );
      const readableName = cleanString(currentData.reviewedByName) || reviewerName;

      update.reviewedByUid = reviewedByUid;
      update.reviewedByName = readableName || "MENRO Staff";
      update.reviewStatus = "Reviewed";

      if (reviewNeedsId) {
        const nextNumber = Math.max(
          Number(reviewCounterDoc?.data()?.lastNumber || 0),
          Number(floors.review.get(reviewYear) || 0)
        ) + 1;
        if (!Number.isSafeInteger(nextNumber) || nextNumber <= 0) {
          throw new Error("Unable to generate the next review ID.");
        }

        update.reviewId = `REV-${reviewYear}-${String(nextNumber).padStart(3, "0")}`;
        if (cleanString(currentData.reviewId)) {
          update.legacyReviewId = cleanString(currentData.reviewId);
        }
        transaction.set(reviewCounterRef, {
          year: reviewYear,
          lastNumber: nextNumber,
          updatedAt: now,
        }, { merge: true });
      }
    }

    if (Object.keys(update).length > 0) {
      transaction.update(requestRef, update);
    }
    migratedData = { ...currentData, ...update };
  });

  return {
    id: doc.id,
    data: () => migratedData,
  };
};

const ensureReadableRequestDocuments = async (docs, allDocs = docs) => {
  const floors = getReadableSequenceFloors(allDocs);
  const readableDocs = [];

  for (const doc of docs) {
    readableDocs.push(await ensureReadableRequestMetadata(doc, floors));
  }

  return readableDocs;
};

const releasedDistributionMap = async () => {
  const snapshot = await db.collection("distributions").get();
  return new Map(snapshot.docs
    .map((doc) => [doc.id, { id: doc.id, ...doc.data() }])
    .filter(([, distribution]) => distribution.status === "Released"));
};

// Read-only compatibility for historical records whose real Distribution was
// completed before requests began storing the Released status. No migration,
// timestamp, or quantity is fabricated.
const withLegacyReleaseState = (request, distribution) => {
  if (request.status !== "Approved" || !distribution) return request;
  const releasedItems = Array.isArray(distribution.items) ? distribution.items : [];
  return {
    ...request,
    status: "Released",
    legacyRequestStatus: "Approved",
    inventoryReleased: true,
    releasedItems,
    totalQuantityReleased: Number(distribution.totalQuantityReleased || 0),
    releasedBy: distribution.releasedBy || request.releasedBy || "",
    releasedAt: distribution.releasedAt || request.releasedAt || null,
    distributionId: distribution.id,
  };
};

// ========================================
// HELPERS
// ========================================

const cleanString = (
  value
) =>
  String(
    value || ""
  ).trim();

const normalizeBarangay = (
  value
) => {
  const cleaned = cleanString(value).toLowerCase().replace(/\s+/g, " ");
  const match = /^zone\s*(1|2|3|4|5|6|7|8|i|ii|iii|iv|v|vi|vii|viii)(?:\s*poblacion)?$/.exec(cleaned);
  if (!match) return cleaned;
  const zones = { "1": "i", "2": "ii", "3": "iii", "4": "iv", "5": "v", "6": "vi", "7": "vii", "8": "viii" };
  return `zone ${zones[match[1]] || match[1]}`;
};

// ========================================
// NORMALIZE REQUEST ITEMS
//
// Supports:
// 1. New items[] records
// 2. Old single inventoryId records
// ========================================

const normalizeRequestItems = (
  request
) => {
  if (
    Array.isArray(
      request?.items
    ) &&
    request.items.length > 0
  ) {
    return request.items.map(
      (item) => ({
        inventoryId:
          cleanString(
            item.inventoryId
          ),

        species:
          cleanString(
            item.species
          ),

        scientificName:
          cleanString(
            item.scientificName
          ),

        category:
          cleanString(
            item.category
          ),

        quantity:
          Number(
            item.quantity
          ),
      })
    );
  }

  // Backward compatibility.
  if (
    request?.inventoryId
  ) {
    return [
      {
        inventoryId:
          cleanString(
            request.inventoryId
          ),

        species:
          cleanString(
            request.species
          ),

        scientificName:
          cleanString(
            request.scientificName
          ),

        category:
          cleanString(
            request.category
          ),

        quantity:
          Number(
            request.quantity
          ),
      },
    ];
  }

  return [];
};

// ========================================
// VALIDATE BASIC ITEM STRUCTURE
// ========================================

const validateItemStructure = (
  items
) => {
  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    throw new Error(
      "At least one seedling item is required."
    );
  }

  const seenInventoryIds =
    new Set();

  for (
    const item of items
  ) {
    const inventoryId =
      cleanString(
        item.inventoryId
      );

    const quantity =
      Number(
        item.quantity
      );

    if (!inventoryId) {
      throw new Error(
        "A requested seedling has no linked inventory."
      );
    }

    if (
      !Number.isInteger(
        quantity
      ) ||
      quantity <= 0
    ) {
      throw new Error(
        "Requested quantities must be positive whole numbers."
      );
    }

    if (
      seenInventoryIds.has(
        inventoryId
      )
    ) {
      throw new Error(
        "The same seedling inventory cannot be requested more than once."
      );
    }

    seenInventoryIds.add(
      inventoryId
    );
  }
};

// ========================================
// CREATE SEEDLING REQUEST
// ========================================

const createSeedlingRequest =
  async (data, identification = null) => {
    const submittedItems =
      normalizeRequestItems(
        data
      );

    validateItemStructure(
      submittedItems
    );

    const canonicalItems =
      [];

    // Read actual inventory records (existence only).
    for (const item of submittedItems) {
      const inventoryRef = db
        .collection(INVENTORY_COLLECTION)
        .doc(item.inventoryId);

      const inventoryDoc = await inventoryRef.get();

      if (!inventoryDoc.exists || inventoryDoc.data().isDeleted === true) {
        throw new Error(
          "One of the selected seedling inventory records was not found."
        );
      }

      const inventoryData = inventoryDoc.data();

      // Do NOT reject requests where requested quantity exceeds available stock.
      // Preserve requested quantity as provided.

      canonicalItems.push({
        inventoryId: inventoryDoc.id,

        species: cleanString(inventoryData.species),

        scientificName: cleanString(inventoryData.scientificName),

        category: cleanString(inventoryData.category),

        quantity: item.quantity,
      });
    }

    const totalQuantity =
      canonicalItems.reduce(
        (
          total,
          item
        ) =>
          total +
          item.quantity,
        0
      );

    const now =
      Timestamp.now();

    const requestData = {
      ...data,

      // Canonical multi-tree data.
      items:
        canonicalItems,

      totalQuantity,

      createdAt:
        now,

      updatedAt:
        now,

      reviewHistory: [
        ...(Array.isArray(data.reviewHistory) ? data.reviewHistory : []),
        {
          action: "submitted",
          actorId: cleanString(data.participantId),
          actorName: cleanString(data.participantName),
          actorRole: "participant",
          at: now,
        },
      ],
      requestVersion: 0,
      originalSchedule: scheduleFromRequest(data),
      processingEstimate: buildProcessingEstimate(now.toDate()),
      scheduleHistory: [],
    };

    // Remove legacy client values if supplied.
    delete requestData.inventoryId;
    delete requestData.quantity;
    delete requestData.species;
    delete requestData.scientificName;
    delete requestData.category;

    // ========================================
    // VALIDATE PLANTING SITE ELIGIBILITY (participant submission)
    // Use Site service authoritative calculation.
    // Available and Partially Occupied allowed. Full and archived rejected.
    // ========================================
    const plantingSiteId = cleanString(
      requestData.eventProposal?.plantingSiteId
    );

    const isProposedSite = requestData.workflow?.siteMode === "proposed";
    if (!plantingSiteId) {
      throw new Error("Planting site is required.");
    }

    // Reuse site service so utilization logic is authoritative.
    const site = isProposedSite ? null : await siteService.getSiteById(plantingSiteId);

    if (site && normalizeBarangay(site.barangay) !==
        normalizeBarangay(requestData.eventProposal?.barangay)) {
      throw new Error("Selected planting site does not belong to the event barangay.");
    }

    if (site && String(site.status || "").trim().toLowerCase() !== "active") {
      throw new Error("Selected planting site is archived.");
    }

    // site.utilizationPercentage now comes from site.service
    const utilization = Number(site?.utilizationPercentage || 0);

    if (utilization >= 90) {
      throw new Error("Selected planting site is already full.");
    }

    const clientSubmissionId = cleanString(data.clientSubmissionId);
    const documentId = deriveSeedlingRequestDocumentId(data.participantId, clientSubmissionId);
    const docRef = documentId
      ? db.collection(COLLECTION).doc(documentId)
      : db.collection(COLLECTION).doc();
    const identificationRecord = identification
      ? buildIdentificationRecord(docRef.id, data.participantId, identification, now)
      : null;
    const requestYear = Number(new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Manila",
      year: "numeric",
    }).format(new Date()));
    const existingRequestSnapshot = await db.collection(COLLECTION).get();
    const requestSequenceFloor = getReadableSequenceFloors(
      existingRequestSnapshot.docs
    ).request.get(requestYear) || 0;
    const counterRef = db.collection(COUNTERS_COLLECTION)
      .doc(`${REQUEST_COUNTER_DOCUMENT}_${requestYear}`);

    let persistedRequest = null;
    await db.runTransaction(async (transaction) => {
      if (clientSubmissionId) {
        const existingRequest = await transaction.get(docRef);
        if (existingRequest.exists) {
          persistedRequest = { id: docRef.id, ...existingRequest.data() };
          return;
        }
      }
      const counterDoc = await transaction.get(counterRef);
      const staffRecipients = await getRoleRecipientsInTransaction(transaction, ["staff"]);
      if (data.requestLetter?.privateDocument) {
        await require("./requestLetterStorage.service").linkRequestLetterInTransaction(
          transaction, data.requestLetter.privateDocument, docRef.id, data.participantId,
        );
      }
      const currentValue = Math.max(requestSequenceFloor, counterDoc.exists
        ? Number(counterDoc.data()?.lastNumber || 0)
        : 0);
      const nextValue = currentValue + 1;
      if (!Number.isSafeInteger(nextValue) || nextValue <= 0) {
        throw new Error("Unable to generate the next request number.");
      }

      const requestNumber = `REQ-${requestYear}-${String(nextValue).padStart(3, "0")}`;
      transaction.set(counterRef, {
        year: requestYear,
        lastNumber: nextValue,
        updatedAt: now,
      }, { merge: true });
      transaction.create(docRef, {
        ...requestData,
        requestNumber,
      });
      createNotificationInTransaction(transaction, {
        notificationId: `request_submitted_${docRef.id}`,
        recipientUserId: cleanString(data.participantId),
        type: "request_submitted",
        title: "Seedling Request Submitted",
        message: `${requestNumber} was submitted. MENRO normally processes requests within an estimated 3–7 working days; availability and release schedules may change.`,
        relatedRecordType: "seedlingRequest",
        relatedRecordId: docRef.id,
        requestNumber,
        createdAt: now,
        details: { processingEstimate: requestData.processingEstimate },
      });
      staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
        notificationId: `request_submitted_staff_${docRef.id}_${recipient.id}`,
        recipientUserId: recipient.id,
        type: "request_submitted_staff",
        title: "New Seedling Request Submitted",
        message: `${requestNumber} from ${cleanString(data.participantName) || "a participant"} requires Staff review.`,
        relatedRecordType: "seedlingRequest",
        relatedRecordId: docRef.id,
        requestNumber,
        createdAt: now,
        details: {
          requesterName: cleanString(data.participantName),
          requestType: cleanString(data.requestType || data.requestingAs || data.participantType),
          submittedAt: now,
        },
      }));
      if (cleanString(data.preferredReleaseDate) < requestData.processingEstimate.earliestDate) {
        createNotificationInTransaction(transaction, {
          notificationId: `request_early_release_advisory_${docRef.id}`,
          recipientUserId: cleanString(data.participantId),
          type: "request_early_release_advisory",
          title: "Preferred Release Date Advisory",
          message: `Your preferred release date is earlier than the estimated processing window for ${requestNumber}. This is an advisory only and does not reject your request.`,
          relatedRecordType: "seedlingRequest",
          relatedRecordId: docRef.id,
          requestNumber,
          createdAt: now,
          details: { processingEstimate: requestData.processingEstimate },
        });
      }
      if (identificationRecord) {
        transaction.create(
          db.collection(IDENTIFICATION_COLLECTION).doc(docRef.id),
          identificationRecord,
        );
      }
      requestData.requestNumber = requestNumber;
      persistedRequest = { id: docRef.id, ...requestData };
    });

    return stripSensitiveIdentification(persistedRequest);
  };

// ========================================
// GET ALL REQUESTS
// ========================================

const getAllSeedlingRequests =
  async ({ includeIdentification = false } = {}) => {
    const [snapshot, distributions] = await Promise.all([
      db.collection(COLLECTION).get(),
      releasedDistributionMap(),
    ]);
    const readableDocs = await ensureReadableRequestDocuments(snapshot.docs);

    const requests = readableDocs.map(
      (doc) => withLegacyReleaseState({
        id:
          doc.id,

        ...doc.data(),
      }, distributions.get(doc.id))
    );
    if (!includeIdentification) return requests.map(stripSensitiveIdentification);
    const identifications = await getMaskedIdentifications(requests.map((request) => request.id));
    return requests.map((request) => withAdminIdentification(
      request,
      identifications.get(request.id),
    ));
  };

// ========================================
// GET REQUEST BY ID
// ========================================

const getSeedlingRequestById =
  async (id, { includeIdentification = false, includeRequestLetter = false } = {}) => {
    const [doc, allRequestsSnapshot] = await Promise.all([
      db.collection(COLLECTION).doc(id).get(),
      db.collection(COLLECTION).get(),
    ]);

    if (!doc.exists) {
      throw new Error(
        "Seedling request not found."
      );
    }

    const [readableDoc] = await ensureReadableRequestDocuments(
      [doc],
      allRequestsSnapshot.docs
    );
    const request = {
      id:
        readableDoc.id,

      ...readableDoc.data(),
    };
    const distribution = request.status === "Approved"
      ? await db.collection("distributions").doc(id).get()
      : null;
    const result = withLegacyReleaseState(
      request,
      distribution?.exists ? { id: distribution.id, ...distribution.data() } : null
    );
    if (!includeIdentification) return stripSensitiveIdentification(result, { includePrivateDocument: includeRequestLetter });
    const identifications = await getMaskedIdentifications([id]);
    return withAdminIdentification(result, identifications.get(id));
  };

// ========================================
// GET BY STATUS
// ========================================

const getSeedlingRequestsByStatus =
  async (status, options = {}) => {
    const requests = await getAllSeedlingRequests(options);
    return requests.filter((request) => request.status === status);
  };

// ========================================
// PARTICIPANT REQUESTS
// ========================================

const getSeedlingRequestsByParticipantId =
  async (
    participantId
  ) => {
    const [snapshot, allRequestsSnapshot, distributions] = await Promise.all([
      db.collection(COLLECTION).where("participantId", "==", participantId).get(),
      db.collection(COLLECTION).get(),
      releasedDistributionMap(),
    ]);
    const readableDocs = await ensureReadableRequestDocuments(
      snapshot.docs,
      allRequestsSnapshot.docs
    );

    return readableDocs.map(
      (doc) => withLegacyReleaseState({
        id:
          doc.id,

        ...doc.data(),
      }, distributions.get(doc.id))
    ).map(stripSensitiveIdentification
    );
  };

// ========================================
// STAFF REVIEW
//
// Pending -> Reviewed
//
// No stock reservation yet.
// ========================================

const reviewSeedlingRequest =
  async (
    id,
    reviewData
  ) => {
    const docRef =
      db
        .collection(COLLECTION)
        .doc(id);
    const allRequestsSnapshot = await db.collection(COLLECTION).get();
    const targetDoc = await docRef.get();

    if (!targetDoc.exists) {
      throw new Error("Seedling request not found.");
    }

    const floors = getReadableSequenceFloors(allRequestsSnapshot.docs);
    await ensureReadableRequestMetadata(targetDoc, floors);
    const now = Timestamp.now();
    const reviewYear = getManilaYear(now);
    const reviewCounterRef = db.collection(COUNTERS_COLLECTION)
      .doc(`${REVIEW_COUNTER_DOCUMENT}_${reviewYear}`);
    const reviewSequenceFloor = floors.review.get(reviewYear) || 0;

    const reviewItems = normalizeRequestItems({ items: reviewData.items });

    validateItemStructure(reviewItems);

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);

      if (!doc.exists) {
        throw new Error("Seedling request not found.");
      }

      const currentRequest = doc.data();

      assertMutationVersion(currentRequest, reviewData.expectedVersion);

      if (currentRequest.status !== "Pending") {
        throw new Error("Only pending requests can be reviewed.");
      }

      const originalSchedule = currentRequest.originalSchedule || scheduleFromRequest(currentRequest);
      const coordinated = currentRequest.preApprovalSchedule;
      if (coordinated?.status === "AwaitingRequesterConfirmation") {
        const error = new Error("The requester must confirm the coordinated planting schedule before review can be completed.");
        error.code = "SCHEDULE_CONFIRMATION_REQUIRED";
        throw error;
      }
      const effectiveSchedule = coordinated?.status === "Confirmed"
        ? normalizeSchedule(coordinated, originalSchedule)
        : scheduleFromRequest(currentRequest);
      validateFuturePlantingSchedule(effectiveSchedule);

      const canonicalItems = [];

      // Verify inventory existence, not availableQuantity.
      for (const item of reviewItems) {
        const inventoryRef = db.collection(INVENTORY_COLLECTION).doc(item.inventoryId);
        const inventoryDoc = await transaction.get(inventoryRef);

        if (!inventoryDoc.exists || inventoryDoc.data().isDeleted === true) {
          throw new Error("One of the linked seedling inventory records was not found.");
        }

        const inventoryData = inventoryDoc.data();
        canonicalItems.push({
          inventoryId: inventoryDoc.id,
          species: cleanString(inventoryData.species),
          scientificName: cleanString(inventoryData.scientificName),
          category: cleanString(inventoryData.category),
          quantity: item.quantity,
        });
      }

      const totalQuantity = canonicalItems.reduce(
        (total, item) => total + item.quantity,
        0
      );
      const reviewCycle = (Array.isArray(currentRequest.reviewHistory)
        ? currentRequest.reviewHistory
        : []
      ).filter((entry) => entry?.action === "reviewed").length + 1;
      const reviewCounterDoc = await transaction.get(reviewCounterRef);
      const reviewSequence = Math.max(
        Number(reviewCounterDoc.exists
          ? reviewCounterDoc.data()?.lastNumber || 0
          : 0),
        Number(reviewSequenceFloor)
      ) + 1;

      if (!Number.isSafeInteger(reviewSequence) || reviewSequence <= 0) {
        throw new Error("Unable to generate the next review ID.");
      }

      const reviewId = `REV-${reviewYear}-${String(reviewSequence).padStart(3, "0")}`;
      const reviewedByName = cleanString(reviewData.reviewedByName) || "MENRO Staff";

      await createRoleNotificationsInTransaction(transaction, ["admin"], {
        notificationId: `request_reviewed_${id}_${reviewCycle}`,
        type: "request_reviewed",
        title: "Seedling Request Reviewed",
        message: `${currentRequest.requestNumber || id} has been reviewed by MENRO Staff and is ready for your final decision.`,
        relatedRecordType: "seedlingRequest",
        relatedRecordId: id,
        requestNumber: currentRequest.requestNumber || "",
        createdAt: now,
        details: {
          requesterName: currentRequest.participantName || "",
          reviewId,
          reviewedByName,
          reviewedAt: now,
        },
      });

      transaction.set(reviewCounterRef, {
        year: reviewYear,
        lastNumber: reviewSequence,
        updatedAt: now,
      }, { merge: true });
      transaction.update(docRef, {
        items: canonicalItems,
        totalQuantity,
        purpose: cleanString(reviewData.purpose),
        plantingLocation: cleanString(reviewData.plantingLocation),
        preferredReleaseDate: effectiveSchedule.preferredReleaseDate,
        eventProposal: {
          ...(currentRequest.eventProposal || {}),
          proposedDate: effectiveSchedule.plantingDate,
          proposedStartTime: effectiveSchedule.startTime,
          proposedEndTime: effectiveSchedule.endTime,
        },
        reviewedBy: reviewData.reviewedBy,
        reviewedByUid: reviewData.reviewedBy,
        reviewedByName,
        reviewId,
        reviewStatus: "Reviewed",
        reviewRemarks: "",
        reviewedAt: now,
        status: "Reviewed",
        requestVersion: requestVersion(currentRequest) + 1,
        updatedAt: now,
        reviewHistory: [
          ...(Array.isArray(currentRequest.reviewHistory)
            ? currentRequest.reviewHistory
            : []),
          {
            action: "reviewed",
            reviewId,
            actorId: reviewData.reviewedBy,
            actorName: reviewedByName,
            actorRole: "staff",
            at: now,
          },
        ],
      });
    });

    const updatedDoc =
      await docRef.get();

    return {
      id:
        updatedDoc.id,

      ...updatedDoc.data(),
    };
  };

// ========================================
// STAFF RETURN FOR REVISION
//
// Pending -> Returned
// No inventory or event mutation occurs here.
// ========================================

const returnSeedlingRequest = async (
  id,
  returnedBy,
  returnedByName,
  reason,
  expectedVersion
) => {
  const requestRef = db.collection(COLLECTION).doc(id);
  const returnReason = cleanString(reason);

  if (!returnReason) {
    throw new Error("Please provide a reason so the participant knows what needs to be corrected.");
  }

  await db.runTransaction(async (transaction) => {
    const requestDoc = await transaction.get(requestRef);

    if (!requestDoc.exists) {
      throw new Error("Seedling request not found.");
    }

    const request = requestDoc.data();
    assertMutationVersion(request, expectedVersion);
    if (request.status !== "Pending") {
      throw new Error("Only pending requests can be returned for revision.");
    }

    const now = Timestamp.now();
    const existingHistory = Array.isArray(request.reviewHistory)
      ? request.reviewHistory
      : [];
    const revisionNumber = existingHistory.filter(
      (entry) => entry?.action === "returned"
    ).length + 1;

    transaction.update(requestRef, {
      status: "Returned",
      returnReason,
      returnedBy,
      returnedByName: cleanString(returnedByName),
      returnedAt: now,
      updatedAt: now,
      requestVersion: requestVersion(request) + 1,
      reviewHistory: [
        ...existingHistory,
        {
          action: "returned",
          actorId: returnedBy,
          actorName: cleanString(returnedByName),
          actorRole: "staff",
          reason: returnReason,
          at: now,
        },
      ],
    });

    createNotificationInTransaction(transaction, {
      notificationId: `request_returned_${id}_${revisionNumber}`,
      recipientUserId: request.participantId,
      type: "request_returned",
      title: "Request Returned for Revision",
      message: `Your request ${request.requestNumber || id} was returned by MENRO Staff. Please review the reason, make the necessary corrections, and resubmit your request.`,
      relatedRecordType: "seedlingRequest",
      relatedRecordId: id,
      requestNumber: request.requestNumber || "",
      reason: returnReason,
      returnedAt: now,
      details: {
        returnedAt: now,
        returnedByName: cleanString(returnedByName),
      },
      createdAt: now,
    });
  });

  const updatedDoc = await requestRef.get();
  return { id: updatedDoc.id, ...updatedDoc.data() };
};

// ========================================
// PARTICIPANT RESUBMISSION
//
// Returned -> Pending on the same request document.
// No inventory or event mutation occurs here.
// ========================================

const resubmitSeedlingRequest = async (id, participantId, data) => {
  if (
    data?.workflow?.siteMode === "proposed" &&
    cleanString(data.workflow.niyogan || data.workflow.niyoganStatus).toLowerCase() === "yes"
  ) {
    throw new Error(
      "Planting Location Not Eligible. The proposed planting area is identified as a coconut farm (Niyogan). Please provide another planting location to continue."
    );
  }
  const requestRef = db.collection(COLLECTION).doc(id);
  const submittedItems = normalizeRequestItems(data);
  validateItemStructure(submittedItems);

  await db.runTransaction(async (transaction) => {
    const requestDoc = await transaction.get(requestRef);

    if (!requestDoc.exists) {
      throw new Error("Seedling request not found.");
    }

    const request = requestDoc.data();
    assertMutationVersion(request, data.expectedVersion);

    if (request.participantId !== participantId) {
      throw new Error("You can only edit your own returned request.");
    }

    if (request.status !== "Returned") {
      throw new Error("This request can no longer be edited because its status has changed.");
    }

    const canonicalItems = [];
    for (const item of submittedItems) {
      const inventoryRef = db.collection(INVENTORY_COLLECTION).doc(item.inventoryId);
      const inventoryDoc = await transaction.get(inventoryRef);

      if (!inventoryDoc.exists || inventoryDoc.data().isDeleted === true) {
        throw new Error("One of the selected seedling inventory records was not found.");
      }

      const inventory = inventoryDoc.data();
      canonicalItems.push({
        inventoryId: inventoryDoc.id,
        species: cleanString(inventory.species),
        scientificName: cleanString(inventory.scientificName),
        category: cleanString(inventory.category),
        quantity: item.quantity,
      });
    }

    const proposal = data.eventProposal || {};
    const isProposedSite = data.workflow?.siteMode === "proposed";
    const siteRef = isProposedSite ? null : db.collection(SITES_COLLECTION).doc(
      cleanString(proposal.plantingSiteId)
    );
    const siteDoc = siteRef ? await transaction.get(siteRef) : null;

    if (siteDoc && !siteDoc.exists) {
      throw new Error("Planting site not found.");
    }

    const site = siteDoc?.data() || null;
    if (site && cleanString(site.status || "active").toLowerCase() !== "active") {
      throw new Error("Selected planting site is archived.");
    }

    if (site && normalizeBarangay(site.barangay) !== normalizeBarangay(proposal.barangay)) {
      throw new Error("Selected planting site does not belong to the event barangay.");
    }

    const capacity = Number(site?.maximumCapacity || 0);
    const planted = Number(site?.planted || 0);
    if (capacity > 0 && Math.round((planted / capacity) * 100) >= 90) {
      throw new Error("Selected planting site is already full.");
    }

    const now = Timestamp.now();
    const totalQuantity = canonicalItems.reduce(
      (total, item) => total + item.quantity,
      0
    );
    const nextVersion = requestVersion(request) + 1;
    const staffRecipients = await getRoleRecipientsInTransaction(transaction, ["staff"]);
    const replacementDocument = data.requestLetter?.privateDocument;
    const legacyMetadata = request.workflow?.requestLetter && typeof request.workflow.requestLetter === "object"
      ? request.workflow.requestLetter
      : null;
    const nextWorkflow = data.workflow && typeof data.workflow === "object" ? { ...data.workflow } : {};
    if (!replacementDocument && legacyMetadata) nextWorkflow.requestLetter = legacyMetadata;
    if (replacementDocument) nextWorkflow.requestLetter = null;
    if (replacementDocument) {
      await require("./requestLetterStorage.service").linkRequestLetterInTransaction(
        transaction, replacementDocument, id, participantId,
      );
    }

    transaction.update(requestRef, {
      items: canonicalItems,
      totalQuantity,
      purpose: cleanString(data.purpose),
      plantingLocation: cleanString(data.plantingLocation),
      preferredReleaseDate: data.preferredReleaseDate,
      workflow: nextWorkflow,
      ...(replacementDocument ? {
        requestLetterHistory: [
          ...(Array.isArray(request.requestLetterHistory) ? request.requestLetterHistory : []),
          ...(request.requestLetter?.privateDocument ? [{ ...request.requestLetter, supersededAt: now }] : []),
          ...(!request.requestLetter?.privateDocument && legacyMetadata
            ? [{ legacyMetadata, supersededAt: now }]
            : []),
        ],
        requestLetter: data.requestLetter,
      } : {}),
      eventProposal: {
        eventName: cleanString(proposal.eventName),
        barangay: cleanString(proposal.barangay),
        plantingSiteId: siteDoc?.id || "PROPOSED",
        plantingSiteName: site ? cleanString(site.siteName || site.name) : cleanString(data.workflow?.siteName),
        proposedDate: proposal.proposedDate,
        proposedStartTime: proposal.proposedStartTime,
        proposedEndTime: proposal.proposedEndTime,
        eventLocation: cleanString(data.plantingLocation),
        latitude: Number(site?.latitude ?? proposal.latitude),
        longitude: Number(site?.longitude ?? proposal.longitude),
        expectedParticipants: Number(proposal.expectedParticipants),
        description: cleanString(proposal.description),
        status: "Proposed",
      },
      status: "Pending",
      requestVersion: nextVersion,
      resubmissionProcessingEstimate: buildProcessingEstimate(now.toDate()),
      returnReason: "",
      returnedBy: "",
      returnedByName: "",
      returnedAt: null,
      reviewId: "",
      reviewStatus: "",
      reviewedBy: "",
      reviewedByUid: "",
      reviewedByName: "",
      reviewedAt: null,
      reviewRemarks: "",
      resubmittedAt: now,
      updatedAt: now,
      reviewHistory: [
        ...(Array.isArray(request.reviewHistory) ? request.reviewHistory : []),
        {
          action: "resubmitted",
          actorId: participantId,
          actorName: cleanString(request.participantName),
          actorRole: "participant",
          at: now,
        },
      ],
    });
    staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
      notificationId: `request_resubmitted_staff_${id}_${nextVersion}_${recipient.id}`,
      recipientUserId: recipient.id,
      type: "request_resubmitted_staff",
      title: "Seedling Request Resubmitted",
      message: `${request.requestNumber || id} was corrected and resubmitted for Staff review.`,
      relatedRecordType: "seedlingRequest",
      relatedRecordId: id,
      requestNumber: request.requestNumber || "",
      createdAt: now,
      details: { status: "Pending", requestVersion: nextVersion, resubmittedAt: now },
    }));
  });

  const updatedDoc = await requestRef.get();
  return { id: updatedDoc.id, ...updatedDoc.data() };
};

const proposePreApprovalSchedule = async (id, staff, data = {}) => {
  const requestRef = db.collection(COLLECTION).doc(id);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(requestRef);
    if (!doc.exists) throw new Error("Seedling request not found.");
    const request = doc.data();
    assertMutationVersion(request, data.expectedVersion);
    if (request.status !== "Pending") throw new Error("Only pending requests can have a coordinated schedule.");

    const original = request.originalSchedule || scheduleFromRequest(request);
    const schedule = validateFuturePlantingSchedule(normalizeSchedule(data, original));
    if (schedule.preferredReleaseDate < manilaDateOnly()) {
      throw new Error("Replacement release and planting dates must not be in the past.");
    }
    const changed = JSON.stringify(schedule) !== JSON.stringify(original);
    const plantingChanged = !samePlantingSchedule(schedule, original);
    const reason = cleanString(data.adjustmentReason);
    if (changed && !reason) throw new Error("An adjustment reason is required when the schedule changes.");

    const now = Timestamp.now();
    const proposalVersion = Number(request.preApprovalSchedule?.proposalVersion || 0) + 1;
    const nextVersion = requestVersion(request) + 1;
    const status = plantingChanged ? "AwaitingRequesterConfirmation" : "Confirmed";
    transaction.update(requestRef, {
      originalSchedule: original,
      preApprovalSchedule: {
        ...schedule,
        status,
        proposalVersion,
        adjustmentReason: reason,
        proposedBy: staff.uid,
        proposedByName: cleanString(staff.name),
        proposedAt: now,
        confirmedBy: plantingChanged ? "" : request.participantId,
        confirmedAt: plantingChanged ? null : now,
      },
      requestVersion: nextVersion,
      updatedAt: now,
      scheduleHistory: [
        ...(Array.isArray(request.scheduleHistory) ? request.scheduleHistory : []),
        { action: "pre_approval_schedule_proposed", actorId: staff.uid, actorRole: "staff", fromSchedule: original, toSchedule: schedule, reason, requestVersion: nextVersion, at: now },
      ],
    });
    if (plantingChanged) createNotificationInTransaction(transaction, {
      notificationId: `request_schedule_confirmation_${id}_${proposalVersion}`,
      recipientUserId: request.participantId,
      type: "request_schedule_confirmation_required",
      title: "Planting Schedule Confirmation Required",
      message: `${request.requestNumber || id} has a coordinated planting schedule that requires your confirmation before Staff review can be completed.`,
      relatedRecordType: "seedlingRequest",
      relatedRecordId: id,
      requestNumber: request.requestNumber || "",
      details: { proposalVersion, schedule },
      createdAt: now,
    });
  });
  const updated = await requestRef.get();
  return { id: updated.id, ...updated.data() };
};

const confirmPreApprovalSchedule = async (id, participantId, data = {}) => {
  const requestRef = db.collection(COLLECTION).doc(id);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(requestRef);
    if (!doc.exists) throw new Error("Seedling request not found.");
    const request = doc.data();
    assertMutationVersion(request, data.expectedVersion);
    if (request.participantId !== participantId) throw new Error("You can only confirm your own request schedule.");
    if (request.status !== "Pending" || request.preApprovalSchedule?.status !== "AwaitingRequesterConfirmation") {
      throw new Error("This schedule is no longer awaiting confirmation.");
    }
    if (Number(data.proposalVersion) !== Number(request.preApprovalSchedule.proposalVersion)) {
      const error = new Error("The coordinated schedule changed. Refresh and review the latest proposal.");
      error.code = "STALE_REQUEST_VERSION";
      throw error;
    }
    const proposed = normalizeSchedule(request.preApprovalSchedule);
    const schedule = validateFuturePlantingSchedule(normalizeSchedule(data, proposed));
    if (schedule.preferredReleaseDate < manilaDateOnly()) {
      throw new Error("The confirmed schedule must not be in the past.");
    }
    const now = Timestamp.now();
    const nextVersion = requestVersion(request) + 1;
    const staffRecipients = await getRoleRecipientsInTransaction(transaction, ["staff"]);
    transaction.update(requestRef, {
      preApprovalSchedule: { ...request.preApprovalSchedule, ...schedule, status: "Confirmed", confirmedBy: participantId, confirmedAt: now },
      requestVersion: nextVersion,
      updatedAt: now,
      scheduleHistory: [
        ...(Array.isArray(request.scheduleHistory) ? request.scheduleHistory : []),
        { action: "pre_approval_schedule_confirmed", actorId: participantId, actorRole: "participant", toSchedule: schedule, requestVersion: nextVersion, at: now },
      ],
    });
    staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
      notificationId: `request_schedule_confirmed_${id}_${request.preApprovalSchedule.proposalVersion}_${recipient.id}`,
      recipientUserId: recipient.id, type: "request_schedule_confirmed", title: "Planting Schedule Confirmed",
      message: `${request.requestNumber || id} has a requester-confirmed planting schedule and is ready for Staff review.`,
      relatedRecordType: "seedlingRequest", relatedRecordId: id, requestNumber: request.requestNumber || "", createdAt: now,
    }));
  });
  const updated = await requestRef.get();
  return { id: updated.id, ...updated.data() };
};

// ========================================
// ADMIN FINAL APPROVAL
//
// Reviewed -> Approved
//
// Approval authorizes and schedules the request. Inventory remains unchanged
// until staff records the physical sapling release.
// ========================================

const approveSeedlingRequest =
  async (
    id,
    approvedBy,
    reason,
    expectedVersion
  ) => {
    const adminUid = cleanString(approvedBy);
    if (!adminUid) {
      throw new Error("An authenticated administrator is required to approve this request.");
    }

    const requestRef =
      db
        .collection(COLLECTION)
        .doc(id);

    // A proposed location remains request-owned until final Admin approval.
    // Register it through the existing site service immediately before the
    // approval transaction, then link the request/event to the real site ID.
    const approvalSnapshot = await requestRef.get();
    if (approvalSnapshot.exists) {
      const approvalRequest = approvalSnapshot.data();
      assertMutationVersion(approvalRequest, expectedVersion);
      const alreadyApproved = approvalRequest.status === "Approved" && approvalRequest.eventId && approvalRequest.eventCreated === true;
      if (approvalRequest.status !== "Reviewed" && !alreadyApproved) {
        throw new Error("Only reviewed requests can be approved.");
      }
      const workflow = approvalRequest.workflow || {};
      if (workflow.siteMode === "proposed" && !workflow.officialSiteId) {
        const areaLabels = {
          "Less than 1 hectare": 0.5,
          "1 hectare": 1,
          "2 hectares": 2,
          "3 hectares": 3,
          "4 hectares": 4,
          "5 hectares": 5,
          "6–10 hectares": 8,
          "More than 10 hectares": 11,
        };
        const areaHectares = workflow.areaChoice === "Other / Exact Area"
          ? Number(workflow.exactArea)
          : Number(areaLabels[workflow.areaChoice] || 1);
        const site = await siteService.createSite({
          siteName: workflow.siteName,
          barangay: workflow.siteBarangay,
          siteType: workflow.landType || "Participant Proposed Site",
          locationDescription: workflow.specificLocation,
          areaHectares,
          maximumCapacity: Math.max(1, Math.ceil(areaHectares * 1000)),
          latitude: workflow.latitude,
          longitude: workflow.longitude,
          coverageRadiusMeters: 100,
          description: workflow.siteNotes,
          createdBy: adminUid,
          sourceRequestId: id,
        });
        await requestRef.update({
          "workflow.officialSiteId": site.id,
          "workflow.officialSiteNumber": site.siteId,
          "eventProposal.plantingSiteId": site.id,
          updatedAt: Timestamp.now(),
        });
      }
    }

    await db.runTransaction(
      async (transaction) => {
        // ========================================
        // REQUEST
        // ========================================

        const requestDoc =
          await transaction.get(
            requestRef
          );

        if (
          !requestDoc.exists
        ) {
          throw new Error(
            "Seedling request not found."
          );
        }

        const currentRequest =
          requestDoc.data();

        assertMutationVersion(currentRequest, expectedVersion);

        if (
          currentRequest.status === "Approved" &&
          currentRequest.eventId &&
          currentRequest.eventCreated === true
        ) {
          return;
        }
        const approvalSchedule = currentRequest.preApprovalSchedule?.status === "Confirmed"
          ? normalizeSchedule(currentRequest.preApprovalSchedule)
          : scheduleFromRequest(currentRequest);
        validateFuturePlantingSchedule(approvalSchedule);

        if (
          currentRequest.status !==
          "Reviewed"
        ) {
          throw new Error(
            "Only reviewed requests can be approved."
          );
        }

        if (
          currentRequest
            .inventoryReserved ===
          true ||
          currentRequest
            .inventoryDeducted ===
          true
        ) {
          throw new Error(
            "Inventory has already been reserved for this request."
          );
        }

        if (
          currentRequest
            .eventCreated ===
            true ||
          currentRequest.eventId
        ) {
          throw new Error(
            "A planting event has already been created for this request."
          );
        }

        // Use approvedItems for release when present; otherwise fall back to request items.
        const requestItems =
          Array.isArray(currentRequest.approvedItems) && currentRequest.approvedItems.length > 0
            ? currentRequest.approvedItems
            : normalizeRequestItems(currentRequest);

        validateItemStructure(requestItems);

        // ========================================
        // READ ALL INVENTORY FIRST
        //
        // Firestore transactions require reads
        // before writes.
        // ========================================

        const inventoryRecords = [];

        // Re-read and validate authoritative stock inside the approval transaction.
        for (const item of requestItems) {
          const inventoryRef = db.collection(INVENTORY_COLLECTION).doc(item.inventoryId);

          const inventoryDoc = await transaction.get(inventoryRef);

          if (!inventoryDoc.exists || inventoryDoc.data().isDeleted === true) {
            throw new Error(
              `Linked seedling inventory for ${item.species || "a requested item"} was not found.`
            );
          }

          const inventoryData = inventoryDoc.data();

          const requestedQty = Number(item.quantity || 0);

          const approvedQuantity = requestedQty;

          if (!Number.isInteger(approvedQuantity) || approvedQuantity <= 0) {
            throw new Error(`Invalid approved seedling quantity for ${cleanString(inventoryData.species) || "a requested item"}.`);
          }

          const availableQuantity = Number(inventoryData.currentQuantity ?? inventoryData.availableQuantity ?? 0);
          if (approvedQuantity > availableQuantity) {
            throw new Error(
              `Insufficient available seedling stock for ${cleanString(inventoryData.species) || item.species || "the requested item"}. Please review the approved quantity.`
            );
          }

          inventoryRecords.push({ item, inventoryRef, inventoryData, approvedQuantity });
        }

        // ========================================
        // EVENT PROPOSAL
        // ========================================

        const proposal =
          currentRequest
            .eventProposal ||
          {};

        const plantingSiteId =
          cleanString(
            proposal.plantingSiteId
          );

        const barangay =
          cleanString(
            proposal.barangay
          );

        if (!plantingSiteId) {
          throw new Error(
            "The request has no linked planting site."
          );
        }

        if (!barangay) {
          throw new Error(
            "The request has no event barangay."
          );
        }

        // ========================================
        // PLANTING SITE
        // ========================================

        const siteRef =
          db
            .collection(
              SITES_COLLECTION
            )
            .doc(
              plantingSiteId
            );

        const siteDoc =
          await transaction.get(
            siteRef
          );

        if (!siteDoc.exists) {
          throw new Error(
            "Planting site not found."
          );
        }

        const siteData =
          siteDoc.data();

        if (
          cleanString(
            siteData.status
          ).toLowerCase() !==
          "active"
        ) {
          throw new Error(
            "Selected planting site is not active."
          );
        }

        // Ensure site is not already full at approval time.
        const planted = Number(siteData.planted || 0);
        const maximumCapacity = Number(siteData.maximumCapacity || 0);

        let utilizationPercentage = 0;
        if (maximumCapacity > 0) {
          utilizationPercentage = Math.round(
            (planted / maximumCapacity) * 100
          );
        }

        if (utilizationPercentage >= 90) {
          throw new Error("Selected planting site is already full.");
        }

        if (
          normalizeBarangay(
            siteData.barangay
          ) !==
          normalizeBarangay(
            barangay
          )
        ) {
          throw new Error(
            "Selected planting site does not belong to the event barangay."
          );
        }

        const roleRecipients = await getRoleRecipientsInTransaction(
          transaction,
          ["staff"]
        );
        const staffRecipients = roleRecipients.filter((user) => user.role === "staff");

        const now =
          Timestamp.now();

        // ========================================
        // CREATE TREE PLANTING EVENT
        //
        // Approval means Authorized + Scheduled.
        // ========================================

        // Build approvedItems for event creation: use approved quantities from inventoryRecords.
        const approvedItems = inventoryRecords.map((rec) => ({
          inventoryId: rec.item.inventoryId,
          species: rec.item.species,
          scientificName: rec.item.scientificName,
          category: rec.item.category,
          quantity: rec.approvedQuantity,
        }));

        const eventRequestData = {
          ...currentRequest,
          // For event allocation use approvedItems (what MENRO will actually provide)
          items: approvedItems,
          totalQuantity: approvedItems.reduce((total, item) => total + Number(item.quantity || 0), 0),
        };

        const {
          eventId,
          eventData,
        } =
          await createTreePlantingEventInTransaction(
            transaction,
            {
              requestId:
                id,

              requestData:
                eventRequestData,

              // Keep this for compatibility with
              // the current event service.
              // For multiple items, first item is
              // supplied as legacy inventoryData.
              inventoryData:
                inventoryRecords[0]
                  .inventoryData,

              approvedBy: adminUid,

              approvedAt:
                now,

              siteData,
            }
          );

        const guestInvitationCreated = Number(proposal.expectedParticipants || 0) > 0
          ? createInvitationInTransaction(transaction, eventId, id, now)
          : false;

        // ========================================
        // ========================================
        // UPDATE REQUEST
        // ========================================

        // Store approvedItems on the request for later release and auditing.
        transaction.update(requestRef, {
          status: "Approved",
          approvedBy: adminUid,
          approvedAt: now,
          decisionBy: adminUid,
          decisionAt: now,
          eventId,
          eventCreated: true,
          guestInvitationCreated,
          inventoryDeducted: false,
          inventoryReserved: false,
          approvedItems,
          approvedSchedule: { ...approvalSchedule, confirmedByAdmin: adminUid, confirmedAt: now },
          requestVersion: requestVersion(currentRequest) + 1,
          updatedAt: now,
        });

        createNotificationInTransaction(transaction, {
          notificationId: `request_approved_${id}_${currentRequest.participantId}`,
          recipientUserId: currentRequest.participantId,
          type: "request_approved",
          title: "Seedling Request Approved",
          message: `Your seedling request ${currentRequest.requestNumber || id} has been approved. ${eventData.name} is scheduled for ${eventData.date} ${eventData.startTime}${eventData.endTime ? `-${eventData.endTime}` : ""} at ${eventData.plantingSiteName || eventData.location || eventData.barangay}. Please wait for release updates.`,
          relatedRecordType: "seedlingRequest",
          relatedRecordId: id,
          requestNumber: currentRequest.requestNumber || "",
          relatedEventId: eventId,
          createdAt: now,
          details: {
            approvedAt: now,
            schedule: {
              date: eventData.date,
              startTime: eventData.startTime,
              endTime: eventData.endTime,
            },
          },
        });

        staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
          notificationId: `request_approved_staff_${id}_${recipient.id}`,
          recipientUserId: recipient.id,
          type: "request_approved_staff",
          title: "Seedling Request Approved",
          message: `${currentRequest.requestNumber || id} has been approved by the MENRO Administrator. ${eventData.name} is scheduled for ${eventData.date} ${eventData.startTime}${eventData.endTime ? `-${eventData.endTime}` : ""} at ${eventData.plantingSiteName || eventData.location || eventData.barangay}, and the request is ready for seedling release.`,
          relatedRecordType: "seedlingRequest",
          relatedRecordId: id,
          requestNumber: currentRequest.requestNumber || "",
          relatedEventId: eventId,
          createdAt: now,
          details: {
            requesterName: currentRequest.participantName || "",
            approvedAt: now,
            schedule: {
              date: eventData.date,
              startTime: eventData.startTime,
              endTime: eventData.endTime,
            },
          },
        }));

        // The requester and Staff already receive the equivalent approval notification
        // above. Only the Admin creator needs the separate Event Calendar notice.
        writeNotifications(transaction, {
          eventId,
          event: eventData,
          recipientIds: [adminUid],
          kind: "scheduled",
        });
      }
    );

    const updatedDoc =
      await requestRef.get();

    return {
      id:
        updatedDoc.id,

      ...updatedDoc.data(),
    };
  };

// ========================================
// ADMIN REJECTION
//
// Reviewed -> Rejected
// ========================================

const rejectSeedlingRequest =
  async (
    id,
    rejectedBy,
    reason,
    expectedVersion
  ) => {
    const adminUid = cleanString(rejectedBy);
    if (!adminUid) {
      throw new Error("An authenticated administrator is required to reject this request.");
    }

    const rejectionReason = cleanString(reason);
    if (!rejectionReason) {
      throw new Error("A rejection reason is required.");
    }

    const docRef =
      db
        .collection(COLLECTION)
        .doc(id);

    await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);

    if (!doc.exists) {
      throw new Error(
        "Seedling request not found."
      );
    }

    const currentRequest =
      doc.data();

    assertMutationVersion(currentRequest, expectedVersion);

    if (
      currentRequest.status !==
      "Reviewed"
    ) {
      throw new Error(
        "Only reviewed requests can be rejected."
      );
    }

    const now =
      Timestamp.now();

    const staffRecipients = await getRoleRecipientsInTransaction(transaction, ["staff"]);

    transaction.update(docRef, {
      status:
        "Rejected",

      rejectedBy: adminUid,

      rejectedAt:
        now,

      decisionReason:
        rejectionReason,

      decisionBy:
        adminUid,

      decisionAt:
        now,

      requestVersion: requestVersion(currentRequest) + 1,

      updatedAt:
        now,
    });
    createNotificationInTransaction(transaction, {
      notificationId: `request_rejected_${id}_${currentRequest.participantId}`,
      recipientUserId: currentRequest.participantId,
      type: "request_rejected",
      title: "Seedling Request Rejected",
      message: `Your seedling request ${currentRequest.requestNumber || id} was rejected by the MENRO Administrator.`,
      relatedRecordType: "seedlingRequest",
      relatedRecordId: id,
      requestNumber: currentRequest.requestNumber || "",
      reason: rejectionReason,
      details: { rejectedAt: now },
      createdAt: now,
    });

    staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
      notificationId: `request_rejected_staff_${id}_${recipient.id}`,
      recipientUserId: recipient.id,
      type: "request_rejected_staff",
      title: "Seedling Request Rejected",
      message: `${currentRequest.requestNumber || id} was rejected by the MENRO Administrator and must not proceed to seedling release.`,
      relatedRecordType: "seedlingRequest",
      relatedRecordId: id,
      requestNumber: currentRequest.requestNumber || "",
      reason: rejectionReason,
      details: {
        requesterName: currentRequest.participantName || "",
        rejectedAt: now,
      },
      createdAt: now,
    }));
    });

    const updatedDoc =
      await docRef.get();

    return {
      id:
        updatedDoc.id,

      ...updatedDoc.data(),
    };
  };

const assertEventHasNoPlantingActivity = async (transaction, eventRef, event, requestId) => {
  const status = cleanString(event.status).toLowerCase();
  const recordStatus = cleanString(event.recordStatus).toLowerCase();
  const counters = [event.recordedSeedlingQuantity, event.actualTreesPlanted, event.treesPlanted]
    .some((value) => Number(value || 0) > 0);
  if (["completed", "ongoing", "in progress", "in-progress"].includes(status) ||
      ["completed", "active", "in_progress"].includes(recordStatus) || counters) {
    const error = new Error("The linked event already has planting activity and can no longer be rescheduled.");
    error.code = "EVENT_ALREADY_HAS_PLANTING_ACTIVITY";
    throw error;
  }
  const reportQuery = db.collection("plantingReports").where("eventId", "==", eventRef.id);
  const contributionQuery = db.collection("plantingContributions").where("eventId", "==", eventRef.id).limit(1);
  const parentRef = db.collection("plantingReports").doc(`event_${eventRef.id}`);
  const [reports, contributions, parent] = await Promise.all([
    transaction.get(reportQuery), transaction.get(contributionQuery), transaction.get(parentRef),
  ]);
  const parentData = parent.exists ? parent.data() : {};
  const hasSubmittedReport = reports.docs.some((doc) => {
    const report = doc.data();
    return report.reportType !== "parent" || Boolean(report.submittedAt || report.verifiedAt) ||
      Number(report.activeSubmittedQuantity || report.quantityPlanted || 0) > 0;
  });
  if (hasSubmittedReport || !contributions.empty || Number(parentData.activeSubmittedQuantity || parentData.quantityPlanted || 0) > 0) {
    const error = new Error("The linked event already has planting activity and can no longer be rescheduled.");
    error.code = "EVENT_ALREADY_HAS_PLANTING_ACTIVITY";
    throw error;
  }
  if (event.sourceRequestId !== requestId) throw new Error("Linked planting event does not belong to this request.");
};

const recordLateReleaseConflict = async (id, staff, data = {}) => {
  const requestRef = db.collection(COLLECTION).doc(id);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(requestRef);
    if (!doc.exists) throw new Error("Seedling request not found.");
    const request = doc.data();
    assertMutationVersion(request, data.expectedVersion);
    if (request.status !== "Approved" || request.inventoryReleased === true) throw new Error("Only approved, unreleased requests can enter late-release rescheduling.");
    if (["AwaitingRequester", "PendingStaffReview", "ReturnedForRevision"].includes(request.lateReleaseRescheduling?.status)) {
      throw new Error("Resolve the existing late-release rescheduling request before starting another one.");
    }
    if (!request.eventId) throw new Error("Approved request has no linked event.");
    const eventRef = db.collection("events").doc(request.eventId);
    const eventDoc = await transaction.get(eventRef);
    if (!eventDoc.exists || eventDoc.data().sourceRequestId !== id) throw new Error("Linked planting event not found.");
    const availableReleaseDate = cleanString(data.availableReleaseDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(availableReleaseDate) || availableReleaseDate < manilaDateOnly()) {
      throw new Error("Available release date must be a valid date that is not in the past.");
    }
    if (availableReleaseDate <= eventDoc.data().date) {
      const error = new Error("The available release date does not create a late-release conflict.");
      error.code = "NO_LATE_RELEASE_CONFLICT";
      throw error;
    }
    const reason = cleanString(data.reason);
    if (!reason) throw new Error("A delay reason is required.");
    const now = Timestamp.now();
    const version = Number(request.lateReleaseRescheduling?.version || 0) + 1;
    const nextVersion = requestVersion(request) + 1;
    transaction.update(requestRef, {
      lateReleaseRescheduling: {
        status: "AwaitingRequester",
        version,
        availableReleaseDate,
        conflictReason: reason,
        initiatedBy: staff.uid,
        initiatedByName: cleanString(staff.name),
        initiatedAt: now,
        linkedEventId: eventRef.id,
        originalEventSchedule: { date: eventDoc.data().date, startTime: eventDoc.data().startTime || "", endTime: eventDoc.data().endTime || "" },
      },
      requestVersion: nextVersion,
      updatedAt: now,
      scheduleHistory: [...(Array.isArray(request.scheduleHistory) ? request.scheduleHistory : []),
        { action: "late_release_conflict_recorded", actorId: staff.uid, actorRole: "staff", availableReleaseDate, reason, requestVersion: nextVersion, at: now }],
    });
    createNotificationInTransaction(transaction, {
      notificationId: `late_release_conflict_${id}_${version}`,
      recipientUserId: request.participantId,
      type: "late_release_conflict",
      title: "New Planting Date Required",
      message: `${request.requestNumber || id} cannot follow its approved planting schedule because seedlings will be available later. Please submit a replacement planting date.`,
      relatedRecordType: "seedlingRequest", relatedRecordId: id, requestNumber: request.requestNumber || "",
      details: { availableReleaseDate, conflictReason: reason, reschedulingVersion: version }, createdAt: now,
    });
  });
  const updated = await requestRef.get(); return { id: updated.id, ...updated.data() };
};

const proposeLateReleaseSchedule = async (id, participantId, data = {}) => {
  const requestRef = db.collection(COLLECTION).doc(id);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(requestRef); if (!doc.exists) throw new Error("Seedling request not found.");
    const request = doc.data(); assertMutationVersion(request, data.expectedVersion);
    if (request.participantId !== participantId) throw new Error("You can only update your own request.");
    const state = request.lateReleaseRescheduling || {};
    if (request.status !== "Approved" || !["AwaitingRequester", "ReturnedForRevision"].includes(state.status)) throw new Error("This request is not awaiting a replacement planting schedule.");
    if (Number(data.reschedulingVersion) !== Number(state.version)) { const error = new Error("The rescheduling request changed. Refresh and try again."); error.code = "STALE_REQUEST_VERSION"; throw error; }
    const proposal = normalizeSchedule(data, { preferredReleaseDate: state.availableReleaseDate });
    proposal.preferredReleaseDate = state.availableReleaseDate;
    validateFuturePlantingSchedule(proposal);
    const now = Timestamp.now(); const proposalVersion = Number(state.requesterProposal?.proposalVersion || 0) + 1; const nextVersion = requestVersion(request) + 1;
    const staffRecipients = await getRoleRecipientsInTransaction(transaction, ["staff"]);
    transaction.update(requestRef, {
      lateReleaseRescheduling: { ...state, status: "PendingStaffReview", requesterProposal: { plantingDate: proposal.plantingDate, startTime: proposal.startTime, endTime: proposal.endTime, remarks: cleanString(data.remarks), submittedBy: participantId, submittedAt: now, proposalVersion } },
      requestVersion: nextVersion, updatedAt: now,
      scheduleHistory: [...(Array.isArray(request.scheduleHistory) ? request.scheduleHistory : []), { action: "late_release_schedule_proposed", actorId: participantId, actorRole: "participant", toSchedule: proposal, requestVersion: nextVersion, at: now }],
    });
    staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, { notificationId: `late_release_proposal_${id}_${proposalVersion}_${recipient.id}`, recipientUserId: recipient.id, type: "late_release_proposal_submitted", title: "Replacement Planting Schedule Submitted", message: `${request.requestNumber || id} has a replacement planting schedule ready for Staff review.`, relatedRecordType: "seedlingRequest", relatedRecordId: id, requestNumber: request.requestNumber || "", createdAt: now }));
  });
  const updated = await requestRef.get(); return { id: updated.id, ...updated.data() };
};

const decideLateReleaseSchedule = async (id, staff, data = {}, approve = false) => {
  const requestRef = db.collection(COLLECTION).doc(id);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(requestRef); if (!doc.exists) throw new Error("Seedling request not found.");
    const request = doc.data(); assertMutationVersion(request, data.expectedVersion);
    const state = request.lateReleaseRescheduling || {};
    if (request.status !== "Approved" || request.inventoryReleased === true || state.status !== "PendingStaffReview") throw new Error("This replacement schedule is no longer awaiting Staff review.");
    if (Number(data.reschedulingVersion) !== Number(state.version) || Number(data.proposalVersion) !== Number(state.requesterProposal?.proposalVersion)) { const error = new Error("The replacement schedule changed. Refresh and try again."); error.code = "STALE_REQUEST_VERSION"; throw error; }
    const now = Timestamp.now(); const nextVersion = requestVersion(request) + 1;
    if (!approve) {
      const reason = cleanString(data.reason); if (!reason) throw new Error("A return reason is required.");
      transaction.update(requestRef, { lateReleaseRescheduling: { ...state, status: "ReturnedForRevision", staffDecision: { decision: "Returned", reason, decidedBy: staff.uid, decidedAt: now } }, requestVersion: nextVersion, updatedAt: now, scheduleHistory: [...(Array.isArray(request.scheduleHistory) ? request.scheduleHistory : []), { action: "late_release_schedule_returned", actorId: staff.uid, actorRole: "staff", reason, requestVersion: nextVersion, at: now }] });
      createNotificationInTransaction(transaction, { notificationId: `late_release_returned_${id}_${state.requesterProposal.proposalVersion}`, recipientUserId: request.participantId, type: "late_release_schedule_returned", title: "Replacement Schedule Returned", message: `Your replacement planting schedule for ${request.requestNumber || id} needs revision.`, relatedRecordType: "seedlingRequest", relatedRecordId: id, requestNumber: request.requestNumber || "", reason, createdAt: now });
      return;
    }
    const eventRef = db.collection("events").doc(request.eventId); const eventDoc = await transaction.get(eventRef);
    if (!eventDoc.exists) throw new Error("Linked planting event not found.");
    const event = eventDoc.data(); await assertEventHasNoPlantingActivity(transaction, eventRef, event, id);
    const proposal = state.requesterProposal;
    validateFuturePlantingSchedule({ preferredReleaseDate: state.availableReleaseDate, plantingDate: proposal.plantingDate, startTime: proposal.startTime, endTime: proposal.endTime });
    const eventRecipients = await activeRegisteredRecipients(transaction, eventRef.id, event);
    transaction.update(eventRef, { date: proposal.plantingDate, startTime: proposal.startTime, endTime: proposal.endTime, updatedAt: now });
    transaction.update(requestRef, { lateReleaseRescheduling: { ...state, status: "Approved", staffDecision: { decision: "Approved", reason: "", decidedBy: staff.uid, decidedAt: now }, updatedEventSchedule: { date: proposal.plantingDate, startTime: proposal.startTime, endTime: proposal.endTime } }, requestVersion: nextVersion, updatedAt: now, scheduleHistory: [...(Array.isArray(request.scheduleHistory) ? request.scheduleHistory : []), { action: "late_release_schedule_approved", actorId: staff.uid, actorRole: "staff", fromSchedule: state.originalEventSchedule, toSchedule: proposal, requestVersion: nextVersion, at: now }] });
    createNotificationInTransaction(transaction, { notificationId: `late_release_approved_${id}_${proposal.proposalVersion}`, recipientUserId: request.participantId, type: "late_release_schedule_approved", title: "Replacement Planting Schedule Approved", message: `The replacement planting schedule for ${request.requestNumber || id} was approved and its Event Calendar schedule was updated.`, relatedRecordType: "seedlingRequest", relatedRecordId: id, requestNumber: request.requestNumber || "", relatedEventId: eventRef.id, createdAt: now });
    writeNotifications(transaction, {
      eventId: eventRef.id,
      event: { ...event, date: proposal.plantingDate, startTime: proposal.startTime, endTime: proposal.endTime },
      previousSchedule: event,
      recipientIds: eventRecipients,
      exclude: [request.participantId],
      kind: "rescheduled",
    });
  });
  const updated = await requestRef.get(); return { id: updated.id, ...updated.data() };
};

// ========================================
// RELEASE REQUEST
//
// Approved -> Released
//
// New requests deduct available inventory exactly once here. Legacy requests
// that were previously reserved are reconciled without double deduction.
// ========================================

const releaseSeedlingRequest = async (id, releasedBy, releaseData) => {
  const submittedItems = releaseData?.items;
  if (!Array.isArray(submittedItems) || submittedItems.length === 0) {
    throw new Error("Release items are required.");
  }

  const requestRef = db.collection(COLLECTION).doc(id);
  await db.runTransaction(async (transaction) => {
    const requestDoc = await transaction.get(requestRef);
    if (!requestDoc.exists) throw new Error("Seedling request not found.");
    const request = requestDoc.data();
    assertMutationVersion(request, releaseData?.expectedVersion);
    if (request.inventoryReleased === true || request.status === "Released") {
      throw new Error("Seedlings have already been released for this request.");
    }
    if (request.status !== "Approved") {
      throw new Error("Only approved requests can be released.");
    }
    if (!request.eventId) throw new Error("Approved request has no linked event.");
    if (["AwaitingRequester", "PendingStaffReview", "ReturnedForRevision"].includes(request.lateReleaseRescheduling?.status)) {
      const error = new Error("Resolve the late-release planting schedule conflict before releasing seedlings.");
      error.code = "UNRESOLVED_LATE_RELEASE_CONFLICT";
      throw error;
    }

    const requestedItems = normalizeRequestItems(request);
    validateItemStructure(requestedItems);
    const requestedById = new Map(requestedItems.map((item) => [item.inventoryId, item]));
    const releasedById = new Map();
    for (const item of submittedItems) {
      const inventoryId = cleanString(item?.inventoryId);
      const releasedQuantity = Number(item?.releasedQuantity);
      if (!requestedById.has(inventoryId) || releasedById.has(inventoryId)) {
        throw new Error("Release items must match the request exactly.");
      }
      if (!Number.isInteger(releasedQuantity) || releasedQuantity <= 0) {
        throw new Error("Released quantity must be a positive whole number.");
      }
      const requestedQuantity = Number(requestedById.get(inventoryId).quantity);
      if (releasedQuantity > requestedQuantity) {
        throw new Error("Released quantity cannot exceed requested quantity.");
      }
      const shortReleaseReason = cleanString(item?.shortReleaseReason);
      if (releasedQuantity < requestedQuantity && !shortReleaseReason) {
        throw new Error("A short-release reason is required.");
      }
      releasedById.set(inventoryId, { releasedQuantity, shortReleaseReason });
    }
    if (releasedById.size !== requestedById.size) {
      throw new Error("Release items must match the request exactly.");
    }

    const eventRef = db.collection("events").doc(request.eventId);
    const distributionRef = db.collection("distributions").doc(id);
    const eventDoc = await transaction.get(eventRef);
    const distributionDoc = await transaction.get(distributionRef);
    if (!eventDoc.exists || eventDoc.data().sourceRequestId !== id) {
      throw new Error("Linked planting event not found.");
    }
    const availableReleaseDate = cleanString(releaseData?.availableReleaseDate);
    if (availableReleaseDate && (!/^\d{4}-\d{2}-\d{2}$/.test(availableReleaseDate) || availableReleaseDate < manilaDateOnly())) {
      throw new Error("A valid available release date is required.");
    }
    if (availableReleaseDate && availableReleaseDate > cleanString(eventDoc.data().date) && request.lateReleaseRescheduling?.status !== "Approved") {
      const error = new Error("The available release date is later than the approved planting date. Complete late-release rescheduling first.");
      error.code = "UNRESOLVED_LATE_RELEASE_CONFLICT";
      throw error;
    }
    if (distributionDoc.exists) throw new Error("Seedlings have already been released for this request.");

    const inventoryRows = [];
    for (const requested of requestedItems) {
      const ref = db.collection(INVENTORY_COLLECTION).doc(requested.inventoryId);
      const doc = await transaction.get(ref);
      if (!doc.exists || doc.data().isDeleted === true) {
        throw new Error("Linked seedling inventory was not found.");
      }
      const stock = doc.data();
      const entered = releasedById.get(requested.inventoryId);
      const isLegacyReserved = request.inventoryReserved === true;
      const available = Number(stock.currentQuantity ?? stock.availableQuantity ?? 0);
      const reserved = Number(stock.reservedQuantity || 0);
      if (isLegacyReserved) {
        if (reserved < Number(requested.quantity)) {
          throw new Error("Reserved inventory is inconsistent with this request.");
        }
      } else if (entered.releasedQuantity > available) {
        throw new Error("Released quantity exceeds current available stock.");
      }
      inventoryRows.push({ ref, stock, requested, entered, isLegacyReserved });
    }

    const lowStockRecipients = await getRoleRecipientsInTransaction(
      transaction,
      ["admin", "staff"]
    );
    const now = Timestamp.now();
    const releaseItems = inventoryRows.map(({ requested, entered, stock }) => ({
      inventoryId: requested.inventoryId,
      species: cleanString(stock.species),
      scientificName: cleanString(stock.scientificName),
      category: cleanString(stock.category),
      requestedQuantity: Number(requested.quantity),
      releasedQuantity: entered.releasedQuantity,
      quantity: entered.releasedQuantity,
      difference: Number(requested.quantity) - entered.releasedQuantity,
      releaseType: entered.releasedQuantity === Number(requested.quantity) ? "Complete" : "Partial",
      shortReleaseReason: entered.shortReleaseReason,
    }));
    const totalQuantityReleased = releaseItems.reduce((sum, item) => sum + item.releasedQuantity, 0);
    await parentForEventInTransaction(transaction, request.eventId, {
      ...eventDoc.data(), seedlingTotalQuantity: totalQuantityReleased,
    }, now);
    for (const { ref, stock, requested, entered, isLegacyReserved } of inventoryRows) {
      const available = Number(stock.currentQuantity ?? stock.availableQuantity ?? 0);
      const reserved = Number(stock.reservedQuantity || 0);
      const released = entered.releasedQuantity;
      const remainder = Number(requested.quantity) - released;
      const newAvailable = isLegacyReserved ? available + remainder : available - released;
      const lowStockThreshold = Number(stock.lowStockThreshold ?? 20);
      const crossedLowStockThreshold =
        !isLegacyReserved && available > lowStockThreshold && newAvailable <= lowStockThreshold;
      const lowStockCycle = crossedLowStockThreshold
        ? Number(stock.lowStockCycle || 0) + 1
        : Number(stock.lowStockCycle || 0);
      const becameOutOfStock = available > 0 && newAvailable === 0;
      const outOfStockCycle = becameOutOfStock
        ? Number(stock.outOfStockCycle || 0) + 1
        : Number(stock.outOfStockCycle || 0);
      transaction.update(ref, {
        availableQuantity: newAvailable,
        currentQuantity: newAvailable,
        reservedQuantity: isLegacyReserved ? reserved - Number(requested.quantity) : reserved,
        distributedQuantity: Number(stock.distributedQuantity || 0) + released,
        status: calculateInventoryStatus(newAvailable, stock.stockStatus || stock.status),
        stockStatus: calculateInventoryStatus(newAvailable, stock.stockStatus || stock.status),
        lowStockAlertActive: newAvailable <= lowStockThreshold,
        lowStockCycle,
        outOfStockCycle,
        updatedBy: releasedBy,
        updatedAt: now,
      });
      if (crossedLowStockThreshold) {
        lowStockRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
          notificationId: `low_stock_${ref.id}_${lowStockCycle}_${recipient.id}`,
          recipientUserId: recipient.id,
          type: "inventory_low_stock",
          title: "Low Seedling Stock",
          message: `${stock.species || requested.species} has reached the low-stock level. Current available stock: ${newAvailable} seedlings.`,
          relatedRecordType: "inventory",
          relatedRecordId: ref.id,
          createdAt: now,
          details: {
            species: stock.species || requested.species || "",
            availableQuantity: newAvailable,
            lowStockThreshold,
          },
        }));
      }
      if (becameOutOfStock) {
        createOutOfStockNotificationsInTransaction(transaction, {
          inventoryId: ref.id,
          inventoryReference: stock.inventoryNumber || stock.batchReference || ref.id,
          species: stock.species || requested.species || "Seedling",
          cycle: outOfStockCycle,
          createdAt: now,
        }, lowStockRecipients);
      }
    }

    createDistributionRecordInTransaction(transaction, {
      requestId: id,
      requestData: { ...request, items: releaseItems },
      releasedBy,
      releasedAt: now,
    });
    transaction.update(eventRef, {
      seedlingItems: releaseItems.map(({ inventoryId, species, scientificName, category, quantity }) =>
        ({ inventoryId, species, scientificName, category, quantity })),
      seedlingTotalQuantity: totalQuantityReleased,
      seedlingQuantity: totalQuantityReleased,
      recordedSeedlingQuantity: 0,
      remainingSeedlingQuantity: totalQuantityReleased,
      allocationReleasedAt: now,
      updatedAt: now,
    });
    transaction.update(requestRef, {
      status: "Released",
      inventoryReleased: true,
      inventoryReserved: false,
      inventoryDeducted: true,
      releasedItems: releaseItems,
      totalQuantityReleased,
      releaseType: releaseItems.every((item) => item.releaseType === "Complete") ? "Complete" : "Partial",
      releasedBy,
      releasedAt: now,
      distributionId: id,
      availableReleaseDate,
      requestVersion: requestVersion(request) + 1,
      updatedAt: now,
    });
    createNotificationInTransaction(transaction, {
      notificationId: `request_released_${id}`,
      recipientUserId: request.participantId,
      type: "request_released",
      title: "Seedlings Released",
      message: "The seedlings for your request have been successfully released by MENRO Staff. Below are the actual seedlings released for your planting activity.",
      relatedRecordType: "seedlingRequest",
      relatedRecordId: id,
      requestNumber: request.requestNumber || "",
      relatedEventId: request.eventId,
      relatedDistributionId: id,
      details: {
        releasedAt: now,
        releasedBy,
        releasedItems: releaseItems.map((item) => ({
          inventoryId: item.inventoryId,
          species: item.species,
          releasedQuantity: item.releasedQuantity,
          releaseType: item.releaseType,
          shortReleaseReason: item.shortReleaseReason || "",
        })),
      },
      createdAt: now,
    });
    createDistributionNotificationsInTransaction(transaction, lowStockRecipients, {
      distributionId: id,
      requestId: id,
      requestNumber: request.requestNumber || "",
      totalQuantityReleased,
      speciesSummary: releaseItems.map((item) => item.species).filter(Boolean).join(", "),
      releasedItems: releaseItems.map((item) => ({
        inventoryId: item.inventoryId,
        species: item.species,
        releasedQuantity: item.releasedQuantity,
      })),
      createdAt: now,
    });
  });
  const updatedDoc = await requestRef.get();
  return { id: updatedDoc.id, ...updatedDoc.data() };
};

module.exports = {
  deriveSeedlingRequestDocumentId,
  createSeedlingRequest,
  getAllSeedlingRequests,
  getSeedlingRequestById,
  getSeedlingRequestsByStatus,
  getSeedlingRequestsByParticipantId,
  reviewSeedlingRequest,
  returnSeedlingRequest,
  resubmitSeedlingRequest,
  proposePreApprovalSchedule,
  confirmPreApprovalSchedule,
  approveSeedlingRequest,
  rejectSeedlingRequest,
  releaseSeedlingRequest,
  recordLateReleaseConflict,
  proposeLateReleaseSchedule,
  decideLateReleaseSchedule,
  revealIdentification,

  // Useful for other modules that need
  // backward-compatible request items.
  normalizeRequestItems,
};
