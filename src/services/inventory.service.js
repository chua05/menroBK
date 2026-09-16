const {
  db,
} = require("../config/firebase");

const {
  Timestamp,
} = require(
  "firebase-admin/firestore"
);

const COLLECTION =
  "seedlingInventory";

const inventoryCollection =
  db.collection(COLLECTION);

// ========================================
// AUTOMATIC STATUS
// ========================================

const calculateInventoryStatus = (
  availableQuantity,
  lowStockThreshold = 20
) => {
  const available =
    Number(availableQuantity || 0);

  const threshold =
    Number.isInteger(
      Number(lowStockThreshold)
    )
      ? Number(lowStockThreshold)
      : 20;

  if (available <= 0) {
    return "Out of Stock";
  }

  if (available <= threshold) {
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

  const lowStockThreshold =
    Number.isInteger(
      Number(
        data.lowStockThreshold
      )
    )
      ? Number(
          data.lowStockThreshold
        )
      : 20;

  const inventoryData = {
    species:
      String(
        data.species || ""
      ).trim(),

    scientificName:
      String(
        data.scientificName || ""
      ).trim(),

    category:
      String(
        data.category || ""
      ).trim(),

    quantity,

    availableQuantity:
      quantity,

    // Approved requests that are
    // waiting for physical release.
    reservedQuantity: 0,

    // Seedlings already physically released.
    distributedQuantity: 0,

    lowStockThreshold,

    dateReceived:
      String(
        data.dateReceived || ""
      ).trim(),

    sourceNursery:
      String(
        data.sourceNursery || ""
      ).trim(),

    batchReference:
      String(
        data.batchReference || ""
      ).trim(),

    description:
      String(
        data.description || ""
      ).trim(),

    status:
      calculateInventoryStatus(
        quantity,
        lowStockThreshold
      ),

    isDeleted: false,

    createdBy:
      data.createdBy,

    updatedBy:
      data.updatedBy ||
      data.createdBy,

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
// ADMIN / STAFF
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
          String(
            item.status || ""
          ).toLowerCase() ===
          String(
            status
          ).toLowerCase()
      );
  }

  if (species) {
    inventory =
      inventory.filter(
        (item) =>
          String(
            item.species || ""
          )
            .toLowerCase()
            .includes(
              String(
                species
              ).toLowerCase()
            )
      );
  }

  inventory.sort((a, b) =>
    String(a.species || "")
      .localeCompare(
        String(b.species || "")
      )
  );

  return inventory;
};

// ========================================
// PARTICIPANT — GET AVAILABLE ITEMS
//
// Only fields needed for the request
// dropdown are returned.
// ========================================

const getAvailableInventoryItems =
  async () => {
    const snapshot =
      await inventoryCollection.get();

    return snapshot.docs
      .map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }))
      .filter(
        (item) =>
          item.isDeleted !== true &&
          Number(
            item.availableQuantity ||
              0
          ) > 0
      )
      .map((item) => ({
        id: item.id,

        species:
          item.species || "",

        scientificName:
          item.scientificName ||
          "",

        category:
          item.category || "",

        availableQuantity:
          Number(
            item.availableQuantity ||
              0
          ),

        status:
          item.status || "",
      }))
      .sort((a, b) =>
        String(a.species)
          .localeCompare(
            String(b.species)
          )
      );
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

        // ========================================
        // BASIC INFORMATION
        // ========================================

        if (
          updateData.species !==
          undefined
        ) {
          updates.species =
            updateData.species;
        }

        if (
          updateData.scientificName !==
          undefined
        ) {
          updates.scientificName =
            updateData.scientificName;
        }

        if (
          updateData.category !==
          undefined
        ) {
          updates.category =
            updateData.category;
        }

        if (
          updateData.dateReceived !==
          undefined
        ) {
          updates.dateReceived =
            updateData.dateReceived;
        }

        if (
          updateData.sourceNursery !==
          undefined
        ) {
          updates.sourceNursery =
            updateData.sourceNursery;
        }

        if (
          updateData.batchReference !==
          undefined
        ) {
          updates.batchReference =
            updateData.batchReference;
        }

        if (
          updateData.description !==
          undefined
        ) {
          updates.description =
            updateData.description;
        }

        // ========================================
        // LOW STOCK THRESHOLD
        // ========================================

        const effectiveThreshold =
          updateData.lowStockThreshold !==
          undefined
            ? Number(
                updateData.lowStockThreshold
              )
            : Number(
                currentData
                  .lowStockThreshold ??
                  20
              );

        if (
          updateData.lowStockThreshold !==
          undefined
        ) {
          updates.lowStockThreshold =
            effectiveThreshold;
        }

        // ========================================
        // QUANTITY EDIT
        // ========================================

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
                .reservedQuantity ||
                0
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

          // Total quantity cannot be
          // lower than seedlings already
          // reserved or distributed.
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
              newAvailableQuantity,
              effectiveThreshold
            );
        } else if (
          updateData.lowStockThreshold !==
          undefined
        ) {
          // If only the threshold changed,
          // recalculate status using the
          // current available stock.
          updates.status =
            calculateInventoryStatus(
              Number(
                currentData
                  .availableQuantity ||
                  0
              ),
              effectiveThreshold
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

        const lowStockThreshold =
          Number(
            currentData
              .lowStockThreshold ??
              20
          );

        const newQuantity =
          currentQuantity +
          quantityToAdd;

        const newAvailableQuantity =
          currentAvailable +
          quantityToAdd;

        const newStatus =
          calculateInventoryStatus(
            newAvailableQuantity,
            lowStockThreshold
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
// SOFT DELETE / ARCHIVE INVENTORY
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

    if (reservedQuantity > 0) {
      throw new Error(
        "This seedling record cannot be archived because it has approved seedlings waiting for release."
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
  getAvailableInventoryItems,
  getInventoryById,
  updateInventoryById,
  addInventoryStock,
  deleteInventoryById,
  calculateInventoryStatus,
};