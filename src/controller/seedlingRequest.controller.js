const {
  createSeedlingRequest,
  getAllSeedlingRequests,
  getSeedlingRequestById,
  getSeedlingRequestsByStatus,
  getSeedlingRequestsByParticipantId,
  reviewSeedlingRequest,
  approveSeedlingRequest,
  rejectSeedlingRequest,
  releaseSeedlingRequest,
} = require("../services/seedlingRequest.service");

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
      participantName =
        req.user.fullName ||
        req.user.name ||
        "",

      organization =
        req.user.organization ||
        req.user.barangay ||
        "",

      contactNumber =
        req.user.contactNumber ||
        "",

      items,
      purpose,
      plantingLocation,
      preferredReleaseDate,
      eventProposal,
    } = req.body || {};

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
      proposedStartTime,
      proposedEndTime,
      eventLocation,
      latitude,
      longitude,
      expectedParticipants,
      description,
    } = eventProposal;

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
      longitude === undefined ||
      expectedParticipants ===
        undefined
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
        expectedParticipants
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
      parsedExpectedParticipants <=
        0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Expected participants must be a positive integer.",
      });
    }

    // ========================================
    // DATE VALIDATION
    // ========================================

    const parsedEventDate =
      new Date(
        `${proposedDate}T00:00:00`
      );

    if (
      Number.isNaN(
        parsedEventDate.getTime()
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid proposed event date.",
      });
    }

    // Proposed date must not be in the past (local date comparison)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (parsedEventDate.getTime() < today.getTime()) {
      return res.status(400).json({
        success: false,
        message: "Proposed event date cannot be in the past.",
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

    return res.status(200).json({
      success: true,
      data: request,
    });
  } catch (error) {
    console.error(
      "getSeedlingRequest error:",
      error
    );

    return res.status(404).json({
      success: false,
      message:
        error.message,
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
        reviewRemarks,
      } = req.body || {};

      if (
        !cleanString(
          purpose
        ) ||
        !cleanString(
          plantingLocation
        ) ||
        !preferredReleaseDate
        || !cleanString(reviewRemarks)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "All review fields are required.",
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
            reviewRemarks: cleanString(reviewRemarks),
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
      console.error(
        "markRequestReviewed error:",
        error
      );

      return res.status(400).json({
        success: false,
        message:
          error.message ||
          "Failed to review request.",
      });
    }
  };

// ========================================
// ADMIN — FINAL APPROVAL
//
// Reviewed -> Approved
//
// Reason REQUIRED.
// Inventory is reserved.
// Planting event is created and Scheduled.
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

    return res.status(400).json({
      success: false,
      message:
        error.message ||
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
        req.user.uid
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
  approveRequest,
  rejectRequest,
  releaseRequest,
};