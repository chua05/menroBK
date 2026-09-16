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

    const doc =
      await docRef.get();

    if (!doc.exists) {
      throw new Error(
        "Seedling request not found."
      );
    }

    const currentRequest =
      doc.data();

    if (
      currentRequest.status !==
      "Pending"
    ) {
      throw new Error(
        "Only pending requests can be reviewed."
      );
    }

    const reviewItems = normalizeRequestItems({ items: reviewData.items });

    validateItemStructure(reviewItems);

    const canonicalItems = [];

    // Only verify inventory existence, do NOT reject based on availableQuantity.
    for (const item of reviewItems) {
      const inventoryRef = db.collection(INVENTORY_COLLECTION).doc(item.inventoryId);

      const inventoryDoc = await inventoryRef.get();

      if (!inventoryDoc.exists || inventoryDoc.data().isDeleted === true) {
        throw new Error(
          "One of the linked seedling inventory records was not found."
        );
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

    // Review remarks validation
    const reviewRemarks = cleanString(reviewData.reviewRemarks || "");

    if (!reviewRemarks) {
      throw new Error("Review findings/remarks are required.");
    }

    await docRef.update({
      items:
        canonicalItems,

      totalQuantity,

      purpose:
        cleanString(
          reviewData.purpose
        ),

      plantingLocation:
        cleanString(
          reviewData
            .plantingLocation
        ),

      preferredReleaseDate:
        reviewData
          .preferredReleaseDate,
      reviewedBy: reviewData.reviewedBy,
      reviewedByName: reviewData.reviewedByName || "",
      reviewRemarks,
      reviewedAt: now,
      status: "Reviewed",
      updatedAt: now,
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

        // For each requested item, read inventory and compute approvedQuantity = min(requested, available).
        // Do not reject approval if requested > available; approve only what can be accommodated.
        for (const item of requestItems) {
          const inventoryRef = db.collection(INVENTORY_COLLECTION).doc(item.inventoryId);

          const inventoryDoc = await transaction.get(inventoryRef);

          if (!inventoryDoc.exists || inventoryDoc.data().isDeleted === true) {
            throw new Error(
              `Linked seedling inventory for ${item.species || "a requested item"} was not found.`
            );
          }

          const inventoryData = inventoryDoc.data();

          const availableQuantity = Number(inventoryData.availableQuantity || 0);

          const requestedQty = Number(item.quantity || 0);

          const approvedQuantity = Math.max(0, Math.min(requestedQty, availableQuantity));

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

        // ========================================
        // RESERVE ALL INVENTORY ITEMS
        // ========================================

        for (const record of inventoryRecords) {
          const { item, inventoryRef, inventoryData, approvedQuantity } = record;

          if (approvedQuantity <= 0) {
            // Nothing to reserve for this inventory item.
            continue;
          }

          const availableQuantity = Number(inventoryData.availableQuantity || 0);

          const reservedQuantity = Number(inventoryData.reservedQuantity || 0);

          const newAvailable = availableQuantity - approvedQuantity;

          const newReserved = reservedQuantity + approvedQuantity;

          const lowStockThreshold = Number(inventoryData.lowStockThreshold ?? 20);

          transaction.update(inventoryRef, {
            availableQuantity: newAvailable,
            reservedQuantity: newReserved,
            status: calculateInventoryStatus(newAvailable, lowStockThreshold),
            updatedBy: approvedBy,
            updatedAt: now,
          });
        }

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
          inventoryDeducted: true,
          inventoryReserved: true,
          approvedItems,
          updatedAt: now,
        });

        createNotificationInTransaction(transaction, {
          recipientUserId: currentRequest.participantId,
          type: "request_approved",
          title: "Seedling request approved",
          message: "Your seedling request has been approved. Please wait for release updates.",
          relatedRecordType: "seedlingRequest",
          relatedRecordId: id,
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

const releaseSeedlingRequest =
  async (
    id,
    releasedBy
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

        if (currentRequest.status === "Released" && currentRequest.inventoryReleased === true) {
          return;
        }

        if (
          currentRequest.status !==
          "Approved"
        ) {
          throw new Error(
            "Only approved requests can be released."
          );
        }

        if (
          currentRequest
            .inventoryReserved !==
            true &&
          currentRequest
            .inventoryDeducted !==
            true
        ) {
          throw new Error(
            "Inventory was not reserved for this approved request."
          );
        }

        if (
          currentRequest
            .inventoryReleased ===
          true
        ) {
          throw new Error(
            "Seedlings have already been released for this request."
          );
        }

        const requestItems =
          Array.isArray(currentRequest.approvedItems) && currentRequest.approvedItems.length > 0
            ? currentRequest.approvedItems
            : normalizeRequestItems(currentRequest);

        validateItemStructure(
          requestItems
        );

        // ========================================
        // READ ALL INVENTORY FIRST
        // ========================================

        const inventoryRecords =
          [];

        for (
          const item of requestItems
        ) {
          const inventoryRef =
            db
              .collection(
                INVENTORY_COLLECTION
              )
              .doc(
                item.inventoryId
              );

          const inventoryDoc =
            await transaction.get(
              inventoryRef
            );

          if (
            !inventoryDoc.exists ||
            inventoryDoc.data()
              .isDeleted === true
          ) {
            throw new Error(
              `Linked seedling inventory for ${item.species || "a requested item"} was not found.`
            );
          }

          const inventoryData =
            inventoryDoc.data();

          const reservedQuantity =
            Number(
              inventoryData
                .reservedQuantity ||
                0
            );

          const quantityToRelease = Number(item.quantity || 0);

          if (reservedQuantity < quantityToRelease) {
            throw new Error(
              `Reserved ${inventoryData.species} stock is inconsistent with this request.`
            );
          }

          inventoryRecords.push({
            item,
            inventoryRef,
            inventoryData,
          });
        }

        const now =
          Timestamp.now();

        // ========================================
        // RESERVED -> DISTRIBUTED
        // ========================================

        for (
          const record of inventoryRecords
        ) {
          const {
            item,
            inventoryRef,
            inventoryData,
          } = record;
          const quantityToRelease = Number(item.quantity || 0);

          const reservedQuantity =
            Number(
              inventoryData
                .reservedQuantity ||
                0
            );

          const distributedQuantity =
            Number(
              inventoryData
                .distributedQuantity ||
                0
            );

          transaction.update(
            inventoryRef,
            {
              reservedQuantity: reservedQuantity - quantityToRelease,

              distributedQuantity: distributedQuantity + quantityToRelease,

              updatedBy:
                releasedBy,

              updatedAt:
                now,
            }
          );
        }

        // ========================================
        // DISTRIBUTION RECORD
        // ========================================

        createDistributionRecordInTransaction(
          transaction,
          {
            requestId:
              id,

            requestData: {
              ...currentRequest,
              items: requestItems,
            },

            releasedBy,

            releasedAt:
              now,
          }
        );

        // ========================================
        // REQUEST -> RELEASED
        // ========================================

        transaction.update(
          requestRef,
          {
            status:
              "Released",

            releasedBy,

            releasedAt:
              now,

            inventoryReleased:
              true,

            distributionId:
              id,

            updatedAt:
              now,
          }
        );
        createNotificationInTransaction(transaction, {
          recipientUserId: currentRequest.participantId,
          type: "request_released",
          title: "Seedlings released",
          message: "Seedlings for your request have been released.",
          relatedRecordType: "seedlingRequest",
          relatedRecordId: id,
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
