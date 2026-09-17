const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { parentForEventInTransaction } = require("./parentPlantingReport.service");

const events = db.collection("events");
const participants = db.collection("eventParticipants");
const contributions = db.collection("plantingContributions");

async function recordContribution(eventId, participantId, inventoryId, quantity) {
  if (typeof eventId !== "string" || !eventId || eventId.includes("/") ||
      typeof inventoryId !== "string" || !inventoryId || inventoryId.includes("/") ||
      !Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
    throw new Error("Valid event, seedling item, and positive whole-number quantity are required.");
  }
  const eventRef = events.doc(eventId);
  const participantRef = participants.doc(participantId);
  const contributionRef = contributions.doc();
  await db.runTransaction(async (transaction) => {
    const eventDoc = await transaction.get(eventRef);
    const participantDoc = await transaction.get(participantRef);
    if (!eventDoc.exists || !participantDoc.exists || participantDoc.data().eventId !== eventId) {
      throw new Error("Event participation not found.");
    }
    const event = eventDoc.data();
    if (!event.allocationReleasedAt || event.status === "Cancelled") {
      throw new Error("Seedlings have not been released for this event.");
    }
    const allocation = (event.seedlingItems || []).find((item) => item.inventoryId === inventoryId);
    if (!allocation) throw new Error("Seedling item is not allocated to this event.");
    const now = Timestamp.now();
    const parent = event.sourceRequestId
      ? await parentForEventInTransaction(transaction, eventId, event, now, Number(quantity))
      : null;
    if (parent && !["Draft", "Pending", "Pending Review"].includes(parent.data.verificationStatus)) {
      throw new Error("This planting report has already been finalized.");
    }
    const recorded = { ...(event.recordedSeedlingsByInventory || {}) };
    const existing = Number(recorded[inventoryId] || 0);
    const remaining = Number(allocation.quantity) - existing;
    if (Number(quantity) > remaining) {
      throw new Error(`Only ${Math.max(0, remaining)} seedlings remain available for recording.`);
    }
    recorded[inventoryId] = existing + Number(quantity);
    transaction.update(eventRef, {
      recordedSeedlingsByInventory: recorded,
      recordedSeedlingQuantity: Number(event.recordedSeedlingQuantity || 0) + Number(quantity),
      remainingSeedlingQuantity: Number(event.seedlingTotalQuantity || 0) -
        Number(event.recordedSeedlingQuantity || 0) - Number(quantity),
      updatedAt: now,
    });
    if (parent && !parent.created) {
      transaction.update(parent.ref, {
        quantityPlanted: Number(parent.data.quantityPlanted || 0) + Number(quantity),
        updatedAt: now,
      });
    }
    transaction.create(contributionRef, {
      ...(parent ? { reportId: parent.ref.id, requestId: event.sourceRequestId } : {}),
      eventId,
      participantId,
      contributorId: participantDoc.data().userId || participantId,
      participantType: parent && participantDoc.data().userId === parent.data.participantId
        ? "requester" : participantDoc.data().participantType,
      contributorName: participantDoc.data().fullName || "",
      inventoryId,
      species: allocation.species,
      quantity: Number(quantity),
      recordedAt: now,
    });
  });
  const doc = await contributionRef.get();
  return { id: doc.id, ...doc.data() };
}

async function getOwnContributions(eventId, participantId) {
  const snapshot = await contributions.where("participantId", "==", participantId).get();
  return snapshot.docs
    .filter((doc) => doc.data().eventId === eventId)
    .map((doc) => ({ id: doc.id, ...doc.data() }));
}

module.exports = { recordContribution, getOwnContributions };
