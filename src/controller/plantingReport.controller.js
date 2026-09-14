const {
  createPlantingReport,
  getAllPlantingReports,
  getPlantingReportById,
  getPlantingReportsByParticipantId,
  reviewPlantingReport,
  approvePlantingReport,
  rejectPlantingReport,
  getPlantingReportVerificationLogs,
} = require(
  "../services/plantingReport.service"
);


// --------------------------------
// NORMALIZE UPLOADED PHOTOS
//
// Supports:
//
// New:
// req.files.photos
//
// Temporary backward compatibility:
// req.files.photo
// req.file
// --------------------------------
const getUploadedPlantingPhotos = (
  req
) => {
  const photos = [];

  if (
    Array.isArray(
      req.files?.photos
    )
  ) {
    photos.push(
      ...req.files.photos
    );
  }

  if (
    Array.isArray(
      req.files?.photo
    )
  ) {
    photos.push(
      ...req.files.photo
    );
  }

  if (req.file) {
    photos.push(req.file);
  }

  return photos;
};


// SUBMIT PLANTING REPORT
const submitPlantingReport = async (
  req,
  res
) => {
  try {
    // Always derive the account identity
    // from the verified Firebase token.
    const participantId =
      req.user.uid;

    const {
      distributionId,
      siteId,

      participantType,
      participantBarangay,
      organizationAffiliation,

      quantityPlanted,
      plantingDate,
      plantingLocation,

      latitude,
      longitude,
      accuracy,
      locationCapturedAt,

      eventId,
      eventName,

      remarks,
    } = req.body || {};


    // --------------------------------
    // EVIDENCE PHOTOS
    // --------------------------------
    const photos =
      getUploadedPlantingPhotos(
        req
      );

    if (
      photos.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please add at least one planting evidence photo before submitting the report.",
      });
    }

    if (
      photos.length > 10
    ) {
      return res.status(400).json({
        success: false,
        message:
          "A maximum of 10 planting evidence photos is allowed.",
      });
    }


    // --------------------------------
    // REQUIRED FIELDS
    // --------------------------------
    if (
      !distributionId ||
      !siteId ||
      !participantType ||
      !participantBarangay ||
      quantityPlanted ===
        undefined ||
      !plantingDate ||
      !plantingLocation ||
      latitude === undefined ||
      longitude === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please complete all required planting report fields.",
      });
    }


    // --------------------------------
    // QUANTITY
    // --------------------------------
    const parsedQuantity =
      Number(quantityPlanted);

    if (
      !Number.isInteger(
        parsedQuantity
      ) ||
      parsedQuantity <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity planted must be at least 1.",
      });
    }


    // --------------------------------
    // LATITUDE
    // --------------------------------
    const parsedLatitude =
      Number(latitude);

    if (
      Number.isNaN(
        parsedLatitude
      ) ||
      parsedLatitude < -90 ||
      parsedLatitude > 90
    ) {
      return res.status(400).json({
        success: false,
        message:
          "The captured latitude is invalid.",
      });
    }


    // --------------------------------
    // LONGITUDE
    // --------------------------------
    const parsedLongitude =
      Number(longitude);

    if (
      Number.isNaN(
        parsedLongitude
      ) ||
      parsedLongitude < -180 ||
      parsedLongitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message:
          "The captured longitude is invalid.",
      });
    }


    // --------------------------------
    // OPTIONAL GPS ACCURACY
    // --------------------------------
    let parsedAccuracy = null;

    if (
      accuracy !== undefined &&
      accuracy !== null &&
      accuracy !== ""
    ) {
      parsedAccuracy =
        Number(accuracy);

      if (
        !Number.isFinite(
          parsedAccuracy
        ) ||
        parsedAccuracy < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "The captured GPS accuracy is invalid.",
        });
      }
    }


    // --------------------------------
    // LOCATION CAPTURE TIME
    // --------------------------------
    if (locationCapturedAt) {
      const capturedDate =
        new Date(
          locationCapturedAt
        );

      if (
        Number.isNaN(
          capturedDate.getTime()
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "The location capture timestamp is invalid.",
        });
      }
    }


    // --------------------------------
    // CREATE REPORT
    // --------------------------------
    const report =
      await createPlantingReport(
        {
          distributionId,
          siteId,
          participantId,

          participantType:
            String(
              participantType
            ).trim(),

          participantBarangay:
            String(
              participantBarangay
            ).trim(),

          organizationAffiliation:
            organizationAffiliation
              ? String(
                  organizationAffiliation
                ).trim()
              : "",

          quantityPlanted:
            parsedQuantity,

          plantingDate,

          plantingLocation,

          latitude:
            parsedLatitude,

          longitude:
            parsedLongitude,

          accuracy:
            parsedAccuracy,

          locationCapturedAt:
            locationCapturedAt ||
            null,

          eventId:
            eventId || "",

          eventName:
            eventName || "",

          remarks:
            remarks || "",
        },
        photos
      );


    // --------------------------------
    // INFORMATIVE SUCCESS MESSAGE
    // --------------------------------
    let message =
      "Planting report submitted successfully.";

    if (
      report.verificationStatus ===
      "Passed Automated Check"
    ) {
      message =
        "Planting report submitted successfully and passed the automated verification check.";
    }

    if (
      report.verificationStatus ===
      "Flagged"
    ) {
      message =
        "Planting report submitted successfully, but some verification checks were flagged for staff review.";
    }


    return res.status(201).json({
      success: true,
      message,
      data: report,
    });
  } catch (error) {
    console.error(
      "Submit planting report error:",
      error
    );

    const notFoundErrors = [
      "Distribution record not found.",
      "Planting site not found.",
    ];

    const validationErrors = [
      "You cannot submit a report for another participant's distribution.",
      "Only released distributions can have planting reports.",
      "Quantity planted must be a positive integer.",
      "Quantity planted cannot exceed the released quantity.",
      "The linked distribution has an invalid released quantity.",
      "A planting report already exists for this distribution.",
      "Duplicate planting image detected.",
      "Duplicate evidence photos were detected in this submission.",
      "At least one planting evidence photo is required.",
      "A maximum of 10 planting evidence photos is allowed.",
      "The uploaded file is not a valid image.",
      "The selected planting site is inactive.",
      "The selected planting site has invalid coordinates.",
      "Latitude must be between -90 and 90.",
      "Longitude must be between -180 and 180.",
    ];

    const statusCode =
      notFoundErrors.includes(
        error.message
      )
        ? 404
        : validationErrors.includes(
            error.message
          )
        ? 400
        : 500;

    return res.status(
      statusCode
    ).json({
      success: false,
      message:
        statusCode === 500
          ? "Failed to submit planting report. Please try again."
          : error.message,
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
const getMyPlantingReports =
  async (req, res) => {
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


// STAFF REVIEW REPORT
const reviewReport = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const reviewedBy =
      req.user.uid;

    const {
      remarks = "",
    } = req.body || {};

    const report =
      await reviewPlantingReport(
        id,
        reviewedBy,
        remarks
      );

    return res.status(200).json({
      success: true,
      message:
        "Planting report reviewed successfully.",
      data: report,
    });
  } catch (error) {
    console.error(error);

    const statusCode =
      error.message ===
      "Planting report not found."
        ? 404
        : 400;

    return res.status(
      statusCode
    ).json({
      success: false,
      message: error.message,
    });
  }
};


// ADMIN APPROVE REPORT
const approveReport = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const approvedBy =
      req.user.uid;

    const {
      remarks = "",
    } = req.body || {};

    const report =
      await approvePlantingReport(
        id,
        approvedBy,
        remarks
      );

    return res.status(200).json({
      success: true,
      message:
        "Planting report approved successfully.",
      data: report,
    });
  } catch (error) {
    console.error(error);

    const statusCode =
      error.message ===
      "Planting report not found."
        ? 404
        : 400;

    return res.status(
      statusCode
    ).json({
      success: false,
      message: error.message,
    });
  }
};


