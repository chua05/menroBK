const {
  createInventory,
  getAllInventory,
  getInventoryById,
  updateInventoryById,
  addInventoryStock,
  deleteInventoryById,
} = require("../services/inventory.service");

// CREATE INVENTORY
const addInventory = async (req, res) => {
  try {
    const {
      species,
      category,
      quantity,
      description,
    } = req.body || {};

    if (
      !species?.trim() ||
      !category?.trim() ||
      quantity === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Species, category, and quantity are required.",
      });
    }

    if (!Number.isInteger(quantity)) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be an integer.",
      });
    }

    if (quantity < 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity cannot be negative.",
      });
    }

    const inventory = await createInventory({
      species: species.trim(),
      category: category.trim(),
      quantity,
      description: description?.trim() || "",
      createdBy: req.user.uid,
      updatedBy: "",
    });

    return res.status(201).json({
      success: true,
      message: "Inventory added successfully.",
      data: inventory,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET ALL INVENTORY
const getInventory = async (req, res) => {
  try {
    const { status, species } = req.query;

    const inventory = await getAllInventory({
      status,
      species,
    });

    return res.status(200).json({
      success: true,
      data: inventory,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve inventory.",
    });
  }
};

// GET INVENTORY BY ID
const getInventoryItem = async (req, res) => {
  try {
    const { id } = req.params;

    const inventory = await getInventoryById(id);

    return res.status(200).json({
      success: true,
      data: inventory,
    });
  } catch (error) {
    console.error(error);

    return res.status(404).json({
      success: false,
      message: error.message,
    });
  }
};

// UPDATE INVENTORY DETAILS
const updateInventory = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      species,
      category,
      description,
    } = req.body || {};

    if (
      species === undefined &&
      category === undefined &&
      description === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "No inventory fields provided.",
      });
    }

    if (
      species !== undefined &&
      !species.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Species cannot be empty.",
      });
    }

    if (
      category !== undefined &&
      !category.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Category cannot be empty.",
      });
    }

    const updateData = {};

    if (species !== undefined) {
      updateData.species = species.trim();
    }

    if (category !== undefined) {
      updateData.category = category.trim();
    }

    if (description !== undefined) {
      updateData.description =
        description.trim();
    }

    const inventory = await updateInventoryById(
      id,
      updateData,
      req.user.uid
    );

    return res.status(200).json({
      success: true,
      message: "Inventory updated successfully.",
      data: inventory,
    });
  } catch (error) {
    console.error(error);

    const statusCode =
      error.message === "Inventory not found."
        ? 404
        : 400;

    return res.status(statusCode).json({
      success: false,
      message: error.message,
    });
  }
};

// ADD STOCK
const addStock = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body || {};

    if (quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: "Stock quantity is required.",
      });
    }

    if (!Number.isInteger(quantity)) {
      return res.status(400).json({
        success: false,
        message:
          "Stock quantity must be an integer.",
      });
    }

    if (quantity <= 0) {
      return res.status(400).json({
        success: false,
        message:
          "Stock quantity must be greater than zero.",
      });
    }

    const inventory = await addInventoryStock(
      id,
      quantity,
      req.user.uid
    );

    return res.status(200).json({
      success: true,
      message: "Inventory stock added successfully.",
      data: inventory,
    });
  } catch (error) {
    console.error(error);

    const statusCode =
      error.message === "Inventory not found."
        ? 404
        : 400;

    return res.status(statusCode).json({
      success: false,
      message: error.message,
    });
  }
};

// DELETE INVENTORY
const deleteInventory = async (req, res) => {
  try {
    const { id } = req.params;

    await deleteInventoryById(
      id,
      req.user.uid
    );

    return res.status(200).json({
      success: true,
      message: "Inventory deleted successfully.",
    });
  } catch (error) {
    console.error(error);

    const statusCode =
      error.message === "Inventory not found."
        ? 404
        : 400;

    return res.status(statusCode).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  addInventory,
  getInventory,
  getInventoryItem,
  updateInventory,
  addStock,
  deleteInventory,
};