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
const { createNotificationInTransaction } = require("./notification.service");
const { createInvitationInTransaction } = require("./guestEvent.service");
const { parentForEventInTransaction } = require("./parentPlantingReport.service");

const COLLECTION =
  "seedlingRequests";

const INVENTORY_COLLECTION =
  "seedlingInventory";

const SITES_COLLECTION =
  "sites";

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

    const docRef =
      await db
        .collection(COLLECTION)
        .add(requestData);

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
    const snapshot =
      await db
        .collection(COLLECTION)
        .get();

    return snapshot.docs.map(
      (doc) => ({
        id:
          doc.id,

        ...doc.data(),
      })
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

    return {
      id:
        doc.id,

      ...doc.data(),
    };
  };

// ========================================
// GET BY STATUS
// ========================================

const getSeedlingRequestsByStatus =
  async (status) => {
    const snapshot =
      await db
        .collection(COLLECTION)
        .where(
          "status",
          "==",
          status
        )
        .get();

    return snapshot.docs.map(
      (doc) => ({
        id:
          doc.id,

        ...doc.data(),
      })
    );
  };

// ========================================
// PARTICIPANT REQUESTS
// ========================================

const getSeedlingRequestsByParticipantId =
  async (
    participantId
  ) => {
    const snapshot =
      await db
        .collection(COLLECTION)
        .where(
          "participantId",
          "==",
          participantId
        )
        .get();

    return snapshot.docs.map(
      (doc) => ({
        id:
          doc.id,

        ...doc.data(),
      })
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

    const reviewRemarks = cleanString(reviewData.reviewRemarks || "");

    if (!reviewRemarks) {
      throw new Error("Review findings/remarks are required.");
    }

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);

      if (!doc.exists) {
        throw new Error("Seedling request not found.");
      }

      if (doc.data().status !== "Pending") {
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

      transaction.update(docRef, {
        items: canonicalItems,
        totalQuantity,
        purpose: cleanString(reviewData.purpose),
        plantingLocation: cleanString(reviewData.plantingLocation),
        preferredReleaseDate: reviewData.preferredReleaseDate,
        reviewedBy: reviewData.reviewedBy,
        reviewedByName: reviewData.reviewedByName || "",
        reviewRemarks,
        reviewedAt: now,
        status: "Reviewed",
        updatedAt: now,
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
// ADMIN FINAL APPROVAL
//
// Reviewed -> Approved
//
// All inventory reservations + event creation
// + request approval happen atomically.
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

        if (currentRequest.status === "Approved" && currentRequest.eventId) {
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

        // Read inventory metadata; stock is checked and deducted at release.
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

        let invitationCreationError = null;
        if (Number(proposal.expectedParticipants || 0) > 0) {
          try {
            createInvitationInTransaction(transaction, eventId, id, now);
          } catch (err) {
            // Don't fail the entire approval if guest invitation secret is misconfigured.
            // Record the error so it can be surfaced on the request for admins.
            invitationCreationError = String(err && err.message ? err.message : err);
          }
        }

        // ========================================
        // Approval schedules the event without moving inventory.
        // ========================================

        // ========================================
        // UPDATE REQUEST
        // ========================================

        // Store approvedItems on the request for later release and auditing.
        const requestUpdatePayload = {
          status: "Approved",
          approvedBy,
          approvedAt: now,
          decisionBy: approvedBy,
          decisionAt: now,
          eventId,
          eventCreated: true,
          inventoryDeducted: false,
          inventoryReserved: false,
          approvedItems,
          updatedAt: now,
        };

        if (invitationCreationError) {
          requestUpdatePayload.invitationCreationFailed = true;
          requestUpdatePayload.invitationCreationError = invitationCreationError;
        }

        transaction.update(requestRef, requestUpdatePayload);

        createNotificationInTransaction(transaction, {
          recipientUserId: currentRequest.participantId,
          type: "request_approved",
          title: "Seedling request approved",
          message: "Your seedling request has been approved. Please wait for release updates.",
          relatedRecordType: "seedlingRequest",
          relatedRecordId: id,
          relatedEventId: eventId,
          createdAt: now,
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
    reason
  ) => {
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

    transaction.update(docRef, {
      status:
        "Rejected",

      rejectedBy,

      rejectedAt:
        now,

      decisionReason:
        cleanString(
          reason
        ),

      decisionBy:
        rejectedBy,

      decisionAt:
        now,

      updatedAt:
        now,
    });
    createNotificationInTransaction(transaction, {
      recipientUserId: currentRequest.participantId,
      type: "request_rejected",
      title: "Seedling request rejected",
      message: cleanString(reason)
        ? `Your seedling request was rejected. Reason: ${cleanString(reason)}`
        : "Your seedling request was rejected.",
      relatedRecordType: "seedlingRequest",
      relatedRecordId: id,
      createdAt: now,
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
// RELEASE REQUEST
//
// Approved -> Released
//
// Reserved -> Distributed.
// Available is NOT deducted again.
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
    if (request.inventoryReleased === true) return;
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
      transaction.update(ref, {
        availableQuantity: newAvailable,
        reservedQuantity: isLegacyReserved ? reserved - Number(requested.quantity) : reserved,
        distributedQuantity: Number(stock.distributedQuantity || 0) + released,
        status: calculateInventoryStatus(newAvailable, Number(stock.lowStockThreshold ?? 20)),
        updatedBy: releasedBy,
        updatedAt: now,
      });
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
      recipientUserId: request.participantId,
      type: "request_released",
      title: "Seedlings released",
      message: "Seedlings for your request have been released.",
      relatedRecordType: "seedlingRequest",
      relatedRecordId: id,
      relatedEventId: request.eventId,
      relatedDistributionId: id,
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
  approveSeedlingRequest,
  rejectSeedlingRequest,
  releaseSeedlingRequest,

  // Useful for other modules that need
  // backward-compatible request items.
  normalizeRequestItems,
};
