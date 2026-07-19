const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const {
  calculateInventoryStatus,
} = require("./inventory.service");

const {
  createDistributionRecordInTransaction,
} = require("./distribution.service");

const COLLECTION = "seedlingRequests";
const INVENTORY_COLLECTION = "seedlingInventory";

// CREATE SEEDLING REQUEST
const createSeedlingRequest = async (data) => {
  const inventoryRef = db
    .collection(INVENTORY_COLLECTION)
    .doc(data.inventoryId);

  const inventoryDoc = await inventoryRef.get();

  if (
    !inventoryDoc.exists ||
    inventoryDoc.data().isDeleted === true
  ) {
    throw new Error("Selected seedling inventory not found.");
  }

  const inventoryData = inventoryDoc.data();
  const now = Timestamp.now();

  const requestData = {
    ...data,

    // Species comes from the selected inventory record.
    species: inventoryData.species,

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

// GET ALL REQUESTS
const getAllSeedlingRequests = async () => {
  const snapshot = await db
    .collection(COLLECTION)
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
};

// GET REQUEST BY ID
const getSeedlingRequestById = async (id) => {
  const doc = await db
    .collection(COLLECTION)
    .doc(id)
    .get();

  if (!doc.exists) {
    throw new Error("Seedling request not found.");
  }

  return {
    id: doc.id,
    ...doc.data(),
  };
};

// GET REQUESTS BY STATUS
const getSeedlingRequestsByStatus = async (status) => {
  const snapshot = await db
    .collection(COLLECTION)
    .where("status", "==", status)
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
};

// GET PARTICIPANT REQUESTS
const getSeedlingRequestsByParticipantId = async (
  participantId
) => {
  const snapshot = await db
    .collection(COLLECTION)
    .where("participantId", "==", participantId)
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
};

// REVIEW REQUEST
const reviewSeedlingRequest = async (
  id,
  reviewData
) => {
  const docRef = db
    .collection(COLLECTION)
    .doc(id);

  const doc = await docRef.get();

  if (!doc.exists) {
    throw new Error("Seedling request not found.");
  }

  const currentRequest = doc.data();

  if (currentRequest.status !== "Pending") {
    throw new Error(
      "Only pending requests can be reviewed."
    );
  }

  await docRef.update({
    ...reviewData,
    status: "Reviewed",
    updatedAt: Timestamp.now(),
  });

  const updatedDoc = await docRef.get();

  return {
    id: updatedDoc.id,
    ...updatedDoc.data(),
  };
};

// APPROVE REQUEST
const approveSeedlingRequest = async (
  id,
  approvedBy
) => {
  const docRef = db
    .collection(COLLECTION)
    .doc(id);

  const doc = await docRef.get();

  if (!doc.exists) {
    throw new Error("Seedling request not found.");
  }

  const currentRequest = doc.data();

  if (currentRequest.status !== "Reviewed") {
    throw new Error(
      "Only reviewed requests can be approved."
    );
  }

  await docRef.update({
    status: "Approved",
    approvedBy,
    updatedAt: Timestamp.now(),
  });

  const updatedDoc = await docRef.get();

  return {
    id: updatedDoc.id,
    ...updatedDoc.data(),
  };
};

// REJECT REQUEST
const rejectSeedlingRequest = async (
  id,
  rejectedBy
) => {
  const docRef = db
    .collection(COLLECTION)
    .doc(id);

  const doc = await docRef.get();

  if (!doc.exists) {
    throw new Error("Seedling request not found.");
  }

  const currentRequest = doc.data();

  if (currentRequest.status !== "Reviewed") {
    throw new Error(
      "Only reviewed requests can be rejected."
    );
  }

  await docRef.update({
    status: "Rejected",
    rejectedBy,
    updatedAt: Timestamp.now(),
  });

  const updatedDoc = await docRef.get();

  return {
    id: updatedDoc.id,
    ...updatedDoc.data(),
  };
};

// RELEASE REQUEST AND DEDUCT INVENTORY
const releaseSeedlingRequest = async (
  id,
  releasedBy
) => {
  const requestRef = db
    .collection(COLLECTION)
    .doc(id);

  await db.runTransaction(async (transaction) => {
    const requestDoc = await transaction.get(
      requestRef
    );

    if (!requestDoc.exists) {
      throw new Error(
        "Seedling request not found."
      );
    }

    const currentRequest = requestDoc.data();

    if (currentRequest.status !== "Approved") {
      throw new Error(
        "Only approved requests can be released."
      );
    }

    if (!currentRequest.inventoryId) {
      throw new Error(
        "Seedling request has no linked inventory."
      );
    }

    const requestedQuantity =
      currentRequest.quantity;

    if (
      !Number.isInteger(requestedQuantity) ||
      requestedQuantity <= 0
    ) {
      throw new Error(
        "Invalid requested quantity."
      );
    }

    const inventoryRef = db
      .collection(INVENTORY_COLLECTION)
      .doc(currentRequest.inventoryId);

    const inventoryDoc = await transaction.get(
      inventoryRef
    );

    if (
      !inventoryDoc.exists ||
      inventoryDoc.data().isDeleted === true
    ) {
      throw new Error(
        "Linked seedling inventory not found."
      );
    }

    const inventoryData = inventoryDoc.data();

    const availableQuantity =
      inventoryData.availableQuantity || 0;

    if (availableQuantity < requestedQuantity) {
      throw new Error(
        "Insufficient seedling stock."
      );
    }

    const newAvailableQuantity =
      availableQuantity - requestedQuantity;

    const newDistributedQuantity =
      (inventoryData.distributedQuantity || 0) +
      requestedQuantity;

    const newStatus = calculateInventoryStatus(
      newAvailableQuantity
    );

    const now = Timestamp.now();

    // Deduct inventory.
    transaction.update(inventoryRef, {
      availableQuantity:
        newAvailableQuantity,

      distributedQuantity:
        newDistributedQuantity,

      status: newStatus,

      updatedBy: releasedBy,

      updatedAt: now,
    });

    // Mark request as Released.
    transaction.update(requestRef, {
      status: "Released",

      releasedBy,

      releasedAt: now,

      inventoryDeducted: true,

      distributionId: id,

      updatedAt: now,
    });

    // Create permanent distribution record.
    createDistributionRecordInTransaction(
      transaction,
      {
        requestId: id,
        requestData: currentRequest,
        releasedBy,
        releasedAt: now,
      }
    );
  });

  
  const updatedDoc = await requestRef.get();

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