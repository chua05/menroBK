const authService = require("../services/auth.service");

const {
  sendSuccess,
  sendError
} = require("../utils/response.util");


// VERIFY USER
const verifyUser = async (req, res) => {

  try {

    const profile = await authService.createUserProfile(
      req.user
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

    } = req.body;



    if (

      !fullName ||

      !username ||

      !email ||

      !contactNumber ||

      !password

    ) {

      return sendError(
        res,
        400,
        "Required fields missing"
      );

    }

    if (

      !/^09\d{9}$/.test(contactNumber)
      ){

      return sendError(
      res,
      400,
      "Invalid contact number"
      );
      }



    const user = await authService.registerUser({
      fullName,
      username,
      email,
      contactNumber,
      password,
      organization
    });
    return sendSuccess(

      res,

      201,

      "Registration successful",

      user

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

  register,

  verifyUser,

  getProfile,

  updateProfile

};