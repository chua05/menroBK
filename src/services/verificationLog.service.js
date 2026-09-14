const { db } = require("../config/firebase");

const COLLECTION = "verificationLogs";

const verificationLogCollection =
  db.collection(COLLECTION);

// CREATE LOG INSIDE EXISTING TRANSACTION
const createVerificationLogInTransaction = (
  transaction,
  {
    plantingReportId,
    action,
    previousStatus,
    newStatus,
    performedBy,
    performedByRole,
    remarks,
    createdAt,
  }
) => {
  const logRef =
    verificationLogCollection.doc();

  const logData = {
    plantingReportId,

    action,

    previousStatus,

    newStatus,

    performedBy,

    performedByRole,

    remarks: remarks || "",

    createdAt,
  };

  transaction.set(
    logRef,
    logData
  );

  return {
    id: logRef.id,
    ...logData,
  };
};

// GET LOGS OF ONE PLANTING REPORT
const getVerificationLogsByPlantingReportId =
  async (plantingReportId) => {
    const snapshot =
      await verificationLogCollection
        .where(
          "plantingReportId",
          "==",
          plantingReportId
        )
        .get();

    const logs =
      snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

    logs.sort((a, b) => {
      const aSeconds =
        a.createdAt?._seconds ??
        a.createdAt?.seconds ??
        0;

      const bSeconds =
        b.createdAt?._seconds ??
        b.createdAt?.seconds ??
        0;

      return aSeconds - bSeconds;
    });

    return logs;
  };

module.exports = {
  createVerificationLogInTransaction,
  getVerificationLogsByPlantingReportId,
};