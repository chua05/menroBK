const {
  createInventory,
  getAllInventory,
  getArchivedInventory,
  getAvailableInventoryItems,
  getInventoryById,
  updateInventoryById,
  addInventoryStock,
  deleteInventoryById,
  restoreInventoryById,
} = require("../services/inventory.service");

// ========================================
// ALLOWED SOURCE / NURSERY VALUES
// ========================================

const ALLOWED_NURSERIES = [
  "Sorsogon Provincial Nursery",
  "Sorsogon Provincial Nursery in Barangay Cogon, Juban, Sorsogon",
];

// ========================================
// HELPER — VALIDATE SOURCE / NURSERY
// ========================================

const isValidNursery = (value) => {
  return ALLOWED_NURSERIES.includes(
    String(value || "").trim()
  );
};

// ========================================
// CREATE INVENTORY
// STAFF ONLY — ENFORCED BY ROUTE
// ========================================

const addInventory = async (req, res) => {
  try {
    const {
      species,
      scientificName,
      category,
      quantity,
      lowStockThreshold,
      dateReceived,
      sourceNursery,
      batchReference,
      description,
    } = req.body || {};

    // ========================================
    // REQUIRED FIELDS
    // ========================================

    if (
      !String(species || "").trim() ||
      !String(category || "").trim() ||
      quantity === undefined ||
      quantity === null ||
      quantity === "" ||
      !String(sourceNursery || "").trim()
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Tree name, category, initial quantity, and source/nursery are required.",
      });
    }

    // ========================================
    // SPECIES VALIDATION
    // ========================================

    const cleanSpecies =
      String(species).trim();

    if (cleanSpecies.length > 100) {
      return res.status(400).json({
        success: false,
        message:
          "Tree name is too long.",
      });
    }

    // ========================================
    // SCIENTIFIC NAME VALIDATION
    // ========================================

    const cleanScientificName =
      String(scientificName || "").trim();

    if (cleanScientificName.length > 150) {
      return res.status(400).json({
        success: false,
        message:
          "Scientific name is too long.",
      });
    }

    // ========================================
    // CATEGORY VALIDATION
    // ========================================

    const cleanCategory =
      String(category).trim();

    if (cleanCategory.length > 100) {
      return res.status(400).json({
        success: false,
        message:
          "Category is too long.",
      });
    }

    // ========================================
    // QUANTITY VALIDATION
    // ========================================

    const parsedQuantity =
      Number(quantity);

    if (
      !Number.isInteger(parsedQuantity)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity must be a whole number.",
      });
    }

    if (parsedQuantity < 0) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity cannot be negative.",
      });
    }

    // ========================================
    // LOW STOCK THRESHOLD
    // ========================================

    let parsedLowStockThreshold = 20;

    if (
      lowStockThreshold !== undefined &&
      lowStockThreshold !== null &&
      lowStockThreshold !== ""
    ) {
      parsedLowStockThreshold =
        Number(lowStockThreshold);

      if (
        !Number.isInteger(
          parsedLowStockThreshold
        ) ||
        parsedLowStockThreshold < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Low stock threshold must be a whole number of 0 or greater.",
        });
      }
    }

    // ========================================
    // SOURCE / NURSERY VALIDATION
    // ========================================

    const cleanSourceNursery =
      String(sourceNursery).trim();

    if (
      !isValidNursery(
        cleanSourceNursery
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid source/nursery selected.",
      });
    }

    // ========================================
    // DATE RECEIVED VALIDATION
    // ========================================

    const cleanDateReceived =
      String(dateReceived || "").trim();

    if (cleanDateReceived) {
      const parsedDate =
        new Date(
          `${cleanDateReceived}T00:00:00`
        );

      if (
        Number.isNaN(
          parsedDate.getTime()
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid date received.",
        });
      }
    }

    // ========================================
    // CREATE INVENTORY
    // ========================================

    const inventory =
      await createInventory({
        species:
          cleanSpecies,

        scientificName:
          cleanScientificName,

        category:
          cleanCategory,

        quantity:
          parsedQuantity,

        lowStockThreshold:
          parsedLowStockThreshold,

        dateReceived:
          cleanDateReceived,

        sourceNursery:
          cleanSourceNursery,

        batchReference:
          String(
            batchReference || ""
          ).trim(),

        description:
          String(
            description || ""
          ).trim(),

        createdBy:
          req.user.uid,

        updatedBy:
          req.user.uid,
      });

    return res.status(201).json({
      success: true,
      message:
        "Seedling record added successfully.",
      data: inventory,
    });
  } catch (error) {
    console.error(
      "addInventory error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        error.message ||
        "Failed to add seedling inventory.",
    });
  }
};

