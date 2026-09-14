const fs = require("fs");

const {
  createMonitoringRecord,
  getAllMonitoringRecords,
  getMonitoringRecordById,
  getMonitoringRecordsByParticipantId,
  updateMonitoringRecord,
  reviewMonitoringRecord,
  archiveMonitoringRecord,
} = require(
  "../services/monitoring.service"
);

// ========================================
// BOOLEAN PARSER
// ========================================
function parseBoolean(value) {
  if (
    value === true ||
    value === "true"
  ) {
    return true;
  }

  if (
    value === false ||
    value === "false" ||
    value === undefined
  ) {
    return false;
  }

  return null;
}

// ========================================
// REMOVE UPLOADED FILE ON ERROR
// ========================================
function removeUploadedFile(file) {
  if (!file?.path) {
    return;
  }

  fs.unlink(file.path, () => {});
}

// ========================================
// CREATE MONITORING RECORD
// ========================================
const addMonitoringRecord =
  async (req, res) => {
    try {
      const {
        plantingReportId,
        healthyCount,
        damagedCount,
        deadCount,
        monitoringDate,
        nextMonitoringDate,
        maturityStatus,
        remarks,
        latitude,
        longitude,
        accuracy,
        locationCapturedAt,
      } = req.body || {};

      const endOfMonitoring =
        parseBoolean(
          req.body?.endOfMonitoring
        );

      if (
        !plantingReportId ||
        healthyCount === undefined ||
        damagedCount === undefined ||
        deadCount === undefined ||
        !monitoringDate ||
        !maturityStatus
      ) {
        removeUploadedFile(
          req.file
        );

        return res
          .status(400)
          .json({
            success: false,
            message:
              "All required monitoring fields must be provided.",
          });
      }

      const counts = [
        healthyCount,
        damagedCount,
        deadCount,
      ].map(Number);

      if (
        counts.some(
          (count) =>
            !Number.isInteger(
              count
            ) ||
            count < 0
        )
      ) {
        removeUploadedFile(
          req.file
        );

        return res
          .status(400)
          .json({
            success: false,
            message:
              "Healthy, damaged, and dead counts must be non-negative integers.",
          });
      }

      const allowedMaturityStatuses =
        [
          "Immature",
          "Mature",
        ];

      if (
        !allowedMaturityStatuses.includes(
          maturityStatus
        )
      ) {
        removeUploadedFile(
          req.file
        );

        return res
          .status(400)
          .json({
            success: false,
            message:
              "Maturity status must be either Immature or Mature.",
          });
      }

      if (
        endOfMonitoring === null
      ) {
        removeUploadedFile(
          req.file
        );

        return res
          .status(400)
          .json({
            success: false,
            message:
              "endOfMonitoring must be a boolean.",
          });
      }

      if (
        endOfMonitoring &&
        maturityStatus !== "Mature"
      ) {
        removeUploadedFile(
          req.file
        );

        return res
          .status(400)
          .json({
            success: false,
            message:
              "Monitoring can only end when maturity status is Mature.",
          });
      }

      const parsedMonitoringDate =
        new Date(monitoringDate);

      if (
        Number.isNaN(
          parsedMonitoringDate.getTime()
        )
      ) {
        removeUploadedFile(
          req.file
        );

        return res
          .status(400)
          .json({
            success: false,
            message:
              "Invalid monitoring date.",
          });
      }

      if (
        parsedMonitoringDate >
        new Date()
      ) {
        removeUploadedFile(
          req.file
        );

        return res
          .status(400)
          .json({
            success: false,
            message:
              "Monitoring date cannot be in the future.",
          });
      }

      if (!req.file) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "A monitoring photo is required.",
          });
      }

      const parsedLatitude =
        Number(latitude);

      const parsedLongitude =
        Number(longitude);

      const parsedAccuracy =
        Number(accuracy);

      if (
        !Number.isFinite(
          parsedLatitude
        ) ||
        parsedLatitude < -90 ||
        parsedLatitude > 90 ||
        !Number.isFinite(
          parsedLongitude
        ) ||
        parsedLongitude < -180 ||
        parsedLongitude > 180
      ) {
        removeUploadedFile(
          req.file
        );

        return res
          .status(400)
          .json({
            success: false,
            message:
              "A valid GPS location is required.",
          });
      }

      if (!locationCapturedAt) {
        removeUploadedFile(
          req.file
        );

        return res
          .status(400)
          .json({
            success: false,
            message:
              "GPS capture time is required.",
          });
      }

      const record =
        await createMonitoringRecord({
          plantingReportId,

          healthyCount:
            counts[0],

          damagedCount:
            counts[1],

          deadCount:
            counts[2],

          monitoringDate,

          nextMonitoringDate:
            nextMonitoringDate ||
            "",

          maturityStatus,

          endOfMonitoring,

          remarks:
            remarks || "",

          latitude:
            parsedLatitude,

          longitude:
            parsedLongitude,

          accuracy:
            Number.isFinite(
              parsedAccuracy
            )
              ? parsedAccuracy
              : null,

          locationCapturedAt,

          photoName:
            req.file.originalname,

          photoType:
            req.file.mimetype,

          photoSize:
            req.file.size,

          photoUrl:
            `/uploads/monitoring/${req.file.filename}`,

          monitoredBy:
            req.user.uid,

          requesterRole:
            req.user.role,
        });

      return res
        .status(201)
        .json({
          success: true,

          message:
            "Monitoring record created successfully.",

          data: record,
        });
    } catch (error) {
      console.error(error);

      removeUploadedFile(
        req.file
      );

      const notFound =
        error.message ===
          "Planting report not found." ||
        error.message ===
          "Monitoring record not found.";

      return res
        .status(
          notFound ? 404 : 400
        )
        .json({
          success: false,
          message:
            error.message,
        });
    }
  };

