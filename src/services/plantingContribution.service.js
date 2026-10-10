const { db } = require("../config/firebase");
const crypto = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { parentForEventInTransaction } = require("./parentPlantingReport.service");

const events = db.collection("events");
const participants = db.collection("eventParticipants");
const contributions = db.collection("plantingContributions");

async function recordContribution(eventId, participantId, inventoryId, quantity, submissionKey = "") {
  if (typeof eventId !== "string" || !eventId || eventId.includes("/") ||
      typeof inventoryId !== "string" || !inventoryId || inventoryId.includes("/") ||
      !Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
    throw new Error("Valid event, seedling item, and positive whole-number quantity are required.");
  }
  if (submissionKey && !/^[A-Za-z0-9_-]{8,100}$/.test(submissionKey)) {
    throw new Error("Invalid planting submission key.");
  }
  const eventRef = events.doc(eventId);
  const participantRef = participants.doc(participantId);
  const contributionRef = submissionKey
    ? contributions.doc(crypto.createHash("sha256")
      .update(`${eventId}:${participantId}:${submissionKey}`).digest("hex"))
    : contributions.doc();
  await db.runTransaction(async (transaction) => {
    const eventDoc = await transaction.get(eventRef);
    const participantDoc = await transaction.get(participantRef);
    const existingContribution = submissionKey
      ? await transaction.get(contributionRef) : null;
    if (existingContribution?.exists) return;
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
      ? await parentForEventInTransaction(transaction, eventId, event, now, 0)
      : null;
    if (parent && ![
      "Draft", "Pending", "Pending Review", "Awaiting Submission", "Partial",
    ].includes(parent.data.reportingProgress || parent.data.verificationStatus)) {
      throw new Error("This planting report has already been finalized.");
    }
    const recorded = { ...(event.recordedSeedlingsByInventory || {}) };
    const pendingReservations = { ...(event.pendingSeedlingsByInventory || {}) };
    const existing = Number(recorded[inventoryId] || 0);
    const reserved = Number(pendingReservations[inventoryId] || 0);
    const remaining = Number(allocation.quantity) - existing - reserved;
    if (Number(quantity) > Math.max(0, remaining)) {
      throw new Error(
        `Quantity exceeds the remaining reportable quantity. Only ${Math.max(0, remaining)} seedlings remain available for reporting.`
      );
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
      evidencePending: true,
      allocationReserved: true,
      staffApprovalRequired: true,
      requiresStaffReview: true,
      submissionWorkflowVersion: 2,
      recordedAt: now,
    });
    pendingReservations[inventoryId] = reserved + Number(quantity);
    transaction.update(eventRef, {
      pendingSeedlingsByInventory: pendingReservations,
      pendingSeedlingQuantity: Number(event.pendingSeedlingQuantity || 0) + Number(quantity),
      updatedAt: now,
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
