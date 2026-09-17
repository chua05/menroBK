const express =
  require("express");


const router =
  express.Router();


const {

  register,

  verifyUser,

  getProfile,

  updateProfile,

} = require(
  "../controller/auth.controller"
);


const {

  verifyToken,

  verifyTokenForBootstrap,

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