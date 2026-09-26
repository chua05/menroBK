const {
  createPlantingReport,
  getAllPlantingReports,
  getPlantingReportById,
  getPlantingReportsByParticipantId,
  participantSafeReport,
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

      quantityPlanted,
      plantingDate,
      plantingLocation,

      eventId,
      eventName,

      locationSource,
      latitude,
      longitude,
      accuracy,
      photoCapturedAt,
      locationCapturedAt,

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
      !eventId ||
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
          "Please enter a valid quantity of planted saplings.",
      });
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

          participantName:
            req.user.fullName || "",

          participantType:
            req.user.userType || "",

          participantBarangay:
            req.user.barangay || "",

          organizationAffiliation:
            req.user.affiliationName ||
            req.user.userTypeDetail ||
            req.user.organization ||
            req.user.barangay ||
            "",

          participantContactNumber:
            req.user.contactNumber || "",

          quantityPlanted:
            parsedQuantity,

          plantingDate,

          plantingLocation,

          eventId:
            eventId || "",

          eventName:
            eventName || "",

          locationSource:
            locationSource || "Photo Metadata (EXIF)",

          latitude,
          longitude,
          accuracy,
          photoCapturedAt,
          locationCapturedAt,

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
      "Only released distributions can have planting reports.",
      "Please enter a valid quantity of planted saplings.",
      "The quantity planted cannot exceed the remaining released sapling quantity.",
      "The linked distribution has an invalid released quantity.",
      "A planting report already exists for this distribution.",
      "Duplicate planting image detected.",
      "Duplicate evidence photos were detected in this submission.",
      "At least one planting evidence photo is required.",
      "A maximum of 10 planting evidence photos is allowed.",
      "The uploaded file is not a valid image.",
      "This photo does not contain GPS location metadata. Please upload an original geotagged photo with location information.",
      "This photo contains invalid GPS coordinates. Please upload an original geotagged photo with valid location information.",
      "Screenshot images are not accepted as planting evidence. Please upload the original geotagged photo.",
      "The selected planting site is inactive.",
      "The selected planting site has invalid coordinates.",
      "Selected event does not match the released distribution.",
      "Selected planting site does not match the released distribution.",
      "A valid planting date is required.",
      "Select a released sapling tree item for this submission.",
      "Sapling tree item has not been released for this event.",
      "Quantity planted exceeds the remaining event allocation.",
      "This planting report has already been finalized.",
      "Latitude must be between -90 and 90.",
      "Longitude must be between -180 and 180.",
      "A valid device location and capture timestamp are required for a photo taken within the system.",
      "Selected planting event was not found.",
      "The selected planting event is archived.",
      "The selected planting event has been cancelled.",
      "The selected planting event is not available for planting reports.",
      "The selected planting event does not belong to the selected planting site.",
      "The selected planting event does not belong to the selected barangay.",
    ];

    const statusCode =
      error.message === "You are not registered for the selected planting event."
        ? 403
        : notFoundErrors.includes(
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

    const isParticipantContributor = report.submissions?.some(
      (submission) => submission.contributorId === req.user.uid
    );
    if (req.user.role === "participant" &&
        report.participantId !== req.user.uid &&
        !isParticipantContributor) {
      return res.status(404).json({ success: false, message: "Planting report not found." });
    }

    const responseReport = req.user.role === "participant"
      ? participantSafeReport(report, req.user.uid)
      : report;

    return res.status(200).json({
      success: true,
      data: responseReport,
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
