const {
  createPlantingReport,
  getAllPlantingReports,
  getPlantingReportById,
  getPlantingReportsByParticipantId,
} = require(
  "../services/plantingReport.service"
);

// SUBMIT PLANTING REPORT
const submitPlantingReport = async (
  req,
  res
) => {
  try {
    const participantId =
      req.user.uid;

    const {
      distributionId,
      quantityPlanted,
      plantingDate,
      plantingLocation,
      latitude,
      longitude,
      remarks,
    } = req.body || {};

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message:
          "Planting photo is required.",
      });
    }

    if (
      !distributionId ||
      quantityPlanted === undefined ||
      !plantingDate ||
      !plantingLocation ||
      latitude === undefined ||
      longitude === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "All planting report fields are required.",
      });
    }

    const parsedQuantity =
      Number(quantityPlanted);

    const parsedLatitude =
      Number(latitude);

    const parsedLongitude =
      Number(longitude);

    if (
      !Number.isInteger(
        parsedQuantity
      ) ||
      parsedQuantity <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity planted must be a positive integer.",
      });
    }

    if (
      Number.isNaN(parsedLatitude) ||
      parsedLatitude < -90 ||
      parsedLatitude > 90
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Latitude must be between -90 and 90.",
      });
    }

    if (
      Number.isNaN(parsedLongitude) ||
      parsedLongitude < -180 ||
      parsedLongitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Longitude must be between -180 and 180.",
      });
    }

    const report =
      await createPlantingReport(
        {
          distributionId,
          participantId,

          quantityPlanted:
            parsedQuantity,

          plantingDate,
          plantingLocation,

          latitude:
            parsedLatitude,

          longitude:
            parsedLongitude,

          remarks,
        },
        req.file
      );

    return res.status(201).json({
      success: true,
      message:
        "Planting report submitted successfully.",
      data: report,
    });
  } catch (error) {
    console.error(error);

    const knownErrors = [
      "Distribution record not found.",
      "You cannot submit a report for another participant's distribution.",
      "Only released distributions can have planting reports.",
      "Quantity planted cannot exceed the released quantity.",
      "A planting report already exists for this distribution.",
      "Duplicate planting image detected.",
      "The uploaded file is not a valid image.",
    ];

    const statusCode =
      error.message ===
      "Distribution record not found."
        ? 404
        : knownErrors.includes(
            error.message
          )
        ? 400
        : 500;

    return res.status(statusCode).json({
      success: false,
      message: error.message,
    });
  }
};

// GET ALL REPORTS
const getPlantingReports = async (
  req,
  res
) => {
  try {
    const {
      verificationStatus,
      participantId,
      distributionId,
    } = req.query;

    const reports =
      await getAllPlantingReports({
        verificationStatus,
        participantId,
        distributionId,
      });

    return res.status(200).json({
      success: true,
      data: reports,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message:
        "Failed to retrieve planting reports.",
    });
  }
};

// GET REPORT BY ID
const getPlantingReport = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const report =
      await getPlantingReportById(
        id
      );

    return res.status(200).json({
      success: true,
      data: report,
    });
  } catch (error) {
    console.error(error);

    return res.status(404).json({
      success: false,
      message: error.message,
    });
  }
};

// GET MY REPORTS
const getMyPlantingReports = async (
  req,
  res
) => {
  try {
    const reports =
      await getPlantingReportsByParticipantId(
        req.user.uid
      );

    return res.status(200).json({
      success: true,
      data: reports,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message:
        "Failed to retrieve your planting reports.",
    });
  }
};

module.exports = {
  submitPlantingReport,
  getPlantingReports,
  getPlantingReport,
  getMyPlantingReports,
};