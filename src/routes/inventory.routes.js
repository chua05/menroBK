const express = require("express");

const router = express.Router();

const {
  addInventory,
  getInventory,
  getInventoryItem,
  updateInventory,
  addStock,
  deleteInventory,
} = require("../controller/inventory.controller");

const {
  verifyToken,
} = require("../middleware/auth.middleware");

const {
  authorizeRoles,
} = require("../middleware/role.middleware");

// CREATE INVENTORY — ADMIN ONLY
router.post(
  "/",
  verifyToken,
  authorizeRoles("admin"),
  addInventory
);

// GET ALL INVENTORY — ADMIN AND STAFF
router.get(
  "/",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getInventory
);

// GET INVENTORY BY ID — ADMIN AND STAFF
router.get(
  "/:id",
  verifyToken,
  authorizeRoles("admin", "staff"),
  getInventoryItem
);

// UPDATE INVENTORY DETAILS — ADMIN ONLY
router.patch(
  "/:id",
  verifyToken,
  authorizeRoles("admin"),
  updateInventory
);

// ADD STOCK — ADMIN ONLY
router.patch(
  "/:id/stock",
  verifyToken,
  authorizeRoles("admin"),
  addStock
);

// DELETE INVENTORY — ADMIN ONLY
router.delete(
  "/:id",
  verifyToken,
  authorizeRoles("admin"),
  deleteInventory
);

module.exports = router;