const authService = require("../services/auth.service");

const {
  sendSuccess,
  sendError
} = require("../utils/response.util");


// VERIFY USER
const verifyUser = async (req, res) => {

  try {

    const profile = await authService.createUserProfile(
      req.firebaseUser
    );

    return sendSuccess(
      res,
      200,
      "Authenticated",
      profile
    );

  }

  catch (error) {

    console.error(error);

    return sendError(
      res,
      500,
      "Authentication failed"
    );

  }

};


// GET PROFILE
const getProfile = async (req, res) => {

  try {

    const profile = await authService.getUserProfile(

      req.user.uid

    );


    return sendSuccess(

      res,

      200,

      "Profile retrieved",

      profile

    );

  }

  catch (error) {

  console.error(error);

  return sendError(

    res,

    500,

    error.message

  );

}};


// UPDATE PROFILE
const updateProfile = async (req, res) => {

  try {

    await authService.updateUserProfile(

      req.user.uid,

      req.body

    );


    return sendSuccess(

      res,

      200,

      "Profile updated"

    );

  }

  catch (error) {

    console.error(error);

    return sendError(

      res,

      500,

      error.message

    );

  }

};


// REGISTER
const register = async (req, res) => {

  try {

    const {

      fullName,
      username,
      email,
      contactNumber,
      password,
      organization

    } = req.body || {};



    if (

      typeof fullName !== "string" || !fullName.trim() ||

      typeof username !== "string" || !username.trim() ||

      typeof email !== "string" || !email.trim() ||

      typeof contactNumber !== "string" || !contactNumber.trim() ||

      typeof password !== "string" || !password

    ) {

      return sendError(
        res,
        400,
        "Required fields missing"
      );

    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedContactNumber = contactNumber.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return sendError(res, 400, "Invalid email address");
    }

    if (

      !/^09\d{9}$/.test(normalizedContactNumber)
      ){

      return sendError(
      res,
      400,
      "Invalid contact number"
      );
      }



    const user = await authService.registerUser({
      fullName: fullName.trim(),
      username: username.trim(),
      email: normalizedEmail,
      contactNumber: normalizedContactNumber,
      password,
      organization: typeof organization === "string" ? organization.trim() : ""
    });
    return sendSuccess(

      res,

      201,

      "Registration successful",

      user

    );

  }

  catch (error) {
    if (error.code === "auth/email-already-exists") {
      return sendError(res, 409, "Email is already registered.");
    }
    if (error.code === "auth/invalid-email" || error.code === "auth/invalid-password") {
      return sendError(res, 400, "Invalid registration details.");
    }
    console.error("Registration failed:", error);
    return sendError(res, 500, "Registration failed. Please try again.");

  }

};


module.exports = {

  register,

  verifyUser,

  getProfile,

  updateProfile

};
