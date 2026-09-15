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
// PARTICIPANT — SUBMIT REQUEST
// ========================================

const submitSeedlingRequest = async (req, res) => {
  try {
    const participantId = req.user.uid;

    const {
      participantName = req.user.fullName,
      organization = req.user.organization,
      contactNumber = req.user.contactNumber,

      inventoryId,
      quantity,
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
      !participantName ||
      !organization ||
      !contactNumber ||
      !inventoryId ||
      quantity === undefined ||
      !purpose ||
      !plantingLocation ||
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
    // QUANTITY VALIDATION
    // ========================================

    const parsedQuantity = Number(quantity);

    if (!Number.isInteger(parsedQuantity)) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a whole number.",
      });
    }

    if (parsedQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be greater than zero.",
      });
    }

    // ========================================
    // EVENT PROPOSAL
    // ========================================

    const {
      eventName,
      barangay,
      proposedDate,
      proposedStartTime,
      proposedEndTime,
      eventLocation,
      latitude,
      longitude,
      expectedParticipants,
      description,
    } = eventProposal;

    // ========================================
    // EVENT REQUIRED FIELDS
    // ========================================

    if (
      !eventName ||
      !barangay ||
      !proposedDate ||
      !proposedStartTime ||
      !proposedEndTime ||
      !eventLocation ||
      latitude === undefined ||
      longitude === undefined ||
      expectedParticipants === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "All required event proposal fields must be provided.",
      });
    }

    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);

    const parsedExpectedParticipants = Number(
      expectedParticipants
    );

    // ========================================
    // GPS VALIDATION
    // ========================================

    if (
      Number.isNaN(parsedLatitude) ||
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
      Number.isNaN(parsedLongitude) ||
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
    // EXPECTED PARTICIPANTS VALIDATION
    // ========================================

    if (
      !Number.isInteger(parsedExpectedParticipants) ||
      parsedExpectedParticipants <= 0
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

    const parsedEventDate = new Date(
      `${proposedDate}T00:00:00`
    );

    if (Number.isNaN(parsedEventDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid proposed event date.",
      });
    }

    // ========================================
    // TIME VALIDATION
    // ========================================

    const timePattern =
      /^([01]\d|2[0-3]):([0-5]\d)$/;

    if (
      !timePattern.test(proposedStartTime) ||
      !timePattern.test(proposedEndTime)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Event time must use HH:MM format.",
      });
    }

    if (proposedStartTime >= proposedEndTime) {
      return res.status(400).json({
        success: false,
        message:
          "Event end time must be later than the start time.",
      });
    }

    // ========================================
    // CREATE REQUEST
    // ========================================

    const request = await createSeedlingRequest({
      participantId,
      participantName,
      organization,
      contactNumber,

      inventoryId,

      quantity: parsedQuantity,
      purpose,
      plantingLocation,
      preferredReleaseDate,

      eventProposal: {
        eventName: eventName.trim(),
        barangay: barangay.trim(),

        proposedDate,
        proposedStartTime,
        proposedEndTime,

        eventLocation: eventLocation.trim(),

        latitude: parsedLatitude,
        longitude: parsedLongitude,

        expectedParticipants:
          parsedExpectedParticipants,

        description:
          description?.trim() || "",

        status: "Proposed",
      },

      // Real planting event document ID
      // can be assigned after authorization.
      eventId: "",

      status: "Pending",

      reviewedBy: "",
      reviewedAt: null,

      approvedBy: "",
      approvedAt: null,

      rejectedBy: "",
      rejectedAt: null,

      releasedBy: "",
      releasedAt: null,

      inventoryDeducted: false,
      inventoryReserved: false,
      inventoryReleased: false,
    });

    return res.status(201).json({
      success: true,
      message:
        "Seedling request and event proposal submitted successfully.",
      data: request,
    });
  } catch (error) {
    console.error(
      "submitSeedlingRequest error:",
      error
    );

    const statusCode =
      error.message ===
      "Selected seedling inventory not found."
        ? 404
        : 400;

    return res.status(statusCode).json({
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

const getSeedlingRequests = async (req, res) => {
  try {
    const { status } = req.query;

    let requests;

    if (status) {
      requests =
        await getSeedlingRequestsByStatus(status);
    } else {
      requests =
        await getAllSeedlingRequests();
    }

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

const getSeedlingRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const request =
      await getSeedlingRequestById(id);

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
      message: error.message,
    });
  }
};

// ========================================
// PARTICIPANT — GET OWN REQUESTS
// ========================================

const getMySeedlingRequests = async (
  req,
  res
) => {
  try {
    const participantId = req.user.uid;

    const requests =
      await getSeedlingRequestsByParticipantId(
        participantId
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
// STAFF — REVIEW PENDING REQUEST
//
// Pending -> Reviewed
// ========================================

const markRequestReviewed = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const reviewedBy = req.user.uid;

    const {
      quantity,
      purpose,
      plantingLocation,
      preferredReleaseDate,
    } = req.body || {};

    // ========================================
    // REQUIRED REVIEW FIELDS
    // ========================================

    if (
      quantity === undefined ||
      !purpose ||
      !plantingLocation ||
      !preferredReleaseDate
    ) {
      return res.status(400).json({
        success: false,
        message:
          "All review fields are required.",
      });
    }

    const parsedQuantity = Number(quantity);

    // ========================================
    // QUANTITY VALIDATION
    // ========================================

    if (!Number.isInteger(parsedQuantity)) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity must be a whole number.",
      });
    }

    if (parsedQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity must be greater than zero.",
      });
    }

    // ========================================
    // STAFF REVIEW
    // ========================================

    const updatedRequest =
      await reviewSeedlingRequest(id, {
        reviewedBy,

        quantity: parsedQuantity,

        purpose: String(purpose).trim(),

        plantingLocation:
          String(plantingLocation).trim(),

        preferredReleaseDate,
      });

    return res.status(200).json({
      success: true,
      message:
        "Request reviewed successfully and forwarded to the administrator for final approval.",
      data: updatedRequest,
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
// ========================================

const approveRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const approvedBy = req.user.uid;

    const request =
      await approveSeedlingRequest(
        id,
        approvedBy
      );

    return res.status(200).json({
      success: true,
      message:
        "Seedling request approved successfully.",
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
// ADMIN — REJECT REVIEWED REQUEST
//
// Reviewed -> Rejected
// ========================================

const rejectRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const rejectedBy = req.user.uid;

    const request =
      await rejectSeedlingRequest(
        id,
        rejectedBy
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
// STAFF — RELEASE APPROVED REQUEST
//
// Approved -> Released
// ========================================

const releaseRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const releasedBy = req.user.uid;

    const request =
      await releaseSeedlingRequest(
        id,
        releasedBy
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