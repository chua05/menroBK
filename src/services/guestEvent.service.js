const crypto = require("node:crypto");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const invitations = db.collection("eventInvitations");
const participants = db.collection("eventParticipants");
const events = db.collection("events");
const sites = db.collection("sites");
const requests = db.collection("seedlingRequests");

function secret() {
  const value = String(process.env.GUEST_INVITATION_SECRET || "").trim();
  if (!value || value.length < 32) {
    throw new Error("GUEST_INVITATION_SECRET must contain at least 32 characters.");
  }
  return value;
}

function isGuestInvitationConfigured() {
  return String(process.env.GUEST_INVITATION_SECRET || "").trim().length >= 32;
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
  // Guest access is an optional extension of an approved event. A missing
  // signing secret must not roll back the authoritative request approval.
  if (!isGuestInvitationConfigured()) return false;

  const nonce = crypto.randomBytes(32).toString("hex");
  const tokenHash = digest(invitationToken(eventId, nonce));
  transaction.create(invitations.doc(eventId), {
    eventId, requestId, nonce, tokenHash, active: true, createdAt,
  });
  return true;
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

async function publicEvent(eventId, event) {
  const [siteDoc, requestDoc] = await Promise.all([
    event.plantingSiteId ? sites.doc(event.plantingSiteId).get() : Promise.resolve(null),
    event.sourceRequestId ? requests.doc(event.sourceRequestId).get() : Promise.resolve(null),
  ]);
  const site = siteDoc?.exists ? siteDoc.data() : {};
  const request = requestDoc?.exists ? requestDoc.data() : {};
  const recorded = event.recordedSeedlingsByInventory || {};
  const allocation = event.allocationReleasedAt
    ? (event.seedlingItems || []).map((item) => {
      const allocated = Number(item.quantity || 0);
      const recordedQuantity = Math.max(0, Number(recorded[item.inventoryId] || 0));
      return {
        inventoryId: item.inventoryId,
        species: item.species || item.commonName || "Tree / Sapling",
        allocated,
        recorded: Math.min(allocated, recordedQuantity),
        remaining: Math.max(0, allocated - recordedQuantity),
      };
    })
    : [];
  return {
    id: eventId,
    name: event.name,
    type: event.type,
    date: event.date,
    startTime: event.startTime,
    endTime: event.endTime,
    barangay: event.barangay || request.eventProposal?.barangay || site.barangay || "",
    plantingSiteNumber: site.siteId || event.plantingSiteNumber || "",
    plantingSiteName: event.plantingSiteName || site.siteName || "",
    location: event.location,
    latitude: Number.isFinite(Number(site.latitude ?? event.latitude))
      ? Number(site.latitude ?? event.latitude) : null,
    longitude: Number.isFinite(Number(site.longitude ?? event.longitude))
      ? Number(site.longitude ?? event.longitude) : null,
    allocationReleased: Boolean(event.allocationReleasedAt),
    allocation,
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
  const { eventId, event } = await validateInvitation(token);
  const fullName = typeof details?.fullName === "string" ? details.fullName.trim() : "";
  if (!fullName || fullName.length > 120) {
    throw new Error("Full name is required (maximum 120 characters).");
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
      barangay: event.barangay || "",
      plantingSiteId: event.plantingSiteId || "",
      plantingSiteName: event.plantingSiteName || "",
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

async function getGuestSessionContext(header) {
  const session = await validateGuestSession(header);
  const eventDoc = await events.doc(session.eventId).get();
  if (!eventDoc.exists || eventDoc.data().archived === true || eventDoc.data().status === "Cancelled") {
    throw new Error("Invalid guest session.");
  }
  return { ...session, event: await publicEvent(eventDoc.id, eventDoc.data()) };
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

async function getEventParticipants(eventId) {
  const eventDoc = await events.doc(eventId).get();
  if (!eventDoc.exists) throw new Error("Event not found.");
  const [participantSnapshot, contributionSnapshot] = await Promise.all([
    participants.where("eventId", "==", eventId).get(),
    db.collection("plantingContributions").where("eventId", "==", eventId).get(),
  ]);
  const byParticipant = new Map();
  for (const doc of contributionSnapshot.docs) {
    const entry = doc.data();
    const value = byParticipant.get(entry.participantId) || { quantityPlanted: 0, submissionCount: 0 };
    value.quantityPlanted += Number(entry.quantity || 0);
    value.submissionCount += 1;
    byParticipant.set(entry.participantId, value);
  }
  return participantSnapshot.docs.map((doc) => {
    const item = doc.data();
    return {
      id: doc.id,
      eventId,
      participantType: item.participantType,
      userId: item.userId || null,
      fullName: item.fullName || "",
      organizationBarangay: item.organizationBarangay || item.barangay || "",
      joinedAt: item.joinedAt,
      ...(byParticipant.get(doc.id) || { quantityPlanted: 0, submissionCount: 0 }),
    };
  });
}

module.exports = {
  isGuestInvitationConfigured,
  createInvitationInTransaction,
  getInvitationForRequester,
  validateInvitation,
  publicEvent,
  normalizeContact,
  joinGuest,
  validateGuestSession,
  getGuestSessionContext,
  registeredParticipantId,
  joinRegistered,
  getEventParticipants,
};
