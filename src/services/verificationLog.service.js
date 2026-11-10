const { db } = require("../config/firebase");

const COLLECTION = "verificationLogs";

const verificationLogCollection =
  db.collection(COLLECTION);

// CREATE LOG INSIDE EXISTING TRANSACTION
const createVerificationLogInTransaction = (
  transaction,
  {
    plantingReportId,
    submissionId,
    action,
    previousStatus,
    newStatus,
    performedBy,
    performedByRole,
    performedByName,
    remarks,
    createdAt,
    // Final planting reports: every row decided together, and the stable
    // logical report it belongs to.
    finalReportId,
    finalReportGroupId,
    submissionIds,
    // Field-specific Return for Correction: [{ path, label, comment }].
    correctionFields,
  }
) => {
  const logRef =
    verificationLogCollection.doc();

  const logData = {
    plantingReportId,

    ...(submissionId ? { submissionId } : {}),

    ...(finalReportId ? { finalReportId } : {}),

    ...(finalReportGroupId ? { finalReportGroupId } : {}),

    ...(Array.isArray(submissionIds) && submissionIds.length ? { submissionIds } : {}),

    ...(Array.isArray(correctionFields) && correctionFields.length ? { correctionFields } : {}),

    ...(performedByName ? { performedByName } : {}),

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

      // Decisions often land within the same second; nanoseconds keep history order.
      const aNanos = a.createdAt?._nanoseconds ?? a.createdAt?.nanoseconds ?? 0;
      const bNanos = b.createdAt?._nanoseconds ?? b.createdAt?.nanoseconds ?? 0;

      return aSeconds - bSeconds || aNanos - bNanos;
    });

    return logs;
  };

module.exports = {
  createVerificationLogInTransaction,
  getVerificationLogsByPlantingReportId,
};