const { db } = require("../config/firebase");

const {
  Timestamp,
} = require("firebase-admin/firestore");

const MONITORING_COLLECTION =
  "monitoringRecords";

const PLANTING_REPORT_COLLECTION =
  "plantingReports";

const monitoringCollection =
  db.collection(MONITORING_COLLECTION);

// ========================================
// CALCULATE SURVIVAL RATE
// ========================================
const calculateSurvivalRate = (
  healthyCount,
  damagedCount,
  quantityPlanted
) => {
  if (quantityPlanted <= 0) {
    return 0;
  }

  const survivingCount =
    healthyCount + damagedCount;

  const rate =
    (survivingCount /
      quantityPlanted) *
    100;

  return Number(rate.toFixed(2));
};

// ========================================
// DERIVE OVERALL CONDITION
// ========================================
const deriveCondition = (
  healthyCount,
  damagedCount,
  deadCount,
  totalMonitored
) => {
  if (totalMonitored <= 0) {
    return "Healthy";
  }

  if (
    deadCount === totalMonitored
  ) {
    return "Dead";
  }

  if (
    damagedCount > 0 ||
    deadCount > 0
  ) {
    return "Damaged";
  }

  return "Healthy";
};

// ========================================
// GET LATEST MONITORING RECORD
// ========================================
const getLatestMonitoringRecord =
  async (plantingReportId) => {
    const snapshot =
      await monitoringCollection
        .where(
          "plantingReportId",
          "==",
          plantingReportId
        )
        .get();

    if (snapshot.empty) {
      return null;
    }

    const records =
      snapshot.docs.map(
        (doc) => ({
          id: doc.id,
          ...doc.data(),
        })
      );

    records.sort((a, b) => {
      const aTime =
        a.createdAt?.toMillis?.() ||
        0;

      const bTime =
        b.createdAt?.toMillis?.() ||
        0;

      return bTime - aTime;
    });

    return records[0];
  };

// ========================================
// CREATE MONITORING RECORD
// ========================================
const createMonitoringRecord =
  async (data) => {
    const plantingReportRef = db
      .collection(
        PLANTING_REPORT_COLLECTION
      )
      .doc(data.plantingReportId);

    const plantingReportDoc =
      await plantingReportRef.get();

    if (!plantingReportDoc.exists) {
      throw new Error(
        "Planting report not found."
      );
    }

    const plantingReport =
      plantingReportDoc.data();

    // Only approved planting reports
    // can be monitored.
    if (
      plantingReport.verificationStatus !==
      "Approved"
    ) {
      throw new Error(
        "Only approved planting reports can be monitored."
      );
    }

    // Participant can only monitor
    // their own planting report.
    if (
      data.requesterRole ===
        "participant" &&
      String(
        plantingReport.participantId ||
          ""
      ) !==
        String(data.monitoredBy || "")
    ) {
      throw new Error(
        "You can only monitor your own approved planting reports."
      );
    }

    const quantityPlanted =
      Number(
        plantingReport.quantityPlanted
      );

    if (
      !Number.isInteger(
        quantityPlanted
      ) ||
      quantityPlanted <= 0
    ) {
      throw new Error(
        "Planting report has an invalid planted quantity."
      );
    }

    const latestRecord =
      await getLatestMonitoringRecord(
        data.plantingReportId
      );

    if (
      latestRecord?.endOfMonitoring ===
      true
    ) {
      throw new Error(
        "Monitoring has already ended for this planting report."
      );
    }

    const healthyCount =
      Number(data.healthyCount);

    const damagedCount =
      Number(data.damagedCount);

    const deadCount =
      Number(data.deadCount);

    const totalMonitored =
      healthyCount +
      damagedCount +
      deadCount;

    if (
      totalMonitored !==
      quantityPlanted
    ) {
      throw new Error(
        "Healthy, damaged, and dead counts must equal the quantity planted."
      );
    }

    if (
      data.endOfMonitoring === true &&
      data.maturityStatus !== "Mature"
    ) {
      throw new Error(
        "Monitoring can only end when maturity status is Mature."
      );
    }

    const survivalRate =
      calculateSurvivalRate(
        healthyCount,
        damagedCount,
        quantityPlanted
      );

    const mortalityRate =
      Number(
        (
          (deadCount /
            quantityPlanted) *
          100
        ).toFixed(2)
      );

    const previousRound =
      latestRecord?.monitoringRound ||
      0;

    const now =
      Timestamp.now();

    const monitoringData = {
      plantingReportId:
        data.plantingReportId,

      distributionId:
        plantingReport.distributionId ||
        "",

      requestId:
        plantingReport.requestId || "",

      inventoryId:
        plantingReport.inventoryId ||
        "",

      participantId:
        plantingReport.participantId ||
        "",

      participantName:
        plantingReport.participantName ||
        "",

      organization:
        plantingReport.organization ||
        "",

      species:
        plantingReport.species || "",

      siteId:
        plantingReport.siteId || "",

      siteName:
        plantingReport.siteName || "",

      barangay:
        plantingReport.barangay || "",

      plantingLocation:
        plantingReport.plantingLocation ||
        plantingReport.siteName ||
        "",

      eventId:
        plantingReport.eventId || "",

      eventName:
        plantingReport.eventName || "",

      quantityPlanted,

      healthyCount,
      damagedCount,
      deadCount,

      survivingCount:
        healthyCount + damagedCount,

      totalMonitored,

      survivalRate,
      mortalityRate,

      condition:
        deriveCondition(
          healthyCount,
          damagedCount,
          deadCount,
          totalMonitored
        ),

      monitoringRound:
        previousRound + 1,

      monitoringDate:
        data.monitoringDate,

      nextMonitoringDate:
        data.nextMonitoringDate || "",

      latitude:
        data.latitude,

      longitude:
        data.longitude,

      accuracy:
        data.accuracy,

      locationCapturedAt:
        data.locationCapturedAt || "",

      remarks:
        data.remarks || "",

      photoName:
        data.photoName || "",

      photoType:
        data.photoType || "",

      photoSize:
        data.photoSize || 0,

      photoUrl:
        data.photoUrl || "",

      monitoredBy:
        data.monitoredBy,

      updatedBy: "",

      maturityStatus:
        data.maturityStatus,

      endOfMonitoring:
        data.endOfMonitoring,

      status:
        data.endOfMonitoring
          ? "Completed"
          : "Ongoing",

      reviewStatus:
        "Pending",

      reviewedBy: "",
      reviewedAt: null,

      archived: false,
      archivedAt: null,
      archivedBy: "",

      createdAt: now,
      updatedAt: now,
    };

    const docRef =
      await monitoringCollection.add(
        monitoringData
      );

    return {
      id: docRef.id,
      ...monitoringData,
    };
  };

