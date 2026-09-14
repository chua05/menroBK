const express = require("express");

const router = express.Router();

const {
  createSite,
  getAllSites,
  getArchivedSites,
  getSiteById,
  archiveSite,
  restoreSite,
} = require(
  "../controller/site.controller"
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

// --------------------------------
// CREATE SITE
// Admin / Staff
// --------------------------------
router.post(
  "/",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  createSite
);

// --------------------------------
// GET ALL ACTIVE SITES
// All authenticated users
// --------------------------------
router.get(
  "/",
  verifyToken,
  getAllSites
);

// --------------------------------
// GET ARCHIVED SITES
// Admin / Staff
//
// IMPORTANT:
// Keep this BEFORE "/:id"
// --------------------------------
router.get(
  "/archived",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  getArchivedSites
);

// --------------------------------
// ARCHIVE SITE
// Admin / Staff
// --------------------------------
router.patch(
  "/:id/archive",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  archiveSite
);

// --------------------------------
// RESTORE SITE
// Admin / Staff
// --------------------------------
router.patch(
  "/:id/restore",
  verifyToken,
  authorizeRoles(
    "admin",
    "staff"
  ),
  restoreSite
);

// --------------------------------
// GET SITE BY ID
// All authenticated users
//
// Keep this AFTER "/archived"
// --------------------------------
router.get(
  "/:id",
  verifyToken,
  getSiteById
);

module.exports = router;