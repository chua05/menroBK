const {
  db,
} = require("../config/firebase");

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
} = require("./notification.service");
const { createInvitationInTransaction } = require("./guestEvent.service");
const { parentForEventInTransaction } = require("./parentPlantingReport.service");

const COLLECTION =
  "seedlingRequests";

const INVENTORY_COLLECTION =
  "seedlingInventory";

const SITES_COLLECTION =
  "sites";

const COUNTERS_COLLECTION = "counters";
const REQUEST_COUNTER_DOCUMENT = "seedlingRequests";

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
) =>
  cleanString(
    value
  ).toLowerCase();

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
  async (data) => {
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

    if (!plantingSiteId) {
      throw new Error("Planting site is required.");
    }

    // Reuse site service so utilization logic is authoritative.
    const site = await siteService.getSiteById(
      plantingSiteId
    );

    if (normalizeBarangay(site.barangay) !==
        normalizeBarangay(requestData.eventProposal?.barangay)) {
      throw new Error("Selected planting site does not belong to the event barangay.");
    }

    if (String(site.status || "").trim().toLowerCase() !== "active") {
      throw new Error("Selected planting site is archived.");
    }

    // site.utilizationPercentage now comes from site.service
    const utilization = Number(site.utilizationPercentage || 0);

    if (utilization >= 90) {
      throw new Error("Selected planting site is already full.");
    }

    const docRef = db.collection(COLLECTION).doc();
    const requestYear = Number(new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Manila",
      year: "numeric",
    }).format(new Date()));
    const counterRef = db.collection(COUNTERS_COLLECTION)
      .doc(`${REQUEST_COUNTER_DOCUMENT}_${requestYear}`);

    await db.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      const currentValue = counterDoc.exists
        ? Number(counterDoc.data()?.lastNumber || 0)
        : 0;
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
      requestData.requestNumber = requestNumber;
    });

    return {
      id:
        docRef.id,

      ...requestData,
    };
  };

// ========================================
// GET ALL REQUESTS
// ========================================

const getAllSeedlingRequests =
  async () => {
    const [snapshot, distributions] = await Promise.all([
      db.collection(COLLECTION).get(),
      releasedDistributionMap(),
    ]);

    return snapshot.docs.map(
      (doc) => withLegacyReleaseState({
        id:
          doc.id,

        ...doc.data(),
      }, distributions.get(doc.id))
    );
  };

// ========================================
// GET REQUEST BY ID
// ========================================

const getSeedlingRequestById =
  async (id) => {
    const doc =
      await db
        .collection(COLLECTION)
        .doc(id)
        .get();

    if (!doc.exists) {
      throw new Error(
        "Seedling request not found."
      );
    }

    const request = {
      id:
        doc.id,

      ...doc.data(),
    };
    const distribution = request.status === "Approved"
      ? await db.collection("distributions").doc(id).get()
      : null;
    return withLegacyReleaseState(
      request,
      distribution?.exists ? { id: distribution.id, ...distribution.data() } : null
    );
  };

// ========================================
// GET BY STATUS
// ========================================

const getSeedlingRequestsByStatus =
  async (status) => {
    const requests = await getAllSeedlingRequests();
    return requests.filter((request) => request.status === status);
  };

// ========================================
// PARTICIPANT REQUESTS
// ========================================

