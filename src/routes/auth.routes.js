const express = require("express");

const router = express.Router();


const {

  register,

  verifyUser,

  getProfile,

  updateProfile

} = require("../controller/auth.controller");


console.log(register);
console.log(verifyUser);
console.log(getProfile);
console.log(updateProfile);

const {

  verifyToken

} = require("../middleware/auth.middleware");

const {

  authorizeRoles

} = require("../middleware/role.middleware");


const {

  authLimiter

} = require("../middleware/rateLimiter.middleware");



// REGISTER
router.post(

  "/register",

  authLimiter,

  register

);


// VERIFY USER
router.post(

  "/verify",

  verifyToken,

  verifyUser

);


// GET PROFILE
router.get(

  "/profile",

  verifyToken,

  authorizeRoles ("participant",

    "admin",

    "staff"),

    getProfile

);


// UPDATE PROFILE
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


module.exports = router;