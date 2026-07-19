const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const COLLECTION = "seedlingInventory";

const inventoryCollection = db.collection(COLLECTION);

// AUTOMATIC STATUS
const calculateInventoryStatus = (availableQuantity) => {
  if (availableQuantity === 0) {
    return "Out of Stock";
  }

  if (availableQuantity <= 20) {
    return "Low Stock";
  }

  return "Available";
};

// CREATE INVENTORY
const createInventory = async (data) => {
  const now = Timestamp.now();

  const inventoryData = {
    ...data,
    availableQuantity: data.quantity,
    distributedQuantity: 0,
    status: calculateInventoryStatus(data.quantity),
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
  };

  const docRef = await inventoryCollection.add(inventoryData);

  return {
    id: docRef.id,
    ...inventoryData,
  };
};

// GET ALL INVENTORY
const getAllInventory = async ({ status, species } = {}) => {
  const snapshot = await inventoryCollection.get();

  let inventory = snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter((item) => item.isDeleted !== true);

  if (status) {
    inventory = inventory.filter(
      (item) =>
        item.status?.toLowerCase() ===
        status.toLowerCase()
    );
  }

  if (species) {
    inventory = inventory.filter((item) =>
      item.species
        ?.toLowerCase()
        .includes(species.toLowerCase())
    );
  }

  return inventory;
};

// GET INVENTORY BY ID
const getInventoryById = async (id) => {
  const doc = await inventoryCollection.doc(id).get();

  if (!doc.exists || doc.data().isDeleted === true) {
    throw new Error("Inventory not found.");
  }

  return {
    id: doc.id,
    ...doc.data(),
  };
};

// UPDATE INVENTORY DETAILS
const updateInventoryById = async (
  id,
  updateData,
  updatedBy
) => {
  const docRef = inventoryCollection.doc(id);
  const doc = await docRef.get();

  if (!doc.exists || doc.data().isDeleted === true) {
    throw new Error("Inventory not found.");
  }

  const allowedUpdates = {};

  if (updateData.species !== undefined) {
    allowedUpdates.species = updateData.species;
  }

  if (updateData.category !== undefined) {
    allowedUpdates.category = updateData.category;
  }

  if (updateData.description !== undefined) {
    allowedUpdates.description = updateData.description;
  }

  await docRef.update({
    ...allowedUpdates,
    updatedBy,
    updatedAt: Timestamp.now(),
  });

  const updatedDoc = await docRef.get();

  return {
    id: updatedDoc.id,
    ...updatedDoc.data(),
  };
};

// ADD STOCK
const addInventoryStock = async (
  id,
  quantityToAdd,
  updatedBy
) => {
  const docRef = inventoryCollection.doc(id);

  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);

    if (!doc.exists || doc.data().isDeleted === true) {
      throw new Error("Inventory not found.");
    }

    const currentData = doc.data();

    const newQuantity =
      currentData.quantity + quantityToAdd;

    const newAvailableQuantity =
      currentData.availableQuantity + quantityToAdd;

    const newStatus =
      calculateInventoryStatus(newAvailableQuantity);

    transaction.update(docRef, {
      quantity: newQuantity,
      availableQuantity: newAvailableQuantity,
      status: newStatus,
      updatedBy,
      updatedAt: Timestamp.now(),
    });
  });

  const updatedDoc = await docRef.get();

  return {
    id: updatedDoc.id,
    ...updatedDoc.data(),
  };
};

// SOFT DELETE INVENTORY
const deleteInventoryById = async (
  id,
  deletedBy
) => {
  const docRef = inventoryCollection.doc(id);
  const doc = await docRef.get();

  if (!doc.exists || doc.data().isDeleted === true) {
    throw new Error("Inventory not found.");
  }

  await docRef.update({
    isDeleted: true,
    deletedBy,
    deletedAt: Timestamp.now(),
    updatedBy: deletedBy,
    updatedAt: Timestamp.now(),
  });

  return {
    id,
  };
};

module.exports = {
  createInventory,
  getAllInventory,
  getInventoryById,
  updateInventoryById,
  addInventoryStock,
  deleteInventoryById,
  calculateInventoryStatus,
};