// ========================================
// GET ALL RECORDS
// ========================================
const getMonitoringRecords =
  async (req, res) => {
    try {
      const {
        plantingReportId,
        participantId,
        status,
        maturityStatus,
      } = req.query;

      const records =
        await getAllMonitoringRecords({
          plantingReportId,
          participantId,
          status,
          maturityStatus,
        });

      return res
        .status(200)
        .json({
          success: true,
          data: records,
        });
    } catch (error) {
      console.error(error);

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Failed to retrieve monitoring records.",
        });
    }
  };

// ========================================
// GET RECORD BY ID
// ========================================
const getMonitoringRecord =
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const record =
        await getMonitoringRecordById(
          id
        );

      return res
        .status(200)
        .json({
          success: true,
          data: record,
        });
    } catch (error) {
      console.error(error);

      return res
        .status(404)
        .json({
          success: false,
          message:
            error.message,
        });
    }
  };

// ========================================
// PARTICIPANT: OWN RECORDS
// ========================================
const getMyMonitoringRecords =
  async (req, res) => {
    try {
      const records =
        await getMonitoringRecordsByParticipantId(
          req.user.uid
        );

      return res
        .status(200)
        .json({
          success: true,
          data: records,
        });
    } catch (error) {
      console.error(error);

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Failed to retrieve your monitoring records.",
        });
    }
  };

