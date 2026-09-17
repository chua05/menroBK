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

// VERIFY TOKEN — BOOTSTRAP VARIANT
// Used only by POST /api/auth/verify, the endpoint responsible for
// creating a user's Firestore profile on their very first sign-in
// (e.g. a brand-new Google sign-in has no profile yet). Unlike
// verifyToken, this does NOT reject when no profile exists yet — it
// still blocks an inactive existing account, but lets a first-time
// user through so the controller can create their profile.
const verifyTokenForBootstrap = async (req, res, next) => {
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

    if (userProfile && userProfile.status !== "active") {
      return sendError(
        res,
        403,
        "User account is inactive."
      );
    }

    req.firebaseUser = {
      uid: decodedToken.uid,
      email: decodedToken.email || userProfile?.email || "",
      name: decodedToken.name || "",
      picture: decodedToken.picture || "",
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
  verifyTokenForBootstrap,
};