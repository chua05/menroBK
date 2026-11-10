const {
  createPlantingReport,
  getAllPlantingReports,
  getPlantingReportById,
  getPlantingReportsByParticipantId,
  participantSafeReport,
  participantCanAccessReport,
  approvePlantingReport,
  rejectPlantingReport,
  forwardPlantingReport,
  returnPlantingReport,
  getPlantingReportVerificationLogs,
} = require(
  "../services/plantingReport.service"
);
const { finalizeParent } = require("../services/parentPlantingReport.service");

const PARTICIPANT_SECTORS = new Set([
  "Barangay Official", "Volunteer", "Organization Member",
  "Student / School Representative", "Government Employee",
  "Private Sector Representative", "Other",
]);


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
      barangay,

      quantityPlanted,
      leftoverQuantity,
      plantingDate,
      plantingLocation,

      eventId,
      eventName,

      remarks,
      submittedByName,
      submittedBySector,
      submittedByContactNumber,
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
        fieldErrors: { photos: "Add at least one verified planting evidence photo." },
      });
    }

    if (
      photos.length > 10
    ) {
      return res.status(400).json({
        success: false,
        message:
          "A maximum of 10 planting evidence photos is allowed.",
        fieldErrors: { photos: "A maximum of 10 planting evidence photos is allowed." },
      });
    }

    // A final planting report sends every released type in `items`; the
    // backend computes Planted = Remaining - Leftovers per type.
    const finalItems = req.body?.items !== undefined && req.body?.items !== "" ? req.body.items : undefined;

    // --------------------------------
    // REQUIRED FIELDS
    // --------------------------------
    if (
      !distributionId ||
      !siteId ||
      !barangay ||
      !eventId ||
      (finalItems === undefined && quantityPlanted === undefined) ||
      !plantingDate ||
      !plantingLocation ||
      !String(submittedByName || "").trim() ||
      !String(submittedBySector || "").trim() ||
      !String(submittedByContactNumber || "").trim()
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please complete all required planting report fields.",
        fieldErrors: Object.fromEntries(Object.entries({ distributionId, siteId, barangay, eventId, quantityPlanted, plantingDate, plantingLocation, submittedByName, submittedBySector, submittedByContactNumber })
          .filter(([, value]) => value == null || !String(value).trim()).map(([key]) => [key, "This field is required."])),
      });
    }

    if (!PARTICIPANT_SECTORS.has(String(submittedBySector).trim())) {
      return res.status(400).json({ success: false, message: "Please select a valid sector.", fieldErrors: { submittedBySector: "Select a valid sector." } });
    }

    if (String(submittedByName).trim().length > 120 || String(submittedByContactNumber).trim().length > 30) {
      return res.status(400).json({ success: false, message: "Submitter information is too long." });
    }

    if (!/^(?:\+63|0)9\d{9}$/.test(String(submittedByContactNumber).replace(/[\s-]/g, ""))) {
      return res.status(400).json({ success: false, message: "Please enter a valid Philippine mobile number.", fieldErrors: { submittedByContactNumber: "Enter a valid Philippine mobile number." } });
    }


    // --------------------------------
    // QUANTITY
    // --------------------------------
    const parsedQuantity =
      finalItems !== undefined ? 0 : Number(quantityPlanted);

    if (
      finalItems === undefined && (
        !Number.isInteger(
          parsedQuantity
        ) ||
        (req.body?.confirmationMode === "final" ? parsedQuantity < 0 : parsedQuantity <= 0))
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter a valid quantity of planted seedlings.",
        fieldErrors: { quantityPlanted: "Enter a positive whole number of planted seedlings." },
      });
    }


    // --------------------------------
    // CREATE REPORT
    // --------------------------------
    const report =
      await createPlantingReport(
        {
          distributionId,
          idempotencyKey: req.headers?.["idempotency-key"],
          inventoryId,
          siteId,
          barangay,
          participantId,

          submittedByName: String(submittedByName).trim(),
          submittedBySector: String(submittedBySector).trim(),
          submittedByContactNumber: String(submittedByContactNumber).trim(),

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
          leftoverQuantity,
          confirmationMode: finalItems !== undefined ? "final" : req.body?.confirmationMode || "partial",
          ...(finalItems !== undefined ? { items: finalItems } : {}),

          plantingDate,

          plantingLocation,

          eventId:
            eventId || "",

          eventName:
            eventName || "",

          remarks:
            remarks || "",

          evidenceManifest:
            req.body?.evidenceManifest || "",

          // Optional link to the participant's own submission returned for correction.
          ...(req.body?.correctionOf ? { correctionOf: req.body.correctionOf } : {}),
        },
        photos
      );


    // --------------------------------
    // INFORMATIVE SUCCESS MESSAGE
    // --------------------------------
    const message = "Your planting report has been submitted and is awaiting MENRO Staff verification.";


    return res.status(201).json({
      success: true,
      message,
      data: report,
    });
  } catch (error) {
    if (require("../services/evidenceWorkflow.service").workflowErrorResponse(res, error)) return;
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
      "Please enter a valid quantity of planted seedlings.",
      "The quantity planted cannot exceed the remaining released seedling quantity.",
      "You are not authorized to submit planting reports for this event.",
      "The linked distribution has an invalid released quantity.",
      "A planting report already exists for this distribution.",
      "Duplicate planting image detected.",
      "Duplicate evidence photos were detected in this submission.",
      "At least one planting evidence photo is required.",
      "A maximum of 10 planting evidence photos is allowed.",
      "The uploaded file is not a valid image.",
      "GPS location metadata was not found in this photo. Please upload the original geotagged photo and try again.",
      "GPS metadata was found but could not be read from this photo. Please upload the original geotagged photo.",
      "This photo contains invalid GPS coordinates. Please upload an original geotagged photo with valid location information.",
      "Screenshot images are not accepted as planting evidence. Please upload the original geotagged photo.",
      "The selected planting site is inactive.",
      "The selected planting site has invalid coordinates.",
      "Selected event does not match the released distribution.",
      "Selected planting site does not match the released distribution.",
      "The selected planting site does not belong to the selected barangay.",
      "A valid planting date is required.",
      "Select a released seedling tree item for this submission.",
      "Seedling tree item has not been released for this event.",
      "Quantity planted exceeds the remaining event allocation.",
      "This planting report has already been finalized.",
      "Latitude must be between -90 and 90.",
      "Longitude must be between -180 and 180.",
      "A valid device location and capture timestamp are required for a photo taken within the system.",
      "Selected planting event was not found.",
      "The selected planting event is archived.",
      "The selected planting event has been cancelled.",
      "The selected planting event is not available for planting reports.",
      "The selected planting event is cancelled, rejected, or unavailable.",
      "The selected planting event has an invalid event date.",
      "Planting reports cannot be submitted before the planting event begins.",
      "Planting event date does not match the selected event.",
      "The selected planting event does not match the selected site and barangay.",
      "The selected planting event does not belong to the selected planting site.",
      "The selected planting event does not belong to the selected barangay.",
      "Your photo is outside the Municipality of Bulan coverage area. Please use a photo taken within Bulan and try again.",
      "Photo capture timestamp is in the future and cannot be verified.",
    ];

    const statusCode = [400, 409, 422].includes(error.status) ? error.status : notFoundErrors.includes(error.message)
      ? 404
      : validationErrors.includes(error.message) || error.message.startsWith("Quantity exceeds the remaining reportable quantity.")
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
      ...(statusCode < 500 && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
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

    if (verificationStatus && ![
      "Awaiting Submission", "Partial", "Fully Reported — Awaiting Review", "Completed",
      "Verified", "Needs Review", "Invalid", "Not Required", "Pending Review", "Accepted", "Rejected",
    ].includes(verificationStatus)) {
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

    if (req.user.role === "participant" &&
        !(await participantCanAccessReport(report, req.user.uid))) {
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


// REVIEW DECISIONS
// Staff: forward to Admin or return participant reports for correction.
// Admin: approve or reject Staff-reviewed reports; approve, reject or return
// official Staff reports. Services enforce the role and stage of each record.
const LEGACY_DECISION_STATUS = new Map([
  ["Planting report not found.", 404],
  ["Planting report submission not found.", 404],
  ["Invalid planting report ID.", 400],
]);

function decisionHandler(action, { success, failure, requiresReason, reasonPrompt }) {
  return async (req, res) => {
    try {
      const { remarks = "" } = req.body || {};
      if (typeof remarks !== "string") {
        return res.status(400).json({ success: false, message: "Remarks must be text.", fieldErrors: { remarks: "Remarks must be text." } });
      }
      if (requiresReason && !remarks.trim()) {
        return res.status(400).json({ success: false, message: reasonPrompt, fieldErrors: { remarks: reasonPrompt } });
      }
      const report = await action(req.params.id, req.user.uid, remarks, req.user.fullName, req.user.role);
      return res.status(200).json({ success: true, message: success, data: report });
    } catch (error) {
      const known = [400, 401, 403, 404, 409].includes(error.status) ? error.status : LEGACY_DECISION_STATUS.get(error.message);
      const statusCode = known || 500;
      if (statusCode === 500) console.error(error);
      return res.status(statusCode).json({
        success: false,
        message: statusCode === 500 ? failure : error.message,
        ...(statusCode < 500 && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      });
    }
  };
}

const forwardReport = decisionHandler(forwardPlantingReport, {
  success: "Planting report reviewed and forwarded to the MENRO Admin for approval.",
  failure: "Failed to forward the planting report.",
});

const returnReport = decisionHandler(returnPlantingReport, {
  success: "Planting report returned for correction.",
  failure: "Failed to return the planting report.",
  requiresReason: true,
  reasonPrompt: "Enter the reason for returning this planting report.",
});

const approveReport = decisionHandler(approvePlantingReport, {
  success: "Planting report approved. Planted quantities are confirmed.",
  failure: "Failed to approve planting report.",
});

const rejectReport = decisionHandler(rejectPlantingReport, {
  success: "Planting report rejected.",
  failure: "Failed to reject planting report.",
  requiresReason: true,
  reasonPrompt: "Please enter a reason for rejecting the planting report.",
});


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
  forwardReport,
  returnReport,
  getVerificationLogs,
};
