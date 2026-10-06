const {
  createInventory, getAllInventory, getArchivedInventory, getAvailableInventoryItems,
  getInventoryById, updateInventoryById, addInventoryStock,
  deleteInventoryById, restoreInventoryById,
} = require("../services/inventory.service");
const { SAPLING_SPECIES, findSaplingSpecies } = require("../data/saplingSpecies");

const ALLOWED_CATEGORIES = Object.freeze([
  "Native Tree", "Fruit Tree", "Hardwood", "Mangrove", "Ornamental", "Other",
]);
const ALLOWED_STOCK_STATUSES = Object.freeze(["Available", "Limited", "Out of Stock"]);
const ALLOWED_SOURCE_TYPES = Object.freeze([
  "MENRO Propagation", "DENR / PENRO", "Provincial Government",
  "Other Government Office", "Donation", "Wildling Collection",
  "Sorsogon Provincial Nursery", "Other",
]);
const ALLOWED_STORAGE_LOCATIONS = Object.freeze([
  "MENRO Nursery", "Temporary Holding / Storage Area", "Other",
]);
const clean = (value) => String(value ?? "").trim();

function parseWholeNumber(value, label) {
  if (value === undefined || value === null || value === "") throw new Error(`${label} is required.`);
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${label} must be a whole number.`);
  if (number < 0) throw new Error(`${label} cannot be negative.`);
  return number;
}

function validateDateReceived(value) {
  const dateReceived = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateReceived)) throw new Error("Date received is required.");
  const parsed = new Date(`${dateReceived}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date received.");
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (parsed > today) throw new Error("Date received cannot be in the future.");
  return dateReceived;
}

function requiredChoice(value, allowed, label) {
  const normalized = clean(value);
  if (!allowed.includes(normalized)) throw new Error(`Invalid ${label.toLowerCase()} selected.`);
  return normalized;
}

function otherSpecification(choice, specification, label) {
  const value = clean(specification);
  if (choice === "Other" && !value) throw new Error(`${label} is required when Other is selected.`);
  if (value.length > 150) throw new Error(`${label} is too long.`);
  return choice === "Other" ? value : "";
}

function normalizeStockStatus(value, quantity) {
  if (quantity === 0) return "Out of Stock";
  const status = requiredChoice(value, ALLOWED_STOCK_STATUSES, "stock status");
  if (status === "Out of Stock") throw new Error("Positive inventory must be Available or Limited.");
  return status;
}

const getSpeciesMaster = (req, res) =>
  res.status(200).json({ success: true, data: SAPLING_SPECIES });

const addInventory = async (req, res) => {
  try {
    if (req.body?.batchReference !== undefined || req.body?.inventoryNumber !== undefined) {
      return res.status(400).json({ success: false, message: "Batch references are generated automatically when saved." });
    }
    const species = findSaplingSpecies(req.body?.species || req.body?.treeName);
    if (!species) throw new Error("Tree name must match the MENRO species list.");
    const category = requiredChoice(req.body?.category, ALLOWED_CATEGORIES, "category / type");
    const categorySpecification = otherSpecification(category, req.body?.categorySpecification, "Category / type specification");
    const initialQuantity = parseWholeNumber(req.body?.initialQuantity ?? req.body?.quantity, "Initial quantity");
    const stockStatus = normalizeStockStatus(req.body?.stockStatus ?? req.body?.status, initialQuantity);
    const sourceType = requiredChoice(req.body?.sourceType, ALLOWED_SOURCE_TYPES, "source type");
    const sourceSpecification = otherSpecification(sourceType, req.body?.sourceSpecification, "Source specification");
    const storageLocation = requiredChoice(req.body?.storageLocation, ALLOWED_STORAGE_LOCATIONS, "nursery / storage location");
    const storageLocationSpecification = otherSpecification(storageLocation, req.body?.storageLocationSpecification, "Nursery / storage location specification");
    const description = clean(req.body?.description);
    if (description.length > 500) throw new Error("Description must not exceed 500 characters.");

    const inventory = await createInventory({
      species: species.treeName,
      scientificName: species.scientificName,
      category, categorySpecification, initialQuantity, stockStatus,
      sourceType, sourceSpecification,
      dateReceived: validateDateReceived(req.body?.dateReceived),
      storageLocation, storageLocationSpecification, description,
      createdBy: req.user.uid, updatedBy: req.user.uid,
    });
    return res.status(201).json({ success: true, message: "Sapling batch added successfully.", data: inventory });
  } catch (error) {
    const expected = /required|invalid|must|cannot|match|automatically|too long|positive inventory/i.test(error.message);
    if (!expected) console.error("addInventory error:", error);
    return res.status(expected ? 400 : 500).json({ success: false, message: error.message || "Failed to add seedling inventory." });
  }
};

