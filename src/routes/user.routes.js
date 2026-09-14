const express =
  require("express");


const router =
  express.Router();


const {

  getUsers,

  changeUserRole,

  changeUserStatus,

} = require(
  "../controller/user.controller"
);


const {

  verifyToken,

} = require(
  "../middleware/auth.middleware"
);


const {

  authorizeRoles,

} = require(
  "../middleware/role.middleware"
);


// =====================================================
// GET ALL REGISTERED USERS
// Admin + Staff
// =====================================================

router.get(

  "/",

  verifyToken,

  authorizeRoles(
    "admin",
    "staff"
  ),

  getUsers

);


// =====================================================
// UPDATE USER ROLE
// Admin only
// =====================================================

router.patch(

  "/:uid/role",

  verifyToken,

  authorizeRoles(
    "admin"
  ),

  changeUserRole

);


// =====================================================
// UPDATE USER STATUS
// Admin only
// =====================================================

router.patch(

  "/:uid/status",

  verifyToken,

  authorizeRoles(
    "admin"
  ),

  changeUserStatus

);


module.exports =
  router;