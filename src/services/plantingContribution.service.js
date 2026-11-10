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
    const remaining = Number(allocation.quantity) - existing - reserved - Number(event.leftoverSeedlingsByInventory?.[inventoryId] || 0);
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
      officialReportingVersion: Number(event.officialReportingVersion || 0) + 1,
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

// --------------------------------------------------------------------------
// LEGACY RESERVATIONS (decision C3)
// --------------------------------------------------------------------------
// Guest/attendee contributions used to reserve seedlings before evidence was
// attached. New ones are retired; an abandoned historical reservation may be
// released by MENRO Staff/Admin with a required reason. The record itself is
// kept (marked Released) and the release is written to the audit log.
const MAX_RELEASE_REASON_LENGTH = 1000;
const reservationFail = (status, message, fieldErrors) => Object.assign(new Error(message), { status, ...(fieldErrors ? { fieldErrors } : {}) });

function isOpenLegacyReservation(row = {}) {
  return row.allocationReserved === true && row.evidencePending === true && !row.reservationReleasedAt &&
    !(Array.isArray(row.photos) && row.photos.length);
}

async function listLegacyReservations(eventId) {
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) throw reservationFail(404, "Event not found.");
  const eventDoc = await events.doc(eventId).get();
  if (!eventDoc.exists) throw reservationFail(404, "Event not found.");
  const snapshot = await contributions.where("eventId", "==", eventId).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((row) => row.allocationReserved === true || row.reservationReleasedAt)
    .map((row) => ({ id: row.id, eventId, inventoryId: row.inventoryId || "", species: row.species || "", quantity: Number(row.quantity || 0),
      contributorName: row.contributorName || "", participantType: row.participantType || "", recordedAt: row.recordedAt || null,
      open: isOpenLegacyReservation(row), reservationStatus: row.reservationReleasedAt ? "Released" : isOpenLegacyReservation(row) ? "Reserved" : "Closed",
      reservationReleasedAt: row.reservationReleasedAt || null, reservationReleasedByName: row.reservationReleasedByName || "",
      reservationReleaseReason: row.reservationReleaseReason || "" }));
}

async function releaseLegacyReservation(eventId, contributionId, actor = {}, reasonInput = "") {
  const role = String(actor.role || "").toLowerCase();
  if (!actor.uid) throw reservationFail(401, "Authentication is required.");
  if (!["staff", "admin"].includes(role)) throw reservationFail(403, "Only MENRO Staff or Admin can release a legacy reservation.");
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId) ||
      typeof contributionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(contributionId)) throw reservationFail(404, "Reservation not found.");
  if (reasonInput !== undefined && reasonInput !== null && typeof reasonInput !== "string") throw reservationFail(400, "The reason must be text.", { reason: "Enter the reason as text." });
  const reason = String(reasonInput || "").trim();
  if (!reason) throw reservationFail(400, "Enter the reason for releasing this reservation.", { reason: "Enter the reason for releasing this reservation." });
  if (reason.length > MAX_RELEASE_REASON_LENGTH) throw reservationFail(400, `The reason must be at most ${MAX_RELEASE_REASON_LENGTH} characters.`, { reason: `Use at most ${MAX_RELEASE_REASON_LENGTH} characters.` });
  const eventRef = events.doc(eventId), contributionRef = contributions.doc(contributionId);
  await db.runTransaction(async (transaction) => {
    const [eventDoc, contributionDoc] = await Promise.all([transaction.get(eventRef), transaction.get(contributionRef)]);
    if (!eventDoc.exists || !contributionDoc.exists || contributionDoc.data().eventId !== eventId) throw reservationFail(404, "Reservation not found.");
    const row = contributionDoc.data(), event = eventDoc.data();
    if (!isOpenLegacyReservation(row)) throw reservationFail(409, "Only an open reservation without evidence can be released.");
    const quantity = Number(row.quantity || 0), inventoryId = row.inventoryId;
    const pending = { ...(event.pendingSeedlingsByInventory || {}) };
    if (!Number.isInteger(quantity) || quantity <= 0 || Number(pending[inventoryId] || 0) < quantity) {
      throw reservationFail(409, "The reservation ledger requires reconciliation before release.");
    }
    pending[inventoryId] = Number(pending[inventoryId] || 0) - quantity;
    const now = Timestamp.now();
    transaction.update(eventRef, {
      pendingSeedlingsByInventory: pending,
      pendingSeedlingQuantity: Math.max(0, Number(event.pendingSeedlingQuantity || 0) - quantity),
      officialReportingVersion: Number(event.officialReportingVersion || 0) + 1,
      updatedAt: now,
    });
    transaction.update(contributionRef, {
      allocationReserved: false, reservationStatus: "Released",
      reservationReleasedAt: now, reservationReleasedBy: actor.uid, reservationReleasedByName: actor.fullName || "",
      reservationReleasedByRole: role, reservationReleaseReason: reason, updatedAt: now,
    });
    require("./verificationLog.service").createVerificationLogInTransaction(transaction, {
      plantingReportId: row.reportId || `event_${eventId}`, submissionId: contributionId,
      action: "Legacy Reservation Released", previousStatus: "Reserved", newStatus: "Released",
      performedBy: actor.uid, performedByRole: role, performedByName: actor.fullName || "",
      remarks: `${quantity} ${row.species || "seedlings"} returned to the reportable balance. Reason: ${reason}`, createdAt: now,
    });
  });
  return (await listLegacyReservations(eventId)).find((row) => row.id === contributionId);
}

module.exports = { recordContribution, getOwnContributions, isOpenLegacyReservation, listLegacyReservations, releaseLegacyReservation };