// ========================================
// GET ALL INVENTORY
// ADMIN / STAFF
// ========================================

const getInventory = async (
  req,
  res
) => {
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

    return res.status(200).json({
      success: true,
      data: inventory,
    });
  } catch (error) {
    console.error(
      "getInventory error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to retrieve inventory.",
    });
  }
};

// ========================================
// PARTICIPANT — AVAILABLE INVENTORY
// ========================================

const getAvailableInventory =
  async (req, res) => {
    try {
      const inventory =
        await getAvailableInventoryItems();

      return res.status(200).json({
        success: true,
        data: inventory,
      });
    } catch (error) {
      console.error(
        "getAvailableInventory error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to retrieve available seedlings.",
      });
    }
  };

// ========================================
// GET ONE INVENTORY ITEM
// ========================================

const getInventoryItem = async (
  req,
  res
) => {
  try {
    const { id } =
      req.params;

    const inventory =
      await getInventoryById(id);

    return res.status(200).json({
      success: true,
      data: inventory,
    });
  } catch (error) {
    console.error(
      "getInventoryItem error:",
      error
    );

    return res.status(404).json({
      success: false,
      message:
        error.message,
    });
  }
};

// ========================================
// UPDATE INVENTORY
// STAFF ONLY — ENFORCED BY ROUTE
// ========================================

