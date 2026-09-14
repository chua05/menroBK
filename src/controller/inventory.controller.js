const {
  createInventory,
  getAllInventory,
  getInventoryById,
  updateInventoryById,
  addInventoryStock,
  deleteInventoryById,
} = require(
  "../services/inventory.service"
);

// ========================================
// CREATE INVENTORY
// ========================================
const addInventory =
  async (req, res) => {
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
        quantity === undefined ||
        quantity === null ||
        quantity === ""
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Species, category, and quantity are required.",
          });
      }

      const parsedQuantity =
        Number(quantity);

      if (
        !Number.isInteger(
          parsedQuantity
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Quantity must be a whole number.",
          });
      }

      if (
        parsedQuantity < 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Quantity cannot be negative.",
          });
      }

      if (
        species.trim().length >
        100
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Species name is too long.",
          });
      }

      const inventory =
        await createInventory({
          species:
            species.trim(),

          category:
            category.trim(),

          quantity:
            parsedQuantity,

          description:
            description?.trim() ||
            "",

          createdBy:
            req.user.uid,

          updatedBy: "",
        });

      return res
        .status(201)
        .json({
          success: true,

          message:
            "Seedling record added successfully.",

          data:
            inventory,
        });
    } catch (error) {
      console.error(error);

      return res
        .status(500)
        .json({
          success: false,
          message:
            error.message,
        });
    }
  };

// ========================================
// GET ALL INVENTORY
// ========================================
const getInventory =
  async (req, res) => {
    try {
      const {
        status,
        species,
      } = req.query;

      const inventory =
        await getAllInventory({
          status,
          species,
        });

      return res
        .status(200)
        .json({
          success: true,
          data: inventory,
        });
    } catch (error) {
      console.error(error);

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Failed to retrieve inventory.",
        });
    }
  };

// ========================================
// GET ONE
// ========================================
const getInventoryItem =
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const inventory =
        await getInventoryById(
          id
        );

      return res
        .status(200)
        .json({
          success: true,
          data: inventory,
        });
    } catch (error) {
      console.error(error);

      return res
        .status(404)
        .json({
          success: false,
          message:
            error.message,
        });
    }
  };

// ========================================
// UPDATE INVENTORY
// ========================================
const updateInventory =
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        species,
        category,
        quantity,
        description,
      } = req.body || {};

      if (
        species === undefined &&
        category === undefined &&
        quantity === undefined &&
        description === undefined
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "No inventory fields provided.",
          });
      }

      if (
        species !== undefined &&
        !String(species).trim()
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Species cannot be empty.",
          });
      }

      if (
        category !== undefined &&
        !String(category).trim()
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Category cannot be empty.",
          });
      }

      const updateData = {};

      if (
        species !== undefined
      ) {
        updateData.species =
          String(
            species
          ).trim();
      }

      if (
        category !== undefined
      ) {
        updateData.category =
          String(
            category
          ).trim();
      }

      if (
        description !==
        undefined
      ) {
        updateData.description =
          String(
            description
          ).trim();
      }

      if (
        quantity !== undefined
      ) {
        if (
          quantity === null ||
          quantity === ""
        ) {
          return res
            .status(400)
            .json({
              success: false,
              message:
                "Quantity is required.",
            });
        }

        const parsedQuantity =
          Number(quantity);

        if (
          !Number.isInteger(
            parsedQuantity
          )
        ) {
          return res
            .status(400)
            .json({
              success: false,
              message:
                "Quantity must be a whole number.",
            });
        }

        if (
          parsedQuantity < 0
        ) {
          return res
            .status(400)
            .json({
              success: false,
              message:
                "Quantity cannot be negative.",
            });
        }

        updateData.quantity =
          parsedQuantity;
      }

      const inventory =
        await updateInventoryById(
          id,
          updateData,
          req.user.uid
        );

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Seedling record updated successfully.",

          data:
            inventory,
        });
    } catch (error) {
      console.error(error);

      const statusCode =
        error.message ===
        "Inventory not found."
          ? 404
          : 400;

      return res
        .status(statusCode)
        .json({
          success: false,
          message:
            error.message,
        });
    }
  };

// ========================================
// ADD STOCK
// ========================================
const addStock =
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const { quantity } =
        req.body || {};

      if (
        quantity === undefined ||
        quantity === null ||
        quantity === ""
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Stock quantity is required.",
          });
      }

      const parsedQuantity =
        Number(quantity);

      if (
        !Number.isInteger(
          parsedQuantity
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Stock quantity must be a whole number.",
          });
      }

      if (
        parsedQuantity <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Stock quantity must be greater than zero.",
          });
      }

      const inventory =
        await addInventoryStock(
          id,
          parsedQuantity,
          req.user.uid
        );

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Seedling stock added successfully.",

          data:
            inventory,
        });
    } catch (error) {
      console.error(error);

      const statusCode =
        error.message ===
        "Inventory not found."
          ? 404
          : 400;

      return res
        .status(statusCode)
        .json({
          success: false,
          message:
            error.message,
        });
    }
  };

// ========================================
// DELETE INVENTORY
// ========================================
const deleteInventory =
  async (req, res) => {
    try {
      const { id } =
        req.params;

      await deleteInventoryById(
        id,
        req.user.uid
      );

      return res
        .status(200)
        .json({
          success: true,
          message:
            "Seedling record deleted successfully.",
        });
    } catch (error) {
      console.error(error);

      const statusCode =
        error.message ===
        "Inventory not found."
          ? 404
          : 400;

      return res
        .status(statusCode)
        .json({
          success: false,
          message:
            error.message,
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