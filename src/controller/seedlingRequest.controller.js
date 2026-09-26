const {
  createSeedlingRequest,
  getAllSeedlingRequests,
  getSeedlingRequestById,
  getSeedlingRequestsByStatus,
  getSeedlingRequestsByParticipantId,
  reviewSeedlingRequest,
  returnSeedlingRequest,
  resubmitSeedlingRequest,
  approveSeedlingRequest,
  rejectSeedlingRequest,
  releaseSeedlingRequest,
} = require("../services/seedlingRequest.service");
const {
  validatePreferredReleaseDate,
  validateProposedEventDate,
} = require("../utils/requestDate.util");

// ========================================
// HELPER — CLEAN STRING
// ========================================

const cleanString = (value) =>
  String(value || "").trim();

// ========================================
// HELPER — VALIDATE DECISION REASON
// ========================================

const validateDecisionReason = (
  reason
) => {
  const cleanReason =
    cleanString(reason);

  if (!cleanReason) {
    throw new Error(
      "A reason is required before making the final decision."
    );
  }

  if (cleanReason.length < 5) {
    throw new Error(
      "Decision reason must be at least 5 characters."
    );
  }

  if (cleanReason.length > 500) {
    throw new Error(
      "Decision reason must not exceed 500 characters."
    );
  }

  return cleanReason;
};

// ========================================
// HELPER — VALIDATE REQUEST ITEMS
// ========================================

const validateRequestItems = (
  items
) => {
  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    throw new Error(
      "At least one seedling must be selected."
    );
  }

  if (items.length > 10) {
    throw new Error(
      "A maximum of 10 seedling types may be requested at a time."
    );
  }

  const inventoryIds =
    new Set();

  return items.map(
    (item, index) => {
      const inventoryId =
        cleanString(
          item?.inventoryId
        );

      const quantity =
        Number(
          item?.quantity
        );

      if (!inventoryId) {
        throw new Error(
          `Seedling item ${index + 1} has no selected inventory.`
        );
      }

      if (
        !Number.isInteger(
          quantity
        ) ||
        quantity <= 0
      ) {
        throw new Error(
          `Seedling item ${index + 1} must have a positive whole-number quantity.`
        );
      }

      if (
        inventoryIds.has(
          inventoryId
        )
      ) {
        throw new Error(
          "The same seedling inventory cannot be selected more than once."
        );
      }

      inventoryIds.add(
        inventoryId
      );

      return {
        inventoryId,
        quantity,
      };
    }
  );
};

