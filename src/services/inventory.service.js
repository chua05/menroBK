const { db } = require("../config/firebase");

const {
  Timestamp,
} = require("firebase-admin/firestore");

const COLLECTION =
  "seedlingInventory";

const inventoryCollection =
  db.collection(COLLECTION);

// ========================================
// AUTOMATIC STATUS
// ========================================
const calculateInventoryStatus = (
  availableQuantity
) => {
  if (availableQuantity === 0) {
    return "Out of Stock";
  }

  if (availableQuantity <= 20) {
    return "Low Stock";
  }

  return "Available";
};

// ========================================
// CREATE INVENTORY
// ========================================
const createInventory = async (
  data
) => {
  const now =
    Timestamp.now();

  const quantity =
    Number(data.quantity);

  const inventoryData = {
    ...data,

    quantity,

    availableQuantity:
      quantity,

    // Approved requests that are
    // not yet physically released.
    reservedQuantity: 0,

    // Actual released seedlings.
    distributedQuantity: 0,

    status:
      calculateInventoryStatus(
        quantity
      ),

    isDeleted: false,

    createdAt: now,
    updatedAt: now,
  };

  const docRef =
    await inventoryCollection.add(
      inventoryData
    );

  return {
    id: docRef.id,
    ...inventoryData,
  };
};

// ========================================
// GET ALL INVENTORY
// ========================================
const getAllInventory = async (
  {
    status,
    species,
  } = {}
) => {
  const snapshot =
    await inventoryCollection.get();

  let inventory =
    snapshot.docs
      .map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }))
      .filter(
        (item) =>
          item.isDeleted !== true
      );

  if (status) {
    inventory =
      inventory.filter(
        (item) =>
          item.status
            ?.toLowerCase() ===
          status.toLowerCase()
      );
  }

  if (species) {
    inventory =
      inventory.filter(
        (item) =>
          item.species
            ?.toLowerCase()
            .includes(
              species.toLowerCase()
            )
      );
  }

  return inventory;
};

// ========================================
// GET INVENTORY BY ID
// ========================================
const getInventoryById =
  async (id) => {
    const doc =
      await inventoryCollection
        .doc(id)
        .get();

    if (
      !doc.exists ||
      doc.data().isDeleted === true
    ) {
      throw new Error(
        "Inventory not found."
      );
    }

    return {
      id: doc.id,
      ...doc.data(),
    };
  };

// ========================================
// UPDATE INVENTORY DETAILS + QUANTITY
// ========================================
const updateInventoryById =
  async (
    id,
    updateData,
    updatedBy
  ) => {
    const docRef =
      inventoryCollection.doc(id);

    await db.runTransaction(
      async (transaction) => {
        const doc =
          await transaction.get(
            docRef
          );

        if (
          !doc.exists ||
          doc.data().isDeleted ===
            true
        ) {
          throw new Error(
            "Inventory not found."
          );
        }

        const currentData =
          doc.data();

        const updates = {};

        if (
          updateData.species !==
          undefined
        ) {
          updates.species =
            updateData.species;
        }

        if (
          updateData.category !==
          undefined
        ) {
          updates.category =
            updateData.category;
        }

        if (
          updateData.description !==
          undefined
        ) {
          updates.description =
            updateData.description;
        }

        // --------------------------------
        // QUANTITY EDIT
        // --------------------------------
        if (
          updateData.quantity !==
          undefined
        ) {
          const newQuantity =
            Number(
              updateData.quantity
            );

          if (
            !Number.isInteger(
              newQuantity
            )
          ) {
            throw new Error(
              "Quantity must be a whole number."
            );
          }

          if (newQuantity < 0) {
            throw new Error(
              "Quantity cannot be negative."
            );
          }

          const reservedQuantity =
            Number(
              currentData
                .reservedQuantity || 0
            );

          const distributedQuantity =
            Number(
              currentData
                .distributedQuantity ||
                0
            );

          const committedQuantity =
            reservedQuantity +
            distributedQuantity;

          // You cannot reduce total stock
          // below seedlings already reserved
          // or distributed.
          if (
            newQuantity <
            committedQuantity
          ) {
            throw new Error(
              `Quantity cannot be lower than ${committedQuantity} because those seedlings are already reserved or distributed.`
            );
          }

          const newAvailableQuantity =
            newQuantity -
            committedQuantity;

          updates.quantity =
            newQuantity;

          updates.availableQuantity =
            newAvailableQuantity;

          updates.status =
            calculateInventoryStatus(
              newAvailableQuantity
            );
        }

        transaction.update(
          docRef,
          {
            ...updates,

            updatedBy,

            updatedAt:
              Timestamp.now(),
          }
        );
      }
    );

    const updatedDoc =
      await docRef.get();

    return {
      id: updatedDoc.id,
      ...updatedDoc.data(),
    };
  };

// ========================================
// ADD STOCK
// ========================================
const addInventoryStock =
  async (
    id,
    quantityToAdd,
    updatedBy
  ) => {
    const docRef =
      inventoryCollection.doc(id);

    await db.runTransaction(
      async (transaction) => {
        const doc =
          await transaction.get(
            docRef
          );

        if (
          !doc.exists ||
          doc.data().isDeleted ===
            true
        ) {
          throw new Error(
            "Inventory not found."
          );
        }

        const currentData =
          doc.data();

        const currentQuantity =
          Number(
            currentData.quantity || 0
          );

        const currentAvailable =
          Number(
            currentData
              .availableQuantity || 0
          );

        const newQuantity =
          currentQuantity +
          quantityToAdd;

        const newAvailableQuantity =
          currentAvailable +
          quantityToAdd;

        const newStatus =
          calculateInventoryStatus(
            newAvailableQuantity
          );

        transaction.update(
          docRef,
          {
            quantity:
              newQuantity,

            availableQuantity:
              newAvailableQuantity,

            status:
              newStatus,

            updatedBy,

            updatedAt:
              Timestamp.now(),
          }
        );
      }
    );

    const updatedDoc =
      await docRef.get();

    return {
      id: updatedDoc.id,
      ...updatedDoc.data(),
    };
  };

// ========================================
// SOFT DELETE INVENTORY
// ========================================
const deleteInventoryById =
  async (
    id,
    deletedBy
  ) => {
    const docRef =
      inventoryCollection.doc(id);

    const doc =
      await docRef.get();

    if (
      !doc.exists ||
      doc.data().isDeleted === true
    ) {
      throw new Error(
        "Inventory not found."
      );
    }

    const data =
      doc.data();

    const reservedQuantity =
      Number(
        data.reservedQuantity || 0
      );

    if (
      reservedQuantity > 0
    ) {
      throw new Error(
        "This seedling record cannot be deleted because it has approved seedlings waiting for release."
      );
    }

    await docRef.update({
      isDeleted: true,

      deletedBy,

      deletedAt:
        Timestamp.now(),

      updatedBy:
        deletedBy,

      updatedAt:
        Timestamp.now(),
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