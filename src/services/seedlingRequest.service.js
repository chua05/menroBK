const { db } = require("../config/firebase");

const {
  Timestamp,
} = require("firebase-admin/firestore");

const {
  calculateInventoryStatus,
} = require(
  "./inventory.service"
);

const {
  createDistributionRecordInTransaction,
} = require(
  "./distribution.service"
);

const COLLECTION =
  "seedlingRequests";

const INVENTORY_COLLECTION =
  "seedlingInventory";

// ========================================
// CREATE SEEDLING REQUEST
// ========================================
const createSeedlingRequest =
  async (data) => {
    const inventoryRef = db
      .collection(
        INVENTORY_COLLECTION
      )
      .doc(data.inventoryId);

    const inventoryDoc =
      await inventoryRef.get();

    if (
      !inventoryDoc.exists ||
      inventoryDoc.data()
        .isDeleted === true
    ) {
      throw new Error(
        "Selected seedling inventory not found."
      );
    }

    const inventoryData =
      inventoryDoc.data();

    const requestedQuantity =
      Number(data.quantity);

    if (
      !Number.isInteger(
        requestedQuantity
      ) ||
      requestedQuantity <= 0
    ) {
      throw new Error(
        "Requested quantity must be a positive whole number."
      );
    }

    const availableQuantity =
      Number(
        inventoryData
          .availableQuantity || 0
      );

    if (
      requestedQuantity >
      availableQuantity
    ) {
      throw new Error(
        `Only ${availableQuantity} ${inventoryData.species} seedlings are currently available.`
      );
    }

    const now =
      Timestamp.now();

    const requestData = {
      ...data,

      quantity:
        requestedQuantity,

      species:
        inventoryData.species,

      createdAt: now,
      updatedAt: now,
    };

    const docRef = await db
      .collection(COLLECTION)
      .add(requestData);

    return {
      id: docRef.id,
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
        id: doc.id,
        ...doc.data(),
      })
    );
  };

// ========================================
// GET REQUEST BY ID
// ========================================
const getSeedlingRequestById =
  async (id) => {
    const doc = await db
      .collection(COLLECTION)
      .doc(id)
      .get();

    if (!doc.exists) {
      throw new Error(
        "Seedling request not found."
      );
    }

    return {
      id: doc.id,
      ...doc.data(),
    };
  };

// ========================================
// GET BY STATUS
// ========================================
const getSeedlingRequestsByStatus =
  async (status) => {
    const snapshot = await db
      .collection(COLLECTION)
      .where(
        "status",
        "==",
        status
      )
      .get();

    return snapshot.docs.map(
      (doc) => ({
        id: doc.id,
        ...doc.data(),
      })
    );
  };

// ========================================
// PARTICIPANT REQUESTS
// ========================================
const getSeedlingRequestsByParticipantId =
  async (participantId) => {
    const snapshot = await db
      .collection(COLLECTION)
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

// ========================================
// STAFF REVIEW
// ========================================
const reviewSeedlingRequest = async (
  id,
  reviewData
) => {
  const docRef = db
    .collection(COLLECTION)
    .doc(id);

  const doc = await docRef.get();

  // ========================================
  // REQUEST EXISTS
  // ========================================

  if (!doc.exists) {
    throw new Error(
      "Seedling request not found."
    );
  }

  const currentRequest = doc.data();

  // ========================================
  // ONLY PENDING CAN BE REVIEWED
  // ========================================

  if (currentRequest.status !== "Pending") {
    throw new Error(
      "Only pending requests can be reviewed."
    );
  }

  // ========================================
  // QUANTITY VALIDATION
  // ========================================

  const quantity = Number(
    reviewData.quantity
  );

  if (
    !Number.isInteger(quantity) ||
    quantity <= 0
  ) {
    throw new Error(
      "Request quantity must be a positive whole number."
    );
  }

  // ========================================
  // LINKED INVENTORY
  // ========================================

  if (!currentRequest.inventoryId) {
    throw new Error(
      "Seedling request has no linked inventory."
    );
  }

  const inventoryRef = db
    .collection(INVENTORY_COLLECTION)
    .doc(currentRequest.inventoryId);

  const inventoryDoc =
    await inventoryRef.get();

  if (
    !inventoryDoc.exists ||
    inventoryDoc.data().isDeleted === true
  ) {
    throw new Error(
      "Linked seedling inventory not found."
    );
  }

  const inventoryData =
    inventoryDoc.data();

  const availableQuantity = Number(
    inventoryData.availableQuantity || 0
  );

  // ========================================
  // CHECK CURRENT STOCK
  // ========================================

  if (quantity > availableQuantity) {
    throw new Error(
      `Only ${availableQuantity} ${inventoryData.species} seedlings are currently available.`
    );
  }

  const now = Timestamp.now();

  // ========================================
  // SAVE STAFF REVIEW
  //
  // NOTE:
  // Do NOT deduct inventory here.
  // Inventory reservation happens only
  // after Admin approval.
  // ========================================

  await docRef.update({
    quantity,

    purpose:
      String(reviewData.purpose || "").trim(),

    plantingLocation:
      String(
        reviewData.plantingLocation || ""
      ).trim(),

    preferredReleaseDate:
      reviewData.preferredReleaseDate,

    reviewedBy:
      reviewData.reviewedBy,

    reviewedAt: now,

    status: "Reviewed",

    updatedAt: now,
  });

  const updatedDoc =
    await docRef.get();

  return {
    id: updatedDoc.id,
    ...updatedDoc.data(),
  };
};


// ========================================
// ADMIN FINAL APPROVAL
// RESERVE + DEDUCT AVAILABLE STOCK
// ========================================
const approveSeedlingRequest =
  async (
    id,
    approvedBy
  ) => {
    const requestRef = db
      .collection(COLLECTION)
      .doc(id);

    await db.runTransaction(
      async (transaction) => {
        const requestDoc =
          await transaction.get(
            requestRef
          );

        if (!requestDoc.exists) {
          throw new Error(
            "Seedling request not found."
          );
        }

        const currentRequest =
          requestDoc.data();

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
            .inventoryDeducted ===
          true
        ) {
          throw new Error(
            "Inventory has already been deducted for this request."
          );
        }

        if (
          !currentRequest.inventoryId
        ) {
          throw new Error(
            "Seedling request has no linked inventory."
          );
        }

        const requestedQuantity =
          Number(
            currentRequest.quantity
          );

        if (
          !Number.isInteger(
            requestedQuantity
          ) ||
          requestedQuantity <= 0
        ) {
          throw new Error(
            "Invalid requested quantity."
          );
        }

        const inventoryRef = db
          .collection(
            INVENTORY_COLLECTION
          )
          .doc(
            currentRequest
              .inventoryId
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
            "Linked seedling inventory not found."
          );
        }

        const inventoryData =
          inventoryDoc.data();

        const availableQuantity =
          Number(
            inventoryData
              .availableQuantity ||
              0
          );

        if (
          availableQuantity <
          requestedQuantity
        ) {
          throw new Error(
            `Insufficient seedling stock. Only ${availableQuantity} seedlings are available.`
          );
        }

        const currentReserved =
          Number(
            inventoryData
              .reservedQuantity ||
              0
          );

        const newAvailable =
          availableQuantity -
          requestedQuantity;

        const newReserved =
          currentReserved +
          requestedQuantity;

        const now =
          Timestamp.now();

        transaction.update(
          inventoryRef,
          {
            availableQuantity:
              newAvailable,

            reservedQuantity:
              newReserved,

            status:
              calculateInventoryStatus(
                newAvailable
              ),

            updatedBy:
              approvedBy,

            updatedAt: now,
          }
        );

        transaction.update(
          requestRef,
          {
            status:
              "Approved",

            approvedBy,

            approvedAt: now,

            // Prevent second deduction.
            inventoryDeducted:
              true,

            inventoryReserved:
              true,

            updatedAt: now,
          }
        );
      }
    );

    const updatedDoc =
      await requestRef.get();

    return {
      id: updatedDoc.id,
      ...updatedDoc.data(),
    };
  };

