const express =
  require("express");


const router =
  express.Router();


const {

  register,

  verifyUser,

  getProfile,

  updateProfile,
  resendVerification,

} = require(
  "../controller/auth.controller"
);


const {

  verifyToken,

  verifyTokenForBootstrap,
  verifyTokenForVerificationEmail,

} = require(
  "../middleware/auth.middleware"
);


const {

  authorizeRoles,

} = require(
  "../middleware/role.middleware"
);


const {

  authLimiter,

} = require(
  "../middleware/rateLimiter.middleware"
);


// =====================================================
// REGISTER
// =====================================================

router.post(

  "/register",

  authLimiter,

  register

);

router.post(
  "/resend-verification",
  authLimiter,
  verifyTokenForVerificationEmail,
  resendVerification
);


// =====================================================
// VERIFY USER
// =====================================================

router.post(

  "/verify",

  verifyTokenForBootstrap,

  verifyUser

);


// =====================================================
// GET PROFILE
// =====================================================

router.get(

  "/profile",

  verifyToken,

  authorizeRoles(

    "participant",

    "admin",

    "staff"

  ),

  getProfile

);


// =====================================================
// GET CURRENT AUTHENTICATED USER
// =====================================================

router.get(

  "/me",

  verifyToken,

  authorizeRoles(

    "participant",

    "admin",

    "staff"

  ),

  getProfile

);


// =====================================================
// UPDATE PROFILE
// =====================================================

router.put(

  "/profile",

  verifyToken,

  authorizeRoles(

    "participant",

    "admin",

    "staff"

  ),

  updateProfile

);


module.exports =
  router;