// ========================================
// UPDATE MONITORING RECORD
// ========================================
const updateMonitoring =
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        healthyCount,
        damagedCount,
        deadCount,
        monitoringDate,
        nextMonitoringDate,
        maturityStatus,
        endOfMonitoring,
        remarks,
      } = req.body || {};

      if (
        healthyCount === undefined &&
        damagedCount === undefined &&
        deadCount === undefined &&
        monitoringDate ===
          undefined &&
        nextMonitoringDate ===
          undefined &&
        maturityStatus ===
          undefined &&
        endOfMonitoring ===
          undefined &&
        remarks === undefined
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "No monitoring fields provided.",
          });
      }

      const updateData = {
        updatedBy:
          req.user.uid,
      };

      const countFields = {
        healthyCount,
        damagedCount,
        deadCount,
      };

      for (
        const [
          key,
          value,
        ] of Object.entries(
          countFields
        )
      ) {
        if (
          value !== undefined
        ) {
          const parsedValue =
            Number(value);

          if (
            !Number.isInteger(
              parsedValue
            ) ||
            parsedValue < 0
          ) {
            return res
              .status(400)
              .json({
                success: false,
                message:
                  "Healthy, damaged, and dead counts must be non-negative integers.",
              });
          }

          updateData[key] =
            parsedValue;
        }
      }

      if (
        maturityStatus !==
        undefined
      ) {
        const allowedStatuses =
          [
            "Immature",
            "Mature",
          ];

        if (
          !allowedStatuses.includes(
            maturityStatus
          )
        ) {
          return res
            .status(400)
            .json({
              success: false,
              message:
                "Maturity status must be either Immature or Mature.",
            });
        }

        updateData.maturityStatus =
          maturityStatus;
      }

      if (
        endOfMonitoring !==
        undefined
      ) {
        if (
          typeof endOfMonitoring !==
          "boolean"
        ) {
          return res
            .status(400)
            .json({
              success: false,
              message:
                "endOfMonitoring must be a boolean.",
            });
        }

        updateData.endOfMonitoring =
          endOfMonitoring;
      }

      if (
        monitoringDate !==
        undefined
      ) {
        const parsedDate =
          new Date(
            monitoringDate
          );

        if (
          Number.isNaN(
            parsedDate.getTime()
          )
        ) {
          return res
            .status(400)
            .json({
              success: false,
              message:
                "Invalid monitoring date.",
            });
        }

        if (
          parsedDate >
          new Date()
        ) {
          return res
            .status(400)
            .json({
              success: false,
              message:
                "Monitoring date cannot be in the future.",
            });
        }

        updateData.monitoringDate =
          monitoringDate;
      }

      if (
        nextMonitoringDate !==
        undefined
      ) {
        updateData.nextMonitoringDate =
          nextMonitoringDate;
      }

      if (
        remarks !== undefined
      ) {
        updateData.remarks =
          remarks;
      }

      const record =
        await updateMonitoringRecord(
          id,
          updateData
        );

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Monitoring record updated successfully.",

          data: record,
        });
    } catch (error) {
      console.error(error);

      const statusCode =
        error.message ===
        "Monitoring record not found."
          ? 404
          : 400;

      return res
        .status(statusCode)
        .json({
          success: false,
          message:
            error.message,
        });
    }
  };

// ========================================
// REVIEW RECORD
// ========================================
const reviewMonitoring =
  async (req, res) => {
    try {
      const record =
        await reviewMonitoringRecord(
          req.params.id,
          req.user.uid
        );

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Monitoring record marked as reviewed.",

          data: record,
        });
    } catch (error) {
      console.error(error);

      return res
        .status(
          error.message ===
          "Monitoring record not found."
            ? 404
            : 400
        )
        .json({
          success: false,
          message:
            error.message,
        });
    }
  };

// ========================================
// ARCHIVE RECORD
// ========================================
const archiveMonitoring =
  async (req, res) => {
    try {
      const record =
        await archiveMonitoringRecord(
          req.params.id,
          req.user.uid
        );

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Monitoring record archived.",

          data: record,
        });
    } catch (error) {
      console.error(error);

      return res
        .status(
          error.message ===
          "Monitoring record not found."
            ? 404
            : 400
        )
        .json({
          success: false,
          message:
            error.message,
        });
    }
  };

module.exports = {
  addMonitoringRecord,
  getMonitoringRecords,
  getMonitoringRecord,
  getMyMonitoringRecords,
  updateMonitoring,
  reviewMonitoring,
  archiveMonitoring,
};