const getInventory = async (req, res) => {
  try { return res.status(200).json({ success: true, data: await getAllInventory(req.query) }); }
  catch (error) { console.error("getInventory error:", error); return res.status(500).json({ success: false, message: "Failed to retrieve inventory." }); }
};

const getAvailableInventory = async (req, res) => {
  try { return res.status(200).json({ success: true, data: await getAvailableInventoryItems() }); }
  catch (error) { console.error("getAvailableInventory error:", error); return res.status(500).json({ success: false, message: "Failed to retrieve available seedlings." }); }
};

const getInventoryItem = async (req, res) => {
  try { return res.status(200).json({ success: true, data: await getInventoryById(req.params.id) }); }
  catch (error) { return res.status(404).json({ success: false, message: error.message }); }
};

const updateInventory = async (req, res) => {
  try {
    const immutable = ["batchReference", "inventoryNumber", "initialQuantity", "quantity", "species", "scientificName"];
    if (immutable.some((field) => req.body?.[field] !== undefined)) {
      return res.status(400).json({ success: false, message: "Species, batch reference, and historical initial quantity cannot be changed during ordinary editing." });
    }
    const updateData = {};
    if (req.body?.stockStatus !== undefined) {
      const current = await getInventoryById(req.params.id);
      updateData.stockStatus = normalizeStockStatus(req.body.stockStatus, Number(current.currentQuantity ?? current.availableQuantity ?? 0));
    }
    if (req.body?.sourceType !== undefined) {
      updateData.sourceType = requiredChoice(req.body.sourceType, ALLOWED_SOURCE_TYPES, "source type");
      updateData.sourceSpecification = otherSpecification(updateData.sourceType, req.body.sourceSpecification, "Source specification");
    }
    if (req.body?.storageLocation !== undefined) {
      updateData.storageLocation = requiredChoice(req.body.storageLocation, ALLOWED_STORAGE_LOCATIONS, "nursery / storage location");
      updateData.storageLocationSpecification = otherSpecification(updateData.storageLocation, req.body.storageLocationSpecification, "Nursery / storage location specification");
    }
    if (req.body?.description !== undefined) {
      updateData.description = clean(req.body.description);
      if (updateData.description.length > 500) throw new Error("Description must not exceed 500 characters.");
    }
    if (Object.keys(updateData).length === 0) throw new Error("No editable inventory fields provided.");
    const inventory = await updateInventoryById(req.params.id, updateData, req.user.uid);
    return res.status(200).json({ success: true, message: "Seedling record updated successfully.", data: inventory });
  } catch (error) {
    return res.status(error.message === "Inventory not found." ? 404 : 400).json({ success: false, message: error.message });
  }
};

const addStock = async (req, res) => {
  try {
    const quantity = parseWholeNumber(req.body?.quantity, "Stock quantity");
    if (quantity === 0) throw new Error("Stock quantity must be greater than zero.");
    const inventory = await addInventoryStock(req.params.id, quantity, req.user.uid);
    return res.status(200).json({ success: true, message: "Seedling stock adjustment added successfully.", data: inventory });
  } catch (error) {
    return res.status(error.message === "Inventory not found." ? 404 : 400).json({ success: false, message: error.message });
  }
};

const deleteInventory = async (req, res) => {
  try { await deleteInventoryById(req.params.id, req.user.uid); return res.status(200).json({ success: true, message: "Seedling record archived successfully." }); }
  catch (error) { return res.status(error.message === "Inventory not found." ? 404 : 400).json({ success: false, message: error.message }); }
};

const restoreInventory = async (req, res) => {
  try { return res.status(200).json({ success: true, message: "Seedling record restored successfully.", data: await restoreInventoryById(req.params.id, req.user.uid) }); }
  catch (error) { return res.status(error.message === "Archived inventory not found." ? 404 : 500).json({ success: false, message: error.message }); }
};

const getArchivedInventoryItems = async (req, res) => {
  try { return res.status(200).json({ success: true, data: await getArchivedInventory() }); }
  catch (error) { return res.status(500).json({ success: false, message: "Failed to retrieve archived inventory." }); }
};

module.exports = {
  ALLOWED_CATEGORIES, ALLOWED_SOURCE_TYPES, ALLOWED_STORAGE_LOCATIONS,
  addInventory, getSpeciesMaster, getInventory, getAvailableInventory, getInventoryItem,
  updateInventory, addStock, deleteInventory, restoreInventory, getArchivedInventoryItems,
};
