const {
  createPlantingReport,
  getAllPlantingReports,
  getPlantingReportById,
  getPlantingReportsByParticipantId,
  approvePlantingReport,
  rejectPlantingReport,
  getPlantingReportVerificationLogs,
} = require(
  "../services/plantingReport.service"
);
const { finalizeParent } = require("../services/parentPlantingReport.service");


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
      inventoryId,
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
      !plantingLocation
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
    // Testing: device GPS may be unavailable even when the image is valid.
    const hasLatitude = latitude !== undefined && latitude !== null && latitude !== "";
    const hasLongitude = longitude !== undefined && longitude !== null && longitude !== "";
    const rawLatitude = hasLatitude ? Number(latitude) : null;


    // --------------------------------
    // LONGITUDE
    // --------------------------------
    const rawLongitude = hasLongitude ? Number(longitude) : null;
    const validCapturedGps = hasLatitude && hasLongitude &&
      Number.isFinite(rawLatitude) && rawLatitude >= -90 && rawLatitude <= 90 &&
      Number.isFinite(rawLongitude) && rawLongitude >= -180 && rawLongitude <= 180;
    const parsedLatitude = validCapturedGps ? rawLatitude : null;
    const parsedLongitude = validCapturedGps ? rawLongitude : null;


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
        parsedAccuracy = null;
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
          inventoryId,
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
      report.automatedVerificationStatus ===
      "Passed Automated Check"
    ) {
      message =
        "Planting report submitted successfully and passed the automated verification check.";
    }

    if (
      report.automatedVerificationStatus ===
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
      "Selected event does not match the released distribution.",
      "Selected planting site does not match the released distribution.",
      "A valid planting date is required.",
      "Select a released seedling item for this submission.",
      "Seedling item has not been released for this event.",
      "Quantity planted exceeds the remaining event allocation.",
      "Requester has already submitted planting evidence for this event.",
      "This planting report has already been finalized.",
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

    if (verificationStatus && !["Draft", "Pending", "Pending Review", "Approved", "Rejected"].includes(verificationStatus)) {
      return res.status(400).json({ success: false, message: "Invalid planting report status filter." });
    }

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

    if (req.user.role === "participant" && report.participantId !== req.user.uid) {
      return res.status(404).json({ success: false, message: "Planting report not found." });
    }

    return res.status(200).json({
      success: true,
      data: report,
    });
  } catch (error) {
    const expectedError = ["Planting report not found.", "Invalid planting report ID."].includes(error.message);
    if (!expectedError) console.error(error);

    return res.status(error.message === "Planting report not found." ? 404 : expectedError ? 400 : 500).json({
      success: false,
      message: expectedError
        ? error.message
        : "Failed to retrieve planting report.",
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

const finalizeReport = async (req, res) => {
  try {
    const report = await finalizeParent(req.params.id, req.user.uid);
    return res.status(200).json({ success: true, message: "Planting report submitted for review.", data: report });
  } catch (error) {
    const expected = ["Planting report not found.", "Only pending planting reports can be submitted for review.",
      "The report has no recorded planting contributions.",
      "Every planting contribution needs evidence photos before finalization.",
      "Requester planting evidence is required before review."].includes(error.message);
    if (!expected) console.error(error);
    return res.status(error.message === "Planting report not found." ? 404 : expected ? 409 : 500).json({
      success: false, message: expected ? error.message : "Failed to finalize planting report.",
    });
  }
};


// STAFF APPROVE REPORT
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

    if (typeof remarks !== "string") {
      return res.status(400).json({ success: false, message: "Approval remarks must be text." });
    }

    const report =
      await approvePlantingReport(
        id,
        approvedBy,
        remarks,
        req.user.fullName
      );

    return res.status(200).json({
      success: true,
      message:
        "Planting report approved successfully.",
      data: report,
    });
  } catch (error) {
    const statusCode = error.message === "Planting report not found."
      ? 404
      : error.message === "Invalid planting report ID."
        ? 400
        : error.message === "Only pending review planting reports can be approved."
          ? 409
          : 500;
    if (statusCode === 500) console.error(error);

    return res.status(
      statusCode
    ).json({
      success: false,
      message: statusCode === 500 ? "Failed to approve planting report." : error.message,
    });
  }
};


// STAFF REJECT REPORT
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

    if (typeof remarks !== "string" || !remarks.trim()) {
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
        remarks,
        req.user.fullName
      );

    return res.status(200).json({
      success: true,
      message:
        "Planting report rejected successfully.",
      data: report,
    });
  } catch (error) {
    const statusCode = error.message === "Planting report not found."
      ? 404
      : error.message === "Invalid planting report ID."
        ? 400
        : error.message === "Only pending review planting reports can be rejected."
          ? 409
          : error.message === "Rejection reason is required."
            ? 400
            : 500;
    if (statusCode === 500) console.error(error);

    return res.status(
      statusCode
    ).json({
      success: false,
      message: statusCode === 500 ? "Failed to reject planting report." : error.message,
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
    const statusCode = error.message === "Planting report not found."
      ? 404
      : error.message === "Invalid planting report ID."
        ? 400
        : 500;
    if (statusCode === 500) console.error(error);

    return res.status(
      statusCode
    ).json({
      success: false,
      message: statusCode === 500 ? "Failed to retrieve verification logs." : error.message,
    });
  }
};


module.exports = {
  submitPlantingReport,
  getPlantingReports,
  getPlantingReport,
  getMyPlantingReports,
  finalizeReport,
  approveReport,
  rejectReport,
  getVerificationLogs,
};
