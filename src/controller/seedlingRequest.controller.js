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

    // BASIC REQUEST VALIDATION
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

    // QUANTITY VALIDATION
    const parsedQuantity =
  Number(quantity);

if (
  !Number.isInteger(
    parsedQuantity
  )
) {
    }

    if (parsedQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity must be greater than zero.",
      });
    }

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

    // EVENT REQUIRED FIELDS
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

    const parsedLatitude =
      Number(latitude);

    const parsedLongitude =
      Number(longitude);

    const parsedExpectedParticipants =
      Number(expectedParticipants);

    // GPS VALIDATION
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

    // EXPECTED PARTICIPANTS VALIDATION
    if (
      !Number.isInteger(
        parsedExpectedParticipants
      ) ||
      parsedExpectedParticipants <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Expected participants must be a positive integer.",
      });
    }

    // DATE VALIDATION
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

    // TIME VALIDATION
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

    const request =
      await createSeedlingRequest({
        participantId,
        participantName,
        organization,
        contactNumber,

        inventoryId,

        quantity: parsedQuantity,
        purpose,
        plantingLocation,
        preferredReleaseDate,

        // EVENT PROPOSAL
        eventProposal: {
          eventName:
            eventName.trim(),

          barangay:
            barangay.trim(),

          proposedDate,

          proposedStartTime,

          proposedEndTime,

          eventLocation:
            eventLocation.trim(),

          latitude:
            parsedLatitude,

          longitude:
            parsedLongitude,

          expectedParticipants:
            parsedExpectedParticipants,

          description:
            description?.trim() || "",

          status:
            "Proposed",
        },

        // Will contain the real
        // planting event document ID
        // after event authorization.
        eventId: "",

        status: "Pending",

        reviewedBy: "",
        approvedBy: "",
        rejectedBy: "",
        releasedBy: "",

        inventoryDeducted: false,
      });

    return res.status(201).json({
      success: true,
      message:
        "Seedling request and event proposal submitted successfully.",
      data: request,
    });
  } catch (error) {
    console.error(error);

    const statusCode =
      error.message ===
      "Selected seedling inventory not found."
        ? 404
        : 400;

    return res
      .status(statusCode)
      .json({
        success: false,
        message: error.message,
      });
  }
};



const getSeedlingRequests = async (req, res) => {
  try {
    const { status } = req.query;

    let requests;

    if (status) {
      requests = await getSeedlingRequestsByStatus(status);
    } else {
      requests = await getAllSeedlingRequests();
    }

    return res.status(200).json({
      success: true,
      data: requests,
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve requests.",
    });
  }
};

const getSeedlingRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const request = await getSeedlingRequestById(id);

    return res.status(200).json({
      success: true,
      data: request,
    });

  } catch (error) {
    console.error(error);

    return res.status(404).json({
      success: false,
      message: error.message,
    });
  }
};

const getMySeedlingRequests = async (req, res) => {
  try {
    const participantId = req.user.uid;

    const requests =
      await getSeedlingRequestsByParticipantId(participantId);

    return res.status(200).json({
      success: true,
      data: requests,
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve my requests.",
    });
  }
};

const markRequestReviewed = async (req, res) => {
  try {
    const { id } = req.params;

    const reviewedBy = req.user.uid;

    const {
      quantity,
      purpose,
      plantingLocation,
      preferredReleaseDate,
    } = req.body || {};

    if (
      quantity === undefined ||
      !purpose ||
      !plantingLocation ||
      !preferredReleaseDate
    ) {
      return res.status(400).json({
        success: false,
        message: "All review fields are required.",
      });
    }

    if (!Number.isInteger(quantity)) {
    return res.status(400).json({
      success: false,
      message: "Quantity must be an integer.",
    });
  }

    if (quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be greater than zero.",
      });
    }

    const updatedRequest = await reviewSeedlingRequest(
      id,
      {
        reviewedBy,
        quantity,
        purpose,
        plantingLocation,
        preferredReleaseDate,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Request reviewed successfully.",
      data: updatedRequest,
    });

  } catch (error) {
    console.error(error);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const approveRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const approvedBy = req.user.uid;

    const request = await approveSeedlingRequest(
      id,
      approvedBy
    );

    return res.status(200).json({
      success: true,
      message: "Seedling request approved successfully.",
      data: request,
    });

  } catch (error) {
    console.error(error);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const rejectRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const rejectedBy = req.user.uid;

    const request = await rejectSeedlingRequest(
      id,
      rejectedBy
    );

    return res.status(200).json({
      success: true,
      message: "Seedling request rejected successfully.",
      data: request,
    });

  } catch (error) {
    console.error(error);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const releaseRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const releasedBy = req.user.uid;

    const request = await releaseSeedlingRequest(
      id,
      releasedBy
    );

    return res.status(200).json({
      success: true,
      message: "Seedlings released successfully.",
      data: request,
    });

  } catch (error) {
    console.error(error);

    return res.status(400).json({
      success: false,
      message: error.message,
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