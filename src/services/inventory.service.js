const {
  db,
} = require("../config/firebase");

const {
  Timestamp,
} = require(
  "firebase-admin/firestore"
);
const { nextRecordNumber } = require("../utils/recordNumber.util");
const { createLowStockNotificationsInTransaction } = require("./notification.service");

const COLLECTION =
  "seedlingInventory";

const inventoryCollection =
  db.collection(COLLECTION);

// ========================================
// AUTOMATIC STATUS
// ========================================

const calculateInventoryStatus = (currentQuantity, preferredStatus = "Available") => {
  if (Number(currentQuantity || 0) <= 0) return "Out of Stock";
  return preferredStatus === "Limited" ? "Limited" : "Available";
};

// ========================================
// CREATE INVENTORY
// ========================================

const createInventory = async (
  data
) => {
  const now =
    Timestamp.now();

  const initialQuantity = Number(data.initialQuantity);

  const inventoryData = {
    species:
      String(
        data.species || ""
      ).trim(),

    scientificName: data.scientificName == null ? null : String(data.scientificName).trim(),

    category:
      String(
        data.category || ""
      ).trim(),

    categorySpecification: String(data.categorySpecification || "").trim(),

    initialQuantity,

    currentQuantity: initialQuantity,

    // Compatibility aliases for existing request, analytics, and release code.
    quantity: initialQuantity,

    availableQuantity:
      initialQuantity,

    // Approved requests that are
    // waiting for physical release.
    reservedQuantity: 0,

    // Seedlings already physically released.
    distributedQuantity: 0,

    dateReceived:
      String(
        data.dateReceived || ""
      ).trim(),

    sourceType: String(data.sourceType || "").trim(),
    sourceSpecification: String(data.sourceSpecification || "").trim(),
    storageLocation: String(data.storageLocation || "").trim(),
    storageLocationSpecification: String(data.storageLocationSpecification || "").trim(),

    description:
      String(
        data.description || ""
      ).trim(),

    stockStatus: calculateInventoryStatus(initialQuantity, data.stockStatus),
    status: calculateInventoryStatus(initialQuantity, data.stockStatus),

    isDeleted: false,

    createdBy:
      data.createdBy,

    updatedBy:
      data.updatedBy ||
      data.createdBy,

    createdAt: now,
    updatedAt: now,
  };

  const docRef = inventoryCollection.doc();
  let inventoryNumber = "";
  let batchReference = "";
  await db.runTransaction(async (transaction) => {
    batchReference = await nextRecordNumber(transaction, {
      prefix: "BAT",
      counterKey: "inventoryBatch",
      date: now.toDate(),
      timestamp: now,
    });
    inventoryNumber = batchReference.replace(/^BAT-/, "INV-");
    transaction.create(docRef, { ...inventoryData, inventoryNumber, batchReference });
  });

  return {
    id: docRef.id,
    inventoryNumber,
    batchReference,
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
            item.currentQuantity ?? item.availableQuantity ?? 0
          ) > 0
      )
      .map((item) => ({
        id: item.id,
        inventoryNumber: item.inventoryNumber || "",

        species:
          item.species || "",

        scientificName:
          item.scientificName ||
          "",

        category:
          item.category || "",

        availableQuantity:
          Number(
            item.currentQuantity ??
              item.availableQuantity ??
              0
          ),

        currentQuantity:
          Number(item.currentQuantity ?? item.availableQuantity ?? 0),

        batchReference: item.batchReference || "",

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

        if (updateData.stockStatus !== undefined) {
          const currentQuantity = Number(
            currentData.currentQuantity ?? currentData.availableQuantity ?? 0
          );
          const status = calculateInventoryStatus(currentQuantity, updateData.stockStatus);
          updates.stockStatus = status;
          updates.status = status;
        }

        for (const field of [
          "sourceType", "sourceSpecification", "storageLocation",
          "storageLocationSpecification", "description",
        ]) {
          if (updateData[field] !== undefined) updates[field] = updateData[field];
        }

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
          updates.lowStockAlertActive = newAvailableQuantity <= effectiveThreshold;

          const currentAvailableQuantity = Number(currentData.availableQuantity || 0);
          if (currentAvailableQuantity > effectiveThreshold &&
              newAvailableQuantity <= effectiveThreshold) {
            const lowStockCycle = Number(currentData.lowStockCycle || 0) + 1;
            updates.lowStockCycle = lowStockCycle;
            await createLowStockNotificationsInTransaction(transaction, {
              inventoryId: id,
              species: updates.species || currentData.species || "Sapling",
              availableQuantity: newAvailableQuantity,
              lowStockThreshold: effectiveThreshold,
              cycle: lowStockCycle,
              createdAt: Timestamp.now(),
            });
          }
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

        const currentAvailable =
          Number(
            currentData.currentQuantity ??
              currentData.availableQuantity ?? 0
          );

        const newAvailableQuantity =
          currentAvailable +
          quantityToAdd;

        const newStatus =
          calculateInventoryStatus(
            newAvailableQuantity,
            currentData.stockStatus || currentData.status
          );

        transaction.update(
          docRef,
          {
            availableQuantity:
              newAvailableQuantity,

            currentQuantity:
              newAvailableQuantity,

            status:
              newStatus,

            stockStatus:
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

    await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);

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

    const now = Timestamp.now();
    transaction.update(docRef, {
      isDeleted: true,

      deletedBy,

      deletedAt:
        now,

      updatedBy:
        deletedBy,

      updatedAt:
        now,
    });
    });

    return {
      id,
    };
  };

const restoreInventoryById = async (id, restoredBy) => {
  const ref = inventoryCollection.doc(id);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists || doc.data().isDeleted !== true) {
      throw new Error("Archived inventory not found.");
    }
    const now = Timestamp.now();
    transaction.update(ref, {
      isDeleted: false,
      restoredBy,
      restoredAt: now,
      updatedBy: restoredBy,
      updatedAt: now,
    });
  });
  const doc = await ref.get();
  return { id: doc.id, ...doc.data() };
};

const getArchivedInventory = async () => {
  const snapshot = await inventoryCollection.where("isDeleted", "==", true).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => String(a.species || "").localeCompare(String(b.species || "")));
};

module.exports = {
  createInventory,
  getAllInventory,
  getArchivedInventory,
  getAvailableInventoryItems,
  getInventoryById,
  updateInventoryById,
  addInventoryStock,
  deleteInventoryById,
  restoreInventoryById,
  calculateInventoryStatus,
};
