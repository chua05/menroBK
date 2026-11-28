const {
  db,
} = require("../config/firebase");

const {
  Timestamp,
} = require(
  "firebase-admin/firestore"
);
const { nextRecordNumber } = require("../utils/recordNumber.util");
const { calculateStockStatus, stockStatusForRecord, resolveReceivedBaseline } = require("../utils/stockStatus.util");
const {
  createLowStockNotificationsInTransaction,
  createOutOfStockNotificationsInTransaction,
  createReplenishmentNotificationsInTransaction,
} = require("./notification.service");

const COLLECTION =
  "seedlingInventory";

const inventoryCollection =
  db.collection(COLLECTION);

// ========================================
// AUTOMATIC STATUS
// ========================================

const calculateInventoryStatus = (currentQuantity, totalReceived) =>
  calculateStockStatus(currentQuantity, totalReceived);

// Read-time decoration: computed status and baseline, never persisted from here.
const withComputedStock = (item) => {
  const computed = stockStatusForRecord(item);
  return {
    ...item,
    status: computed.status,
    stockStatus: computed.status,
    totalReceivedQuantity: computed.totalReceivedQuantity,
    remainingStockPercent: computed.remainingPercent,
    stockBaselineIssue: computed.baselineIssue,
  };
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

    // Total ever received for this batch; increased on every restock.
    totalReceivedQuantity: initialQuantity,

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

    // Client-sent status is ignored; status is always calculated.
    stockStatus: calculateInventoryStatus(initialQuantity, initialQuantity),
    status: calculateInventoryStatus(initialQuantity, initialQuantity),

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
      )
      .map(withComputedStock);

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

        ...(() => {
          const { status } = stockStatusForRecord(item);
          return { status, stockStatus: status };
        })(),
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

    return withComputedStock({
      id: doc.id,
      ...doc.data(),
    });
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

        // Any client-sent stockStatus is ignored; status is recalculated
        // from stored quantities on every write.
        {
          const recalculated = stockStatusForRecord(currentData).status;
          updates.stockStatus = recalculated;
          updates.status = recalculated;
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

        const currentAvailableQuantity = Number(
          currentData.currentQuantity ?? currentData.availableQuantity ?? 0
        );
        const previousThreshold = Number(currentData.lowStockThreshold ?? 20);

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

          updates.currentQuantity =
            newAvailableQuantity;

          {
            const quantityStatus = stockStatusForRecord({
              ...currentData,
              currentQuantity: newAvailableQuantity,
            }).status;
            updates.status = quantityStatus;
            updates.stockStatus = quantityStatus;
          }
          updates.lowStockAlertActive = newAvailableQuantity <= effectiveThreshold;

          if (currentAvailableQuantity > previousThreshold &&
              newAvailableQuantity <= effectiveThreshold) {
            const lowStockCycle = Number(currentData.lowStockCycle || 0) + 1;
            updates.lowStockCycle = lowStockCycle;
            await createLowStockNotificationsInTransaction(transaction, {
              inventoryId: id,
              species: updates.species || currentData.species || "Seedling",
              availableQuantity: newAvailableQuantity,
              lowStockThreshold: effectiveThreshold,
              cycle: lowStockCycle,
              createdAt: Timestamp.now(),
            });
          }
          if (currentAvailableQuantity > 0 && newAvailableQuantity === 0) {
            const outOfStockCycle = Number(currentData.outOfStockCycle || 0) + 1;
            updates.outOfStockCycle = outOfStockCycle;
            await createOutOfStockNotificationsInTransaction(transaction, {
              inventoryId: id,
              inventoryReference: currentData.inventoryNumber || currentData.batchReference || id,
              species: updates.species || currentData.species || "Seedling",
              cycle: outOfStockCycle,
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
          const thresholdStatus = stockStatusForRecord(currentData).status;
          updates.status = thresholdStatus;
          updates.stockStatus = thresholdStatus;
          const newlyLow = currentAvailableQuantity > previousThreshold &&
            currentAvailableQuantity <= effectiveThreshold;
          updates.lowStockAlertActive = currentAvailableQuantity <= effectiveThreshold;
          if (newlyLow) {
            const lowStockCycle = Number(currentData.lowStockCycle || 0) + 1;
            updates.lowStockCycle = lowStockCycle;
            await createLowStockNotificationsInTransaction(transaction, {
              inventoryId: id,
              species: currentData.species || "Seedling",
              availableQuantity: currentAvailableQuantity,
              lowStockThreshold: effectiveThreshold,
              cycle: lowStockCycle,
              createdAt: Timestamp.now(),
            });
          }
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

    return withComputedStock({
      id: updatedDoc.id,
      ...updatedDoc.data(),
    });
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

        // A batch created empty and never restocked has a known baseline of 0.
        const neverReceivedAny =
          typeof currentData.initialQuantity === "number" &&
          Number.isInteger(currentData.initialQuantity) &&
          currentData.initialQuantity === 0 &&
          !(Number(currentData.replenishmentCycle) > 0) &&
          (currentData.totalReceivedQuantity === undefined || currentData.totalReceivedQuantity === 0) &&
          currentAvailable === 0 &&
          Number(currentData.distributedQuantity || 0) === 0 &&
          Number(currentData.reservedQuantity || 0) === 0;
        const baseline = neverReceivedAny ? 0 : resolveReceivedBaseline(currentData);
        const newTotalReceived = baseline === null ? null : baseline + quantityToAdd;
        const newStatus =
          calculateInventoryStatus(newAvailableQuantity, newTotalReceived);

        const replenishmentCycle = Number(currentData.replenishmentCycle || 0) + 1;
        const now = Timestamp.now();
        await createReplenishmentNotificationsInTransaction(transaction, {
          inventoryId: id,
          inventoryReference: currentData.inventoryNumber || currentData.batchReference || id,
          species: currentData.species || "Seedling",
          quantityAdded: quantityToAdd,
          availableQuantity: newAvailableQuantity,
          cycle: replenishmentCycle,
          createdAt: now,
        });

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

            ...(newTotalReceived === null ? {} : { totalReceivedQuantity: newTotalReceived }),

            replenishmentCycle,

            lowStockAlertActive: newAvailableQuantity <= Number(currentData.lowStockThreshold ?? 20),

            updatedBy,

            updatedAt:
              now,
          }
        );
      }
    );

    const updatedDoc =
      await docRef.get();

    return withComputedStock({
      id: updatedDoc.id,
      ...updatedDoc.data(),
    });
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
  return snapshot.docs.map((doc) => withComputedStock({ id: doc.id, ...doc.data() }))
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
