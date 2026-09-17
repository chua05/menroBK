const crypto = require("node:crypto");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const invitations = db.collection("eventInvitations");
const participants = db.collection("eventParticipants");
const events = db.collection("events");

function secret() {
  const value = process.env.GUEST_INVITATION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("GUEST_INVITATION_SECRET must contain at least 32 characters.");
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function invitationToken(eventId, nonce) {
  const signature = crypto.createHmac("sha256", secret())
    .update(`${eventId}.${nonce}`).digest("hex");
  return `${eventId}.${nonce}.${signature}`;
}

function createInvitationInTransaction(transaction, eventId, requestId, createdAt) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const tokenHash = digest(invitationToken(eventId, nonce));
  transaction.create(invitations.doc(eventId), {
    eventId, requestId, nonce, tokenHash, active: true, createdAt,
  });
}

async function getInvitationForRequester(eventId, userId) {
  const invitationDoc = await invitations.doc(eventId).get();
  if (!invitationDoc.exists || !invitationDoc.data().active) {
    throw new Error("Invitation not found.");
  }
  const requestDoc = await db.collection("seedlingRequests")
    .doc(invitationDoc.data().requestId).get();
  if (!requestDoc.exists || requestDoc.data().participantId !== userId) {
    throw new Error("Invitation not found.");
  }
  return { eventId, token: invitationToken(eventId, invitationDoc.data().nonce) };
}

async function validateInvitation(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) {
    throw new Error("Invalid guest invitation.");
  }
  const eventId = token.split(".")[0];
  const invitationDoc = await invitations.doc(eventId).get();
  if (!invitationDoc.exists || !invitationDoc.data().active) {
    throw new Error("Invalid guest invitation.");
  }
  const expected = Buffer.from(invitationDoc.data().tokenHash, "hex");
  const actual = Buffer.from(digest(token), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("Invalid guest invitation.");
  }
  const eventDoc = await events.doc(eventId).get();
  if (!eventDoc.exists || eventDoc.data().archived === true || eventDoc.data().status === "Cancelled") {
    throw new Error("Event not found.");
  }
  return { eventId, event: eventDoc.data() };
}

function publicEvent(eventId, event) {
  return {
    id: eventId,
    name: event.name,
    type: event.type,
    date: event.date,
    startTime: event.startTime,
    endTime: event.endTime,
    barangay: event.barangay,
    plantingSiteName: event.plantingSiteName,
    location: event.location,
    status: event.status,
  };
}

function normalizeContact(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  const local = digits.startsWith("63") && digits.length === 12
    ? `0${digits.slice(2)}` : digits;
  if (!/^09\d{9}$/.test(local)) {
    throw new Error("A valid Philippine mobile number is required.");
  }
  return local;
}

async function joinGuest(token, details) {
  const { eventId } = await validateInvitation(token);
  const fullName = typeof details?.fullName === "string" ? details.fullName.trim() : "";
  const organizationBarangay = typeof details?.organizationBarangay === "string"
    ? details.organizationBarangay.trim() : "";
  if (!fullName || !organizationBarangay || fullName.length > 120 || organizationBarangay.length > 120) {
    throw new Error("Full name and organization/barangay are required (maximum 120 characters). ");
  }
  const normalizedContactNumber = normalizeContact(details?.contactNumber);
  const participantId = digest(`${eventId}:${normalizedContactNumber}`);
  const sessionToken = `${participantId}.${crypto.randomBytes(32).toString("hex")}`;
  const ref = participants.doc(participantId);
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) throw new Error("This contact number has already joined the event.");
    transaction.create(ref, {
      eventId,
      participantType: "guest",
      fullName,
      organizationBarangay,
      contactNumber: normalizedContactNumber,
      normalizedContactNumber,
      sessionHash: digest(sessionToken),
      joinedAt: Timestamp.now(),
    });
  });
  return { eventId, participantId, sessionToken };
}

async function validateGuestSession(header) {
  const match = /^Guest ([a-f0-9]{64}\.[a-f0-9]{64})$/.exec(header || "");
  if (!match) throw new Error("Invalid guest session.");
  const token = match[1];
  const participantId = token.slice(0, 64);
  const doc = await participants.doc(participantId).get();
  if (!doc.exists || doc.data().participantType !== "guest") {
    throw new Error("Invalid guest session.");
  }
  const expected = Buffer.from(doc.data().sessionHash, "hex");
  const actual = Buffer.from(digest(token), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("Invalid guest session.");
  }
  return { participantId, eventId: doc.data().eventId, fullName: doc.data().fullName };
}

function registeredParticipantId(eventId, userId) {
  return digest(`${eventId}:user:${userId}`);
}

async function joinRegistered(eventId, user) {
  if (typeof eventId !== "string" || !eventId || eventId.includes("/")) {
    throw new Error("Event not found.");
  }
  const ref = participants.doc(registeredParticipantId(eventId, user.uid));
  await db.runTransaction(async (transaction) => {
    const eventDoc = await transaction.get(events.doc(eventId));
    const existing = await transaction.get(ref);
    if (!eventDoc.exists || eventDoc.data().archived === true || eventDoc.data().status === "Cancelled") {
      throw new Error("Event not found.");
    }
    if (existing.exists) return;
    transaction.create(ref, {
      eventId,
      participantType: "participant",
      userId: user.uid,
      fullName: user.fullName || "",
      joinedAt: Timestamp.now(),
    });
  });
  return { eventId, participantId: ref.id };
}

module.exports = {
  createInvitationInTransaction,
  getInvitationForRequester,
  validateInvitation,
  publicEvent,
  normalizeContact,
  joinGuest,
  validateGuestSession,
  registeredParticipantId,
  joinRegistered,
};