const validateResubmissionPayload = (body = {}) => {
  const {
    items,
    purpose,
    plantingLocation,
    preferredReleaseDate,
    eventProposal,
  } = body;

  if (
    !cleanString(purpose) ||
    !cleanString(plantingLocation) ||
    !preferredReleaseDate ||
    !eventProposal
  ) {
    throw new Error("All seedling request and event proposal fields are required.");
  }

  const validatedItems = validateRequestItems(items);
  const proposedStartTime =
    eventProposal.proposedStartTime ?? eventProposal.startTime;
  const proposedEndTime =
    eventProposal.proposedEndTime ?? eventProposal.endTime;
  const description =
    eventProposal.description ?? eventProposal.eventDescription;
  const expectedParticipants = Number(eventProposal.expectedParticipants ?? 0);
  const latitude = Number(eventProposal.latitude);
  const longitude = Number(eventProposal.longitude);

  if (
    !cleanString(eventProposal.eventName) ||
    !cleanString(eventProposal.barangay) ||
    !cleanString(eventProposal.plantingSiteId) ||
    !eventProposal.proposedDate ||
    !proposedStartTime ||
    !proposedEndTime ||
    !cleanString(eventProposal.eventLocation) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    throw new Error("All required event proposal fields must be provided.");
  }

  if (latitude < -90 || latitude > 90) {
    throw new Error("Event latitude must be between -90 and 90.");
  }

  if (longitude < -180 || longitude > 180) {
    throw new Error("Event longitude must be between -180 and 180.");
  }

  if (!Number.isInteger(expectedParticipants) || expectedParticipants < 0) {
    throw new Error("Expected participants must be a nonnegative integer.");
  }

  const preferredDateError = validatePreferredReleaseDate(preferredReleaseDate);
  if (preferredDateError) throw new Error(preferredDateError);

  const proposedDateError = validateProposedEventDate(eventProposal.proposedDate);
  if (proposedDateError) throw new Error(proposedDateError);

  const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!timePattern.test(proposedStartTime) || !timePattern.test(proposedEndTime)) {
    throw new Error("Event time must use HH:MM format.");
  }

  if (proposedStartTime >= proposedEndTime) {
    throw new Error("Event end time must be later than the start time.");
  }

  return {
    items: validatedItems,
    purpose: cleanString(purpose),
    plantingLocation: cleanString(plantingLocation),
    preferredReleaseDate,
    eventProposal: {
      eventName: cleanString(eventProposal.eventName),
      barangay: cleanString(eventProposal.barangay),
      plantingSiteId: cleanString(eventProposal.plantingSiteId),
      proposedDate: eventProposal.proposedDate,
      proposedStartTime,
      proposedEndTime,
      eventLocation: cleanString(eventProposal.eventLocation),
      latitude,
      longitude,
      expectedParticipants,
      description: cleanString(description),
    },
  };
};

// ========================================
// PARTICIPANT — SUBMIT REQUEST
// ========================================

