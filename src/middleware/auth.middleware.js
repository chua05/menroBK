const { auth } = require("../config/firebase");
const { sendError } = require("../utils/response.util");
const { getUserByUid } = require("../services/user.service");

const requiresVerifiedParticipantEmail = (decodedToken, userProfile) =>
  decodedToken?.firebase?.sign_in_provider === "password" &&
  decodedToken.email_verified !== true &&
  !["admin", "staff"].includes(
    String(userProfile?.role || "participant").toLowerCase()
  );

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
      await auth.verifyIdToken(token, true);

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

    if (requiresVerifiedParticipantEmail(decodedToken, userProfile)) {
      return sendError(res, 403, "Please verify your email address before continuing.");
    }

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || userProfile.email,
      fullName: userProfile.fullName || "",
      username: userProfile.username || "",
      contactNumber: userProfile.contactNumber || "",
      userType: userProfile.userType || "",
      userTypeDetail: userProfile.userTypeDetail || "",
      affiliationName: userProfile.affiliationName || userProfile.organization || "",
      barangay: userProfile.barangay || "",
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
      await auth.verifyIdToken(token, true);

    const userProfile =
      await getUserByUid(decodedToken.uid);

    if (userProfile && userProfile.status !== "active") {
      return sendError(
        res,
        403,
        "User account is inactive."
      );
    }

    if (requiresVerifiedParticipantEmail(decodedToken, userProfile)) {
      return sendError(res, 403, "Please verify your email address before continuing.");
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

// Verifies Firebase identity without requiring email verification. This is
// intentionally limited to recovery operations such as resending the secure
// verification message; it grants no access to protected MENRO resources.
const verifyTokenForVerificationEmail = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return sendError(res, 401, "Unauthorized");
    }
    const decodedToken = await auth.verifyIdToken(authHeader.slice(7), true);
    const userProfile = await getUserByUid(decodedToken.uid);
    if (!userProfile) return sendError(res, 403, "User profile not found.");
    if (userProfile.status !== "active") {
      return sendError(res, 403, "User account is inactive.");
    }
    req.user = { uid: decodedToken.uid, email: decodedToken.email || userProfile.email };
    next();
  } catch (error) {
    console.error(error);
    return sendError(res, 401, "Invalid token");
  }
};

module.exports = {
  verifyToken,
  verifyTokenForBootstrap,
  verifyTokenForVerificationEmail,
};
