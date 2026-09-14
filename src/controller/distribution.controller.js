const {
  getAllDistributions,
  getDistributionById,
  getDistributionsByParticipantId,
} = require(
  "../services/distribution.service"
);


// GET ALL DISTRIBUTIONS
const getDistributions = async (
  req,
  res
) => {
  try {
    const {
      species,
      participantId,
      requestId,
    } = req.query;

    const distributions =
      await getAllDistributions({
        species,
        participantId,
        requestId,
      });

    return res.status(200).json({
      success: true,
      data: distributions,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message:
        "Failed to retrieve distribution records.",
    });
  }
};


// GET DISTRIBUTION BY ID
const getDistribution = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const distribution =
      await getDistributionById(
        id
      );

    return res.status(200).json({
      success: true,
      data: distribution,
    });
  } catch (error) {
    console.error(error);

    return res.status(404).json({
      success: false,
      message:
        error.message,
    });
  }
};


// GET DISTRIBUTIONS BY PARTICIPANT ID
// ADMIN / STAFF
const getParticipantDistributions =
  async (req, res) => {
    try {
      const {
        participantId,
      } = req.params;

      const distributions =
        await getDistributionsByParticipantId(
          participantId
        );

      return res.status(200).json({
        success: true,
        data: distributions,
      });
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        message:
          "Failed to retrieve participant distribution records.",
      });
    }
  };


// GET CURRENT PARTICIPANT'S
// OWN DISTRIBUTIONS
const getMyDistributions =
  async (req, res) => {
    try {
      const participantId =
        req.user.uid;

      const distributions =
        await getDistributionsByParticipantId(
          participantId
        );

      const releasedDistributions =
        distributions.filter(
          (distribution) =>
            distribution.status ===
            "Released"
        );

      return res.status(200).json({
        success: true,
        message:
          "Your released distribution records retrieved successfully.",
        data:
          releasedDistributions,
      });
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        message:
          "Failed to retrieve your distribution records.",
      });
    }
  };


module.exports = {
  getDistributions,
  getDistribution,
  getParticipantDistributions,
  getMyDistributions,
};