// ========================================
// GET ALL MONITORING RECORDS
// ========================================
const getAllMonitoringRecords =
  async ({
    plantingReportId,
    participantId,
    status,
    maturityStatus,
    includeArchived = false,
  } = {}) => {
    const snapshot =
      await monitoringCollection.get();

    let records =
      snapshot.docs.map(
        (doc) => ({
          id: doc.id,
          ...doc.data(),
        })
      );

    if (!includeArchived) {
      records =
        records.filter(
          (record) =>
            record.archived !== true
        );
    }

    if (plantingReportId) {
      records =
        records.filter(
          (record) =>
            record.plantingReportId ===
            plantingReportId
        );
    }

    if (participantId) {
      records =
        records.filter(
          (record) =>
            record.participantId ===
            participantId
        );
    }

    if (status) {
      records =
        records.filter(
          (record) =>
            record.status === status
        );
    }

    if (maturityStatus) {
      records =
        records.filter(
          (record) =>
            record.maturityStatus ===
            maturityStatus
        );
    }

    records.sort((a, b) => {
      const aTime =
        a.createdAt?.toMillis?.() ||
        0;

      const bTime =
        b.createdAt?.toMillis?.() ||
        0;

      return bTime - aTime;
    });

    return records;
  };

// ========================================
// GET RECORD BY ID
// ========================================
const getMonitoringRecordById =
  async (id) => {
    const doc =
      await monitoringCollection
        .doc(id)
        .get();

    if (!doc.exists) {
      throw new Error(
        "Monitoring record not found."
      );
    }

    return {
      id: doc.id,
      ...doc.data(),
    };
  };

// ========================================
// GET PARTICIPANT RECORDS
// ========================================
const getMonitoringRecordsByParticipantId =
  async (participantId) => {
    return getAllMonitoringRecords({
      participantId,
    });
  };