const submitSeedlingRequest = async (
  req,
  res
) => {
  try {
    const participantId =
      req.user.uid;

    const {
      items,
      purpose,
      plantingLocation,
      preferredReleaseDate,
      eventProposal,
    } = req.body || {};

    // Profile identity is server-owned; never trust request-body overrides.
    const participantName = req.user.fullName || req.user.name || "";
    const organization = req.user.organization || "";
    const contactNumber = req.user.contactNumber || "";

    if (!cleanString(organization)) {
      return res.status(400).json({
        success: false,
        message: "Your organization information is missing from your profile. Please update your profile before submitting this request.",
      });
    }

    if (!cleanString(contactNumber)) {
      return res.status(400).json({
        success: false,
        message: "Your contact number is missing from your profile. Please update your profile before submitting this request.",
      });
    }

    // ========================================
    // BASIC REQUEST VALIDATION
    // ========================================

    if (
      !participantId ||
      !cleanString(
        participantName
      ) ||
      !cleanString(
        organization
      ) ||
      !cleanString(
        contactNumber
      ) ||
      !cleanString(
        purpose
      ) ||
      !cleanString(
        plantingLocation
      ) ||
      !preferredReleaseDate ||
      !eventProposal
    ) {
      return res.status(400).json({
        success: false,
        message:
          "All seedling request and event proposal fields are required.",
      });
    }

    // ========================================
    // REQUEST ITEMS
    // ========================================

    const validatedItems =
      validateRequestItems(
        items
      );

    // ========================================
    // EVENT PROPOSAL
    // ========================================

    const {
      eventName,
      barangay,
      plantingSiteId,
      proposedDate,
      proposedStartTime: submittedProposedStartTime,
      proposedEndTime: submittedProposedEndTime,
      eventLocation,
      latitude,
      longitude,
      expectedParticipants,
      description: submittedDescription,
    } = eventProposal;

    const proposedStartTime = submittedProposedStartTime ?? eventProposal.startTime;
    const proposedEndTime = submittedProposedEndTime ?? eventProposal.endTime;
    const description = submittedDescription ?? eventProposal.eventDescription;

    if (
      !cleanString(eventName) ||
      !cleanString(barangay) ||
      !cleanString(
        plantingSiteId
      ) ||
      !proposedDate ||
      !proposedStartTime ||
      !proposedEndTime ||
      !cleanString(
        eventLocation
      ) ||
      latitude === undefined ||
      longitude === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "All required event proposal fields must be provided.",
      });
    }

    const parsedLatitude =
      Number(latitude);

    const parsedLongitude =
      Number(longitude);

    const parsedExpectedParticipants =
      Number(
        expectedParticipants ?? 0
      );

    // ========================================
    // GPS VALIDATION
    // ========================================

    if (
      !Number.isFinite(
        parsedLatitude
      ) ||
      parsedLatitude < -90 ||
      parsedLatitude > 90
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Event latitude must be between -90 and 90.",
      });
    }

    if (
      !Number.isFinite(
        parsedLongitude
      ) ||
      parsedLongitude < -180 ||
      parsedLongitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Event longitude must be between -180 and 180.",
      });
    }

    // ========================================
    // EXPECTED PARTICIPANTS
    // ========================================

    if (
      !Number.isInteger(
        parsedExpectedParticipants
      ) ||
      parsedExpectedParticipants <
        0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Expected participants must be a nonnegative integer.",
      });
    }

    // ========================================
    // DATE VALIDATION
    // ========================================

    const preferredDateError = validatePreferredReleaseDate(preferredReleaseDate);
    if (preferredDateError) {
      return res.status(400).json({
        success: false,
        message: preferredDateError,
      });
    }

    const proposedDateError = validateProposedEventDate(proposedDate);
    if (proposedDateError) {
      return res.status(400).json({
        success: false,
        message: proposedDateError,
      });
    }

    // ========================================
    // TIME VALIDATION
    // ========================================

    const timePattern =
      /^([01]\d|2[0-3]):([0-5]\d)$/;

    if (
      !timePattern.test(
        proposedStartTime
      ) ||
      !timePattern.test(
        proposedEndTime
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Event time must use HH:MM format.",
      });
    }

    if (
      proposedStartTime >=
      proposedEndTime
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Event end time must be later than the start time.",
      });
    }

    // ========================================
    // CREATE REQUEST
    // ========================================

    const request =
      await createSeedlingRequest({
        participantId,

        participantName:
          cleanString(
            participantName
          ),

        organization:
          cleanString(
            organization
          ),

        contactNumber:
          cleanString(
            contactNumber
          ),

        items:
          validatedItems,

        purpose:
          cleanString(
            purpose
          ),

        plantingLocation:
          cleanString(
            plantingLocation
          ),

        preferredReleaseDate,

        eventProposal: {
          eventName:
            cleanString(
              eventName
            ),

          barangay:
            cleanString(
              barangay
            ),

          plantingSiteId:
            cleanString(
              plantingSiteId
            ),

          proposedDate,

          proposedStartTime,

          proposedEndTime,

          eventLocation:
            cleanString(
              eventLocation
            ),

          latitude:
            parsedLatitude,

          longitude:
            parsedLongitude,

          expectedParticipants:
            parsedExpectedParticipants,

          description:
            cleanString(
              description
            ),

          status:
            "Proposed",
        },

        eventId: "",

        eventCreated:
          false,

        status:
          "Pending",

        reviewedBy: "",
        reviewedAt: null,

        approvedBy: "",
        approvedAt: null,

        rejectedBy: "",
        rejectedAt: null,

        releasedBy: "",
        releasedAt: null,

        decisionReason: "",
        decisionBy: "",
        decisionAt: null,

        inventoryDeducted:
          false,

        inventoryReserved:
          false,

        inventoryReleased:
          false,
      });

    return res.status(201).json({
      success: true,
      message:
        "Seedling request and planting event proposal submitted successfully.",
      data: request,
    });
  } catch (error) {
    console.error(
      "submitSeedlingRequest error:",
      error
    );

    return res
      .status(400)
      .json({
        success: false,
        message:
          error.message ||
          "Failed to submit seedling request.",
      });
  }
};

// ========================================
// ADMIN / STAFF — GET ALL REQUESTS
// ========================================

