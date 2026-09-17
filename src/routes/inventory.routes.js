const express = require("express");

const router = express.Router();

const {
  addInventory,
  getInventory,
  getAvailableInventory,
  getInventoryItem,
  updateInventory,
  addStock,
  deleteInventory,
  restoreInventory,
  getArchivedInventoryItems,
} = require("../controller/inventory.controller");

const {
  verifyToken,
} = require("../middleware/auth.middleware");

const {
  authorizeRoles,
} = require("../middleware/role.middleware");

// ========================================
// STAFF — CREATE INVENTORY
// ========================================

router.post(
  "/",
  verifyToken,
  authorizeRoles("staff"),
  addInventory
);

// ========================================
// PARTICIPANT — GET AVAILABLE SEEDLINGS
//
// IMPORTANT:
// Keep this BEFORE "/:id".
//
// This endpoint returns only seedlings
// that are currently available for request.
// ========================================

router.get(
  "/available",
  verifyToken,
  authorizeRoles("participant"),
  getAvailableInventory
);

// Keep the specific path before "/:id" so it is not treated as an item ID.
router.get(
  "/archived",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getArchivedInventoryItems
);

// ========================================
// ADMIN / STAFF — VIEW ALL INVENTORY
//
// Admin = view only
// Staff = inventory management
// ========================================

router.get(
  "/",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getInventory
);

// ========================================
// ADMIN / STAFF — VIEW ONE INVENTORY ITEM
//
// IMPORTANT:
// Keep this AFTER "/available".
// ========================================

router.get(
  "/:id",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getInventoryItem
);

// ========================================
// STAFF — UPDATE INVENTORY
// ========================================

router.patch(
  "/:id",
  verifyToken,
  authorizeRoles("staff"),
  updateInventory
);

// ========================================
// STAFF — ADD STOCK
// ========================================

router.patch(
  "/:id/stock",
  verifyToken,
  authorizeRoles("staff"),
  addStock
);

// ========================================
// STAFF — ARCHIVE / SOFT DELETE INVENTORY
// ========================================

router.delete(
  "/:id",
  verifyToken,
  authorizeRoles("staff"),
  deleteInventory
);

router.patch("/:id/restore", verifyToken, authorizeRoles("staff"), restoreInventory);

module.exports = router;
