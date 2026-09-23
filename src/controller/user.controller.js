const userService =
  require("../services/user.service");

const {
  sendSuccess,
  sendError,
} = require("../utils/response.util");


// =====================================================
// DATE CONVERTER
// =====================================================

const serializeDate = (value) => {

  if (!value) {

    return null;

  }


  if (
    typeof value.toDate === "function"
  ) {

    return value
      .toDate()
      .toISOString();

  }


  if (value instanceof Date) {

    return value.toISOString();

  }


  return value;

};


// =====================================================
// SERIALIZE USER
// =====================================================

const serializeUser = (user) => {

  const normalizedRole =
    user.role === "volunteer" ||
    user.role === "guest" ||
    user.role === "barangay_official"
      ? "participant"
      : user.role || "participant";

  return {
    uid: user.uid || "",
    userNumber: user.userNumber || "",
    fullName: user.fullName || "",
    username: user.username || "",
    email: user.email || "",
    contactNumber: user.contactNumber || "",
    userType: user.userType || "",
    userTypeDetail: user.userTypeDetail || "",
    affiliationName: user.affiliationName || user.organization || "",
    organization: user.organization || "",
    barangay: user.barangay || "",
    role: normalizedRole,
    status: user.status || "active",
    photoURL: user.photoURL || "",

    createdAt:
      serializeDate(user.createdAt),

    updatedAt:
      serializeDate(user.updatedAt),

    lastLoginAt:
      serializeDate(user.lastLoginAt),
  };
};


// =====================================================
// GET ALL USERS
// Admin + Staff
// =====================================================

const getUsers = async (req, res) => {

  try {

    const users =
      await userService.getAllUsers();


    const serializedUsers =
      users
        .map(serializeUser)
        .sort((a, b) => {

          const dateA =
            new Date(
              a.createdAt || 0
            ).getTime();

          const dateB =
            new Date(
              b.createdAt || 0
            ).getTime();


          return dateB - dateA;

        });


    return sendSuccess(

      res,

      200,

      "Registered users retrieved",

      serializedUsers

    );

  }

  catch (error) {

    console.error(error);


    return sendError(

      res,

      500,

      "Failed to retrieve users"

    );

  }

};


// =====================================================
// UPDATE ROLE
// Admin only
// =====================================================

const changeUserRole = async (
  req,
  res
) => {

  try {

    const { uid } =
      req.params;

    const { role } =
      req.body;


    if (!role) {

      return sendError(

        res,

        400,

        "Role is required"

      );

    }


    const updatedUser =
      await userService
        .updateUserRole(
          uid,
          role
        );


    return sendSuccess(

      res,

      200,

      "User role updated",

      serializeUser(updatedUser)

    );

  }

  catch (error) {

    console.error(error);


    return sendError(

      res,

      400,

      error.message

    );

  }

};


// =====================================================
// UPDATE STATUS
// Admin only
// =====================================================

const changeUserStatus = async (
  req,
  res
) => {

  try {

    const { uid } =
      req.params;

    const { status } =
      req.body;


    if (!status) {

      return sendError(

        res,

        400,

        "Status is required"

      );

    }


    if (
      req.user.uid === uid &&
      String(status).toLowerCase() ===
        "inactive"
    ) {

      return sendError(

        res,

        400,

        "You cannot deactivate your own account"

      );

    }


    const updatedUser =
      await userService
        .updateUserStatus(
          uid,
          status
        );


    return sendSuccess(

      res,

      200,

      "User status updated",

      serializeUser(updatedUser)

    );

  }

  catch (error) {

    console.error(error);


    return sendError(

      res,

      400,

      error.message

    );

  }

};


module.exports = {

  getUsers,

  changeUserRole,

  changeUserStatus,

};
