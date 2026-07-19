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
    } = req.body || {};

    if (
      !participantId ||
      !participantName ||
      !organization ||
      !contactNumber ||
      !inventoryId ||
      quantity === undefined ||
      !purpose ||
      !plantingLocation ||
      !preferredReleaseDate
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required.",
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
        message:
          "Quantity must be greater than zero.",
      });
    }

    const request = await createSeedlingRequest({
      participantId,
      participantName,
      organization,
      contactNumber,

      inventoryId,

      quantity,
      purpose,
      plantingLocation,
      preferredReleaseDate,

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
        "Seedling request submitted successfully.",
      data: request,
    });
  } catch (error) {
    console.error(error);

    const statusCode =
      error.message ===
      "Selected seedling inventory not found."
        ? 404
        : 400;

    return res.status(statusCode).json({
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