const updateInventory = async (
  req,
  res
) => {
  try {
    const { id } =
      req.params;

    const {
      species,
      scientificName,
      category,
      quantity,
      lowStockThreshold,
      dateReceived,
      sourceNursery,
      batchReference,
      description,
    } = req.body || {};

    if (
      species === undefined &&
      scientificName === undefined &&
      category === undefined &&
      quantity === undefined &&
      lowStockThreshold === undefined &&
      dateReceived === undefined &&
      sourceNursery === undefined &&
      batchReference === undefined &&
      description === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "No inventory fields provided.",
      });
    }

    const updateData = {};

    // ========================================
    // TREE NAME
    // ========================================

    if (species !== undefined) {
      const value =
        String(species).trim();

      if (!value) {
        return res.status(400).json({
          success: false,
          message:
            "Tree name cannot be empty.",
        });
      }

      if (value.length > 100) {
        return res.status(400).json({
          success: false,
          message:
            "Tree name is too long.",
        });
      }

      updateData.species =
        value;
    }

    // ========================================
    // SCIENTIFIC NAME
    // ========================================

    if (
      scientificName !== undefined
    ) {
      const value =
        String(
          scientificName || ""
        ).trim();

      if (value.length > 150) {
        return res.status(400).json({
          success: false,
          message:
            "Scientific name is too long.",
        });
      }

      updateData.scientificName =
        value;
    }

    // ========================================
    // CATEGORY
    // ========================================

    if (category !== undefined) {
      const value =
        String(category).trim();

      if (!value) {
        return res.status(400).json({
          success: false,
          message:
            "Category cannot be empty.",
        });
      }

      updateData.category =
        value;
    }

    // ========================================
    // TOTAL QUANTITY
    // ========================================

    if (quantity !== undefined) {
      if (
        quantity === null ||
        quantity === ""
      ) {
        return res.status(400).json({
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
        return res.status(400).json({
          success: false,
          message:
            "Quantity must be a whole number.",
        });
      }

      if (parsedQuantity < 0) {
        return res.status(400).json({
          success: false,
          message:
            "Quantity cannot be negative.",
        });
      }

      updateData.quantity =
        parsedQuantity;
    }

    // ========================================
    // LOW STOCK THRESHOLD
    // ========================================

    if (
      lowStockThreshold !== undefined
    ) {
      if (
        lowStockThreshold === null ||
        lowStockThreshold === ""
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Low stock threshold is required.",
        });
      }

      const parsedThreshold =
        Number(lowStockThreshold);

      if (
        !Number.isInteger(
          parsedThreshold
        ) ||
        parsedThreshold < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Low stock threshold must be a whole number of 0 or greater.",
        });
      }

      updateData.lowStockThreshold =
        parsedThreshold;
    }

    // ========================================
    // SOURCE / NURSERY
    // ========================================

    if (
      sourceNursery !== undefined
    ) {
      const value =
        String(
          sourceNursery || ""
        ).trim();

      if (!value) {
        return res.status(400).json({
          success: false,
          message:
            "Source/nursery cannot be empty.",
        });
      }

      if (!isValidNursery(value)) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid source/nursery selected.",
        });
      }

      updateData.sourceNursery =
        value;
    }

    // ========================================
    // DATE RECEIVED
    // ========================================

    if (
      dateReceived !== undefined
    ) {
      const value =
        String(
          dateReceived || ""
        ).trim();

      if (value) {
        const parsedDate =
          new Date(
            `${value}T00:00:00`
          );

        if (
          Number.isNaN(
            parsedDate.getTime()
          )
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Invalid date received.",
          });
        }
      }

      updateData.dateReceived =
        value;
    }

    // ========================================
    // BATCH / REFERENCE
    // ========================================

    if (
      batchReference !== undefined
    ) {
      updateData.batchReference =
        String(
          batchReference || ""
        ).trim();
    }

    // ========================================
    // DESCRIPTION / NOTES
    // ========================================

    if (
      description !== undefined
    ) {
      updateData.description =
        String(
          description || ""
        ).trim();
    }

    const inventory =
      await updateInventoryById(
        id,
        updateData,
        req.user.uid
      );

    return res.status(200).json({
      success: true,
      message:
        "Seedling record updated successfully.",
      data: inventory,
    });
  } catch (error) {
    console.error(
      "updateInventory error:",
      error
    );

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
// STAFF ONLY — ENFORCED BY ROUTE
// ========================================

const addStock = async (
  req,
  res
) => {
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
      return res.status(400).json({
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
      return res.status(400).json({
        success: false,
        message:
          "Stock quantity must be a whole number.",
      });
    }

    if (parsedQuantity <= 0) {
      return res.status(400).json({
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

    return res.status(200).json({
      success: true,
      message:
        "Seedling stock added successfully.",
      data: inventory,
    });
  } catch (error) {
    console.error(
      "addStock error:",
      error
    );

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
// ARCHIVE / SOFT DELETE INVENTORY
// STAFF ONLY — ENFORCED BY ROUTE
// ========================================

const deleteInventory = async (
  req,
  res
) => {
  try {
    const { id } =
      req.params;

    await deleteInventoryById(
      id,
      req.user.uid
    );

    return res.status(200).json({
      success: true,
      message:
        "Seedling record archived successfully.",
    });
  } catch (error) {
    console.error(
      "deleteInventory error:",
      error
    );

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

const restoreInventory = async (req, res) => {
  try {
    const inventory = await restoreInventoryById(req.params.id, req.user.uid);
    return res.status(200).json({ success: true, message: "Seedling record restored successfully.", data: inventory });
  } catch (error) {
    if (error.message === "Archived inventory not found.") {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to restore seedling inventory." });
  }
};

const getArchivedInventoryItems = async (req, res) => {
  try {
    return res.status(200).json({ success: true, data: await getArchivedInventory() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to retrieve archived inventory." });
  }
};

module.exports = {
  addInventory,
  getInventory,
  getAvailableInventory,
  getInventoryItem,
  updateInventory,
  addStock,
  deleteInventory,
  restoreInventory,
  getArchivedInventoryItems,
};