// ========================================
// UPDATE MONITORING RECORD
// ========================================
const updateMonitoringRecord =
  async (id, data) => {
    const monitoringRef =
      monitoringCollection.doc(id);

    const monitoringDoc =
      await monitoringRef.get();

    if (!monitoringDoc.exists) {
      throw new Error(
        "Monitoring record not found."
      );
    }

    const currentRecord =
      monitoringDoc.data();

    if (
      currentRecord.archived === true
    ) {
      throw new Error(
        "Archived monitoring records cannot be updated."
      );
    }

    const quantityPlanted =
      Number(
        currentRecord.quantityPlanted
      );

    const healthyCount =
      data.healthyCount !==
      undefined
        ? Number(data.healthyCount)
        : currentRecord.healthyCount;

    const damagedCount =
      data.damagedCount !==
      undefined
        ? Number(data.damagedCount)
        : currentRecord.damagedCount;

    const deadCount =
      data.deadCount !== undefined
        ? Number(data.deadCount)
        : currentRecord.deadCount;

    const totalMonitored =
      healthyCount +
      damagedCount +
      deadCount;

    if (
      totalMonitored !==
      quantityPlanted
    ) {
      throw new Error(
        "Healthy, damaged, and dead counts must equal the quantity planted."
      );
    }

    const survivalRate =
      calculateSurvivalRate(
        healthyCount,
        damagedCount,
        quantityPlanted
      );

    const mortalityRate =
      Number(
        (
          (deadCount /
            quantityPlanted) *
          100
        ).toFixed(2)
      );

    const maturityStatus =
      data.maturityStatus ??
      currentRecord.maturityStatus;

    const endOfMonitoring =
      data.endOfMonitoring ??
      currentRecord.endOfMonitoring;

    if (
      endOfMonitoring === true &&
      maturityStatus !== "Mature"
    ) {
      throw new Error(
        "Monitoring can only end when maturity status is Mature."
      );
    }

    const updateData = {
      healthyCount,
      damagedCount,
      deadCount,

      survivingCount:
        healthyCount +
        damagedCount,

      totalMonitored,

      survivalRate,
      mortalityRate,

      condition:
        deriveCondition(
          healthyCount,
          damagedCount,
          deadCount,
          totalMonitored
        ),

      monitoringDate:
        data.monitoringDate ??
        currentRecord.monitoringDate,

      nextMonitoringDate:
        data.nextMonitoringDate ??
        currentRecord
          .nextMonitoringDate ??
        "",

      remarks:
        data.remarks ??
        currentRecord.remarks,

      maturityStatus,

      endOfMonitoring,

      status:
        endOfMonitoring
          ? "Completed"
          : "Ongoing",

      updatedBy:
        data.updatedBy,

      updatedAt:
        Timestamp.now(),
    };

    await monitoringRef.update(
      updateData
    );

    const updatedDoc =
      await monitoringRef.get();

    return {
      id: updatedDoc.id,
      ...updatedDoc.data(),
    };
  };

// ========================================
// REVIEW MONITORING RECORD
// ========================================
const reviewMonitoringRecord =
  async (id, reviewedBy) => {
    const monitoringRef =
      monitoringCollection.doc(id);

    const monitoringDoc =
      await monitoringRef.get();

    if (!monitoringDoc.exists) {
      throw new Error(
        "Monitoring record not found."
      );
    }

    if (
      monitoringDoc.data()
        .archived === true
    ) {
      throw new Error(
        "Archived monitoring records cannot be reviewed."
      );
    }

    const now =
      Timestamp.now();

    await monitoringRef.update({
      reviewStatus:
        "Reviewed",

      reviewedBy,

      reviewedAt: now,

      updatedBy:
        reviewedBy,

      updatedAt: now,
    });

    const updatedDoc =
      await monitoringRef.get();

    return {
      id: updatedDoc.id,
      ...updatedDoc.data(),
    };
  };

// ========================================
// ARCHIVE MONITORING RECORD
// ========================================
const archiveMonitoringRecord =
  async (id, archivedBy) => {
    const monitoringRef =
      monitoringCollection.doc(id);

    const monitoringDoc =
      await monitoringRef.get();

    if (!monitoringDoc.exists) {
      throw new Error(
        "Monitoring record not found."
      );
    }

    const now =
      Timestamp.now();

    await monitoringRef.update({
      archived: true,

      archivedAt: now,

      archivedBy,

      updatedBy:
        archivedBy,

      updatedAt: now,
    });

    const updatedDoc =
      await monitoringRef.get();

    return {
      id: updatedDoc.id,
      ...updatedDoc.data(),
    };
  };

module.exports = {
  createMonitoringRecord,
  getAllMonitoringRecords,
  getMonitoringRecordById,
  getMonitoringRecordsByParticipantId,
  updateMonitoringRecord,
  reviewMonitoringRecord,
  archiveMonitoringRecord,
};