// ADMIN REJECT REPORT
const rejectReport = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const rejectedBy =
      req.user.uid;

    const {
      remarks = "",
    } = req.body || {};

    if (
      !String(
        remarks
      ).trim()
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter a reason for rejecting the planting report.",
      });
    }

    const report =
      await rejectPlantingReport(
        id,
        rejectedBy,
        remarks
      );

    return res.status(200).json({
      success: true,
      message:
        "Planting report rejected successfully.",
      data: report,
    });
  } catch (error) {
    console.error(error);

    const statusCode =
      error.message ===
      "Planting report not found."
        ? 404
        : 400;

    return res.status(
      statusCode
    ).json({
      success: false,
      message: error.message,
    });
  }
};


// GET VERIFICATION LOGS
const getVerificationLogs = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const logs =
      await getPlantingReportVerificationLogs(
        id
      );

    return res.status(200).json({
      success: true,
      data: logs,
    });
  } catch (error) {
    console.error(error);

    const statusCode =
      error.message ===
      "Planting report not found."
        ? 404
        : 500;

    return res.status(
      statusCode
    ).json({
      success: false,
      message: error.message,
    });
  }
};


module.exports = {
  submitPlantingReport,
  getPlantingReports,
  getPlantingReport,
  getMyPlantingReports,
  reviewReport,
  approveReport,
  rejectReport,
  getVerificationLogs,
};