// ========================================
// REJECT REQUEST
// ========================================
const rejectSeedlingRequest =
  async (
    id,
    rejectedBy
  ) => {
    const docRef = db
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
      "Reviewed"
    ) {
      throw new Error(
        "Only reviewed requests can be rejected."
      );
    }

    await docRef.update({
      status:
        "Rejected",

      rejectedBy,

      rejectedAt:
        Timestamp.now(),

      updatedAt:
        Timestamp.now(),
    });

    const updatedDoc =
      await docRef.get();

    return {
      id: updatedDoc.id,
      ...updatedDoc.data(),
    };
  };

// ========================================
// RELEASE REQUEST
// MOVE RESERVED → DISTRIBUTED
// DO NOT DEDUCT AVAILABLE AGAIN
// ========================================
const releaseSeedlingRequest =
  async (
    id,
    releasedBy
  ) => {
    const requestRef = db
      .collection(COLLECTION)
      .doc(id);

    await db.runTransaction(
      async (transaction) => {
        const requestDoc =
          await transaction.get(
            requestRef
          );

        if (!requestDoc.exists) {
          throw new Error(
            "Seedling request not found."
          );
        }

        const currentRequest =
          requestDoc.data();

        if (
          currentRequest.status !==
          "Approved"
        ) {
          throw new Error(
            "Only approved requests can be released."
          );
        }

        if (
          !currentRequest.inventoryId
        ) {
          throw new Error(
            "Seedling request has no linked inventory."
          );
        }

        if (
          currentRequest
            .inventoryDeducted !==
          true
        ) {
          throw new Error(
            "Inventory was not reserved for this approved request."
          );
        }

        const requestedQuantity =
          Number(
            currentRequest.quantity
          );

        if (
          !Number.isInteger(
            requestedQuantity
          ) ||
          requestedQuantity <= 0
        ) {
          throw new Error(
            "Invalid requested quantity."
          );
        }

        const inventoryRef = db
          .collection(
            INVENTORY_COLLECTION
          )
          .doc(
            currentRequest
              .inventoryId
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
            "Linked seedling inventory not found."
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

        if (
          reservedQuantity <
          requestedQuantity
        ) {
          throw new Error(
            "Reserved stock is inconsistent with this request."
          );
        }

        const distributedQuantity =
          Number(
            inventoryData
              .distributedQuantity ||
              0
          );

        const now =
          Timestamp.now();

        transaction.update(
          inventoryRef,
          {
            reservedQuantity:
              reservedQuantity -
              requestedQuantity,

            distributedQuantity:
              distributedQuantity +
              requestedQuantity,

            updatedBy:
              releasedBy,

            updatedAt: now,
          }
        );

        transaction.update(
          requestRef,
          {
            status:
              "Released",

            releasedBy,

            releasedAt: now,

            inventoryReleased:
              true,

            distributionId:
              id,

            updatedAt: now,
          }
        );

        createDistributionRecordInTransaction(
          transaction,
          {
            requestId: id,

            requestData:
              currentRequest,

            releasedBy,

            releasedAt: now,
          }
        );
      }
    );

    const updatedDoc =
      await requestRef.get();

    return {
      id: updatedDoc.id,
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
};