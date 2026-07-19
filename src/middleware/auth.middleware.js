const { auth } = require("../config/firebase");
const { sendError } = require("../utils/response.util");
const { getUserByUid } = require("../services/user.service");

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ")
    ) {
      return sendError(
        res,
        401,
        "Unauthorized"
      );
    }

    const token = authHeader.split(" ")[1];

    const decodedToken =
      await auth.verifyIdToken(token);

    const userProfile =
      await getUserByUid(decodedToken.uid);

    if (!userProfile) {
      return sendError(
        res,
        403,
        "User profile not found."
      );
    }

    if (userProfile.status !== "active") {
      return sendError(
        res,
        403,
        "User account is inactive."
      );
    }

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || userProfile.email,
      fullName: userProfile.fullName || "",
      username: userProfile.username || "",
      contactNumber: userProfile.contactNumber || "",
      organization: userProfile.organization || "",
      role: (userProfile.role || "participant").toLowerCase(),
      status: userProfile.status,
    };

    next();

  } catch (error) {
    console.error(error);

    return sendError(
      res,
      401,
      "Invalid token"
    );
  }
};

module.exports = {
  verifyToken,
};