const getSeedlingRequestsByParticipantId =
  async (
    participantId
  ) => {
    const [snapshot, distributions] = await Promise.all([
      db.collection(COLLECTION).where("participantId", "==", participantId).get(),
      releasedDistributionMap(),
    ]);

    return snapshot.docs.map(
      (doc) => withLegacyReleaseState({
        id:
          doc.id,

        ...doc.data(),
      }, distributions.get(doc.id))
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

    const reviewItems = normalizeRequestItems({ items: reviewData.items });

    validateItemStructure(reviewItems);

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);

      if (!doc.exists) {
        throw new Error("Seedling request not found.");
      }

      const currentRequest = doc.data();

      if (currentRequest.status !== "Pending") {
        throw new Error("Only pending requests can be reviewed.");
      }

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
      const now = Timestamp.now();
      const reviewCycle = (Array.isArray(currentRequest.reviewHistory)
        ? currentRequest.reviewHistory
        : []
      ).filter((entry) => entry?.action === "reviewed").length + 1;

      await createRoleNotificationsInTransaction(transaction, ["admin"], {
        notificationId: `request_reviewed_${id}_${reviewCycle}`,
        type: "request_reviewed",
        title: "Sapling Request Reviewed",
        message: `${currentRequest.requestNumber || id} has been reviewed by MENRO Staff and is ready for your final decision.`,
        relatedRecordType: "seedlingRequest",
        relatedRecordId: id,
        requestNumber: currentRequest.requestNumber || "",
        createdAt: now,
        details: {
          requesterName: currentRequest.participantName || "",
          reviewedByName: reviewData.reviewedByName || "",
          reviewedAt: now,
        },
      });

      transaction.update(docRef, {
        items: canonicalItems,
        totalQuantity,
        purpose: cleanString(reviewData.purpose),
        plantingLocation: cleanString(reviewData.plantingLocation),
        preferredReleaseDate: reviewData.preferredReleaseDate,
        reviewedBy: reviewData.reviewedBy,
        reviewedByName: reviewData.reviewedByName || "",
        reviewRemarks: "",
        reviewedAt: now,
        status: "Reviewed",
        updatedAt: now,
        reviewHistory: [
          ...(Array.isArray(currentRequest.reviewHistory)
            ? currentRequest.reviewHistory
            : []),
          {
            action: "reviewed",
            actorId: reviewData.reviewedBy,
            actorName: reviewData.reviewedByName || "",
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
  reason
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
  const requestRef = db.collection(COLLECTION).doc(id);
  const submittedItems = normalizeRequestItems(data);
  validateItemStructure(submittedItems);

  await db.runTransaction(async (transaction) => {
    const requestDoc = await transaction.get(requestRef);

    if (!requestDoc.exists) {
      throw new Error("Seedling request not found.");
    }

    const request = requestDoc.data();

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
    const siteRef = db.collection(SITES_COLLECTION).doc(
      cleanString(proposal.plantingSiteId)
    );
    const siteDoc = await transaction.get(siteRef);

    if (!siteDoc.exists) {
      throw new Error("Planting site not found.");
    }

    const site = siteDoc.data();
    if (cleanString(site.status || "active").toLowerCase() !== "active") {
      throw new Error("Selected planting site is archived.");
    }

    if (normalizeBarangay(site.barangay) !== normalizeBarangay(proposal.barangay)) {
      throw new Error("Selected planting site does not belong to the event barangay.");
    }

    const capacity = Number(site.maximumCapacity || 0);
    const planted = Number(site.planted || 0);
    if (capacity > 0 && Math.round((planted / capacity) * 100) >= 90) {
      throw new Error("Selected planting site is already full.");
    }

    const now = Timestamp.now();
    const totalQuantity = canonicalItems.reduce(
      (total, item) => total + item.quantity,
      0
    );

    transaction.update(requestRef, {
      items: canonicalItems,
      totalQuantity,
      purpose: cleanString(data.purpose),
      plantingLocation: cleanString(data.plantingLocation),
      preferredReleaseDate: data.preferredReleaseDate,
      eventProposal: {
        eventName: cleanString(proposal.eventName),
        barangay: cleanString(proposal.barangay),
        plantingSiteId: siteDoc.id,
        plantingSiteName: cleanString(site.siteName || site.name),
        proposedDate: proposal.proposedDate,
        proposedStartTime: proposal.proposedStartTime,
        proposedEndTime: proposal.proposedEndTime,
        eventLocation: cleanString(data.plantingLocation),
        latitude: Number(site.latitude),
        longitude: Number(site.longitude),
        expectedParticipants: Number(proposal.expectedParticipants),
        description: cleanString(proposal.description),
        status: "Proposed",
      },
      status: "Pending",
      returnReason: "",
      returnedBy: "",
      returnedByName: "",
      returnedAt: null,
      reviewedBy: "",
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
  });

  const updatedDoc = await requestRef.get();
  return { id: updatedDoc.id, ...updatedDoc.data() };
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
    reason
  ) => {
    const requestRef =
      db
        .collection(COLLECTION)
        .doc(id);

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

        if (
          currentRequest.status === "Approved" &&
          currentRequest.eventId &&
          currentRequest.eventCreated === true
        ) {
          return;
        }

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
            throw new Error(`Invalid approved sapling quantity for ${cleanString(inventoryData.species) || "a requested item"}.`);
          }

          const availableQuantity = Number(inventoryData.availableQuantity || 0);
          if (approvedQuantity > availableQuantity) {
            throw new Error(
              `Insufficient available sapling stock for ${cleanString(inventoryData.species) || item.species || "the requested item"}. Please review the approved quantity.`
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

              approvedBy,

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
          approvedBy,
          approvedAt: now,
          decisionBy: approvedBy,
          decisionAt: now,
          eventId,
          eventCreated: true,
          guestInvitationCreated,
          inventoryDeducted: false,
          inventoryReserved: false,
          approvedItems,
          updatedAt: now,
        });

        createNotificationInTransaction(transaction, {
          notificationId: `request_approved_${id}_${currentRequest.participantId}`,
          recipientUserId: currentRequest.participantId,
          type: "request_approved",
          title: "Sapling Request Approved",
          message: `Your sapling request ${currentRequest.requestNumber || id} has been approved. Please wait for release updates.`,
          relatedRecordType: "seedlingRequest",
          relatedRecordId: id,
          requestNumber: currentRequest.requestNumber || "",
          relatedEventId: eventId,
          createdAt: now,
          details: { approvedAt: now },
        });

        staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
          notificationId: `request_approved_staff_${id}_${recipient.id}`,
          recipientUserId: recipient.id,
          type: "request_approved_staff",
          title: "Sapling Request Approved",
          message: `${currentRequest.requestNumber || id} has been approved by the MENRO Administrator and is ready for sapling release.`,
          relatedRecordType: "seedlingRequest",
          relatedRecordId: id,
          requestNumber: currentRequest.requestNumber || "",
          relatedEventId: eventId,
          createdAt: now,
          details: {
            requesterName: currentRequest.participantName || "",
            approvedAt: now,
          },
        }));
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
    reason
  ) => {
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

      rejectedBy,

      rejectedAt:
        now,

      decisionReason:
        rejectionReason,

      decisionBy:
        rejectedBy,

      decisionAt:
        now,

      updatedAt:
        now,
    });
    createNotificationInTransaction(transaction, {
      notificationId: `request_rejected_${id}_${currentRequest.participantId}`,
      recipientUserId: currentRequest.participantId,
      type: "request_rejected",
      title: "Sapling Request Rejected",
      message: `Your sapling request ${currentRequest.requestNumber || id} was rejected by the MENRO Administrator.`,
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
      title: "Sapling Request Rejected",
      message: `${currentRequest.requestNumber || id} was rejected by the MENRO Administrator and must not proceed to sapling release.`,
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
    if (request.inventoryReleased === true || request.status === "Released") {
      throw new Error("Saplings have already been released for this request.");
    }
    if (request.status !== "Approved") {
      throw new Error("Only approved requests can be released.");
    }
    if (!request.eventId) throw new Error("Approved request has no linked event.");

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
      const available = Number(stock.availableQuantity || 0);
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
      const available = Number(stock.availableQuantity || 0);
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
      transaction.update(ref, {
        availableQuantity: newAvailable,
        reservedQuantity: isLegacyReserved ? reserved - Number(requested.quantity) : reserved,
        distributedQuantity: Number(stock.distributedQuantity || 0) + released,
        status: calculateInventoryStatus(newAvailable, lowStockThreshold),
        lowStockAlertActive: newAvailable <= lowStockThreshold,
        lowStockCycle,
        updatedBy: releasedBy,
        updatedAt: now,
      });
      if (crossedLowStockThreshold) {
        lowStockRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
          notificationId: `low_stock_${ref.id}_${lowStockCycle}_${recipient.id}`,
          recipientUserId: recipient.id,
          type: "inventory_low_stock",
          title: "Low Sapling Stock",
          message: `${stock.species || requested.species} has reached the low-stock level. Current available stock: ${newAvailable} saplings.`,
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
      updatedAt: now,
    });
    createNotificationInTransaction(transaction, {
      notificationId: `request_released_${id}`,
      recipientUserId: request.participantId,
      type: "request_released",
      title: "Saplings Released",
      message: "The saplings for your request have been successfully released by MENRO Staff. Below are the actual saplings released for your planting activity.",
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
  });
  const updatedDoc = await requestRef.get();
  return { id: updatedDoc.id, ...updatedDoc.data() };
};

module.exports = {
  createSeedlingRequest,
  getAllSeedlingRequests,
  getSeedlingRequestById,
  getSeedlingRequestsByStatus,
  getSeedlingRequestsByParticipantId,
  reviewSeedlingRequest,
  returnSeedlingRequest,
  resubmitSeedlingRequest,
  approveSeedlingRequest,
  rejectSeedlingRequest,
  releaseSeedlingRequest,

  // Useful for other modules that need
  // backward-compatible request items.
  normalizeRequestItems,
};
