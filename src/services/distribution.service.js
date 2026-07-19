const { db } = require("../config/firebase");

const COLLECTION = "distributions";

const distributionCollection =
  db.collection(COLLECTION);

/**
 * Creates a distribution record inside an existing
 * Firestore transaction.
 *
 * This is called during seedling release so that:
 * 1. Inventory deduction
 * 2. Request release
 * 3. Distribution record creation
 *
 * happen in one atomic transaction.
 */
const createDistributionRecordInTransaction = (
  transaction,
  {
    requestId,
    requestData,
    releasedBy,
    releasedAt,
  }
) => {
  // Use requestId as distribution document ID.
  // This ensures one distribution record per request.
  const distributionRef =
    distributionCollection.doc(requestId);

  const distributionData = {
    requestId,

    inventoryId:
      requestData.inventoryId,

    participantId:
      requestData.participantId,

    participantName:
      requestData.participantName,

    organization:
      requestData.organization,

    contactNumber:
      requestData.contactNumber,

    species:
      requestData.species,

    quantityReleased:
      requestData.quantity,

    purpose:
      requestData.purpose,

    plantingLocation:
      requestData.plantingLocation,

    preferredReleaseDate:
      requestData.preferredReleaseDate,

    reviewedBy:
      requestData.reviewedBy || "",

    approvedBy:
      requestData.approvedBy || "",

    releasedBy,

    status: "Released",

    releasedAt,

    createdAt: releasedAt,
  };

  transaction.set(
    distributionRef,
    distributionData
  );

  return {
    id: distributionRef.id,
    ...distributionData,
  };
};

// GET ALL DISTRIBUTION RECORDS
const getAllDistributions = async (
  {
    species,
    participantId,
    requestId,
  } = {}
) => {
  const snapshot =
    await distributionCollection.get();

  let distributions =
    snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

  if (species) {
    distributions =
      distributions.filter(
        (distribution) =>
          distribution.species
            ?.toLowerCase()
            .includes(
              species.toLowerCase()
            )
      );
  }

  if (participantId) {
    distributions =
      distributions.filter(
        (distribution) =>
          distribution.participantId ===
          participantId
      );
  }

  if (requestId) {
    distributions =
      distributions.filter(
        (distribution) =>
          distribution.requestId ===
          requestId
      );
  }

  return distributions;
};

// GET DISTRIBUTION BY ID
const getDistributionById = async (id) => {
  const doc =
    await distributionCollection
      .doc(id)
      .get();

  if (!doc.exists) {
    throw new Error(
      "Distribution record not found."
    );
  }

  return {
    id: doc.id,
    ...doc.data(),
  };
};

// GET DISTRIBUTIONS BY PARTICIPANT ID
const getDistributionsByParticipantId =
  async (participantId) => {
    const snapshot =
      await distributionCollection
        .where(
          "participantId",
          "==",
          participantId
        )
        .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  };

module.exports = {
  createDistributionRecordInTransaction,
  getAllDistributions,
  getDistributionById,
  getDistributionsByParticipantId,
};