const getSeedlingRequests = async (
  req,
  res
) => {
  try {
    const { status } =
      req.query;

    const requests =
      status
        ? await getSeedlingRequestsByStatus(
            status
          )
        : await getAllSeedlingRequests();

    return res.status(200).json({
      success: true,
      data: requests,
    });
  } catch (error) {
    console.error(
      "getSeedlingRequests error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to retrieve requests.",
    });
  }
};

// ========================================
// ADMIN / STAFF — GET ONE REQUEST
// ========================================

const getSeedlingRequest = async (
  req,
  res
) => {
  try {
    const request =
      await getSeedlingRequestById(
        req.params.id
      );

    if (req.user.role === "participant" && request.participantId !== req.user.uid) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    return res.status(200).json({
      success: true,
      data: request,
    });
  } catch (error) {
    const notFound = error.message === "Seedling request not found.";
    if (!notFound) console.error("getSeedlingRequest error:", error);
    return res.status(notFound ? 404 : 500).json({
      success: false,
      message:
        notFound ? error.message : "Failed to retrieve request.",
    });
  }
};

// ========================================
// PARTICIPANT — GET OWN REQUESTS
// ========================================

const getMySeedlingRequests =
  async (req, res) => {
    try {
      const requests =
        await getSeedlingRequestsByParticipantId(
          req.user.uid
        );

      return res.status(200).json({
        success: true,
        data: requests,
      });
    } catch (error) {
      console.error(
        "getMySeedlingRequests error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to retrieve my requests.",
      });
    }
  };

// ========================================
// STAFF — REVIEW
//
// Pending -> Reviewed
// ========================================

const markRequestReviewed =
  async (req, res) => {
    try {
      const {
        items,
        purpose,
        plantingLocation,
        preferredReleaseDate,
      } = req.body || {};

      if (
        !cleanString(
          purpose
        ) ||
        !cleanString(
          plantingLocation
        ) ||
        !preferredReleaseDate
      ) {
        return res.status(400).json({
          success: false,
          message:
            "All review fields are required.",
        });
      }

      const preferredDateError = validatePreferredReleaseDate(preferredReleaseDate);
      if (preferredDateError) {
        return res.status(400).json({
          success: false,
          message: preferredDateError,
        });
      }

      const validatedItems =
        validateRequestItems(
          items
        );

      const updatedRequest =
        await reviewSeedlingRequest(
          req.params.id,
          {
            reviewedBy: req.user.uid,
            reviewedByName: req.user.fullName || req.user.name || "",
            items: validatedItems,
            purpose: cleanString(purpose),
            plantingLocation: cleanString(plantingLocation),
            preferredReleaseDate,
          }
        );

      return res.status(200).json({
        success: true,
        message:
          "Request reviewed successfully and forwarded to the administrator for final approval.",
        data:
          updatedRequest,
      });
    } catch (error) {
      const notFound = error.message === "Seedling request not found.";
      const conflict = error.message === "Only pending requests can be reviewed.";
      const invalid = [
        "At least one seedling must be selected.",
        "A maximum of 10 seedling types may be requested at a time.",
        "The same seedling inventory cannot be selected more than once.",
        "One of the linked seedling inventory records was not found.",
      ].includes(error.message) || /^Seedling item \d+ (has no selected inventory|must have a positive whole-number quantity)\.$/.test(error.message);
      const statusCode = notFound ? 404 : conflict ? 409 : invalid ? 400 : 500;
      if (statusCode === 500) console.error("markRequestReviewed error:", error);

      return res.status(statusCode).json({
        success: false,
        message: statusCode === 500 ? "Failed to review request." : error.message,
      });
    }
  };

const returnRequestForRevision = async (req, res) => {
  try {
    const reason = cleanString(req.body?.reason);

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Please provide a reason so the participant knows what needs to be corrected.",
      });
    }

    if (reason.length > 500) {
      return res.status(400).json({
        success: false,
        message: "Reason for return must be 500 characters or fewer.",
      });
    }

    const request = await returnSeedlingRequest(
      req.params.id,
      req.user.uid,
      req.user.fullName || req.user.name || "",
      reason
    );

    return res.status(200).json({
      success: true,
      message: "Request returned to the participant for revision.",
      data: request,
    });
  } catch (error) {
    const notFound = error.message === "Seedling request not found.";
    const conflict = error.message === "Only pending requests can be returned for revision.";
    const statusCode = notFound ? 404 : conflict ? 409 : 400;
    return res.status(statusCode).json({
      success: false,
      message: error.message || "Unable to return the request for revision.",
    });
  }
};

const resubmitRequest = async (req, res) => {
  try {
    const requestData = validateResubmissionPayload(req.body);
    const request = await resubmitSeedlingRequest(
      req.params.id,
      req.user.uid,
      requestData
    );

    return res.status(200).json({
      success: true,
      message: "Request resubmitted successfully for MENRO Staff review.",
      data: request,
    });
  } catch (error) {
    const notFound = error.message === "Seedling request not found.";
    const forbidden = error.message === "You can only edit your own returned request.";
    const conflict = error.message === "This request can no longer be edited because its status has changed.";
    const statusCode = notFound ? 404 : forbidden ? 403 : conflict ? 409 : 400;

    return res.status(statusCode).json({
      success: false,
      message: error.message || "Unable to resubmit the request. Please try again.",
    });
  }
};

// ========================================
// ADMIN — FINAL APPROVAL
//
// Reviewed -> Approved
//
// Approval reason is optional.
// Inventory remains unchanged until Staff release.
// The planting event is created and scheduled.
// ========================================

const approveRequest = async (
  req,
  res
) => {
  try {
    // Approval does not require a reason.
    const request = await approveSeedlingRequest(req.params.id, req.user.uid, req.body?.reason);

    return res.status(200).json({
      success: true,
      message:
        "Seedling request approved successfully and the planting event has been added to the event schedule.",
      data: request,
    });
  } catch (error) {
    console.error(
      "approveRequest error:",
      error
    );

    const configurationError =
      error.message === "GUEST_INVITATION_SECRET must contain at least 32 characters.";

    return res.status(configurationError ? 503 : 400).json({
      success: false,
      message:
        configurationError
          ? "Guest invitation service is not configured. Please contact the system administrator."
          : error.message ||
        "Failed to approve request.",
    });
  }
};

// ========================================
// ADMIN — FINAL REJECTION
// ========================================

const rejectRequest = async (
  req,
  res
) => {
  try {
    const reason =
      validateDecisionReason(
        req.body?.reason
      );

    const request =
      await rejectSeedlingRequest(
        req.params.id,
        req.user.uid,
        reason
      );

    return res.status(200).json({
      success: true,
      message:
        "Seedling request rejected successfully.",
      data: request,
    });
  } catch (error) {
    console.error(
      "rejectRequest error:",
      error
    );

    return res.status(400).json({
      success: false,
      message:
        error.message ||
        "Failed to reject request.",
    });
  }
};

// ========================================
// STAFF — RELEASE
// ========================================

const releaseRequest = async (
  req,
  res
) => {
  try {
    const request =
      await releaseSeedlingRequest(
        req.params.id,
        req.user.uid,
        req.body
      );

    return res.status(200).json({
      success: true,
      message:
        "Seedlings released successfully.",
      data: request,
    });
  } catch (error) {
    console.error(
      "releaseRequest error:",
      error
    );

    return res.status(400).json({
      success: false,
      message:
        error.message ||
        "Failed to release seedlings.",
    });
  }
};

module.exports = {
  submitSeedlingRequest,
  getSeedlingRequests,
  getSeedlingRequest,
  getMySeedlingRequests,
  markRequestReviewed,
  returnRequestForRevision,
  resubmitRequest,
  approveRequest,
  rejectRequest,
  releaseRequest,
};
