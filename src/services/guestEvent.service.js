const crypto = require("node:crypto");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const invitations = db.collection("eventInvitations");
const participants = db.collection("eventParticipants");
const events = db.collection("events");
const sites = db.collection("sites");
const requests = db.collection("seedlingRequests");
const DEFAULT_INVITATION_TTL_HOURS = 30 * 24;
const DEFAULT_SESSION_TTL_HOURS = 24;

function configuredHours(name, fallback, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 && value <= maximum ? value : fallback;
}

function toMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function expiryFor(createdAt, hours) {
  const base = toMillis(createdAt);
  return Timestamp.fromMillis((Number.isFinite(base) ? base : Date.now()) + hours * 60 * 60 * 1000);
}

function expired(data, fallbackHours) {
  const expiresAt = toMillis(data?.expiresAt);
  if (Number.isFinite(expiresAt)) return expiresAt <= Date.now();
  const createdAt = toMillis(data?.createdAt || data?.joinedAt);
  return !Number.isFinite(createdAt) || createdAt + fallbackHours * 60 * 60 * 1000 <= Date.now();
}

function eventIsEligible(event) {
  const status = String(event?.status || "").trim().toLowerCase();
  const recordStatus = String(event?.recordStatus || "").trim().toLowerCase();
  return event && event.archived !== true &&
    !["cancelled", "completed"].includes(status) &&
    !["cancelled", "completed", "archived"].includes(recordStatus);
}

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
  const expiresAt = expiryFor(createdAt, configuredHours(
    "GUEST_INVITATION_TTL_HOURS", DEFAULT_INVITATION_TTL_HOURS, 90 * 24
  ));
  transaction.create(invitations.doc(eventId), {
    eventId, requestId, nonce, tokenHash, active: true, createdAt, expiresAt, revokedAt: null,
  });
  return true;
}

async function getInvitationForRequester(eventId, userId) {
  const invitationDoc = await invitations.doc(eventId).get();
  const invitation = invitationDoc.data();
  if (!invitationDoc.exists || !invitation?.active || invitation.revokedAt ||
      expired(invitation, DEFAULT_INVITATION_TTL_HOURS)) {
    throw new Error("Invitation not found.");
  }
  const requestDoc = await db.collection("seedlingRequests")
    .doc(invitationDoc.data().requestId).get();
  if (!requestDoc.exists || requestDoc.data().participantId !== userId) {
    throw new Error("Invitation not found.");
  }
  return { eventId, token: invitationToken(eventId, invitation.nonce), expiresAt: invitation.expiresAt || null };
}

async function validateInvitation(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) {
    throw new Error("Invalid guest invitation.");
  }
  const eventId = token.split(".")[0];
  const invitationDoc = await invitations.doc(eventId).get();
  const invitation = invitationDoc.data();
  if (!invitationDoc.exists || !invitation?.active || invitation.revokedAt) {
    throw new Error("Invalid guest invitation.");
  }
  if (expired(invitation, DEFAULT_INVITATION_TTL_HOURS)) {
    throw new Error("This invitation link has expired.");
  }
  const expected = Buffer.from(invitation.tokenHash, "hex");
  const actual = Buffer.from(digest(token), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("Invalid guest invitation.");
  }
  const eventDoc = await events.doc(eventId).get();
  if (!eventDoc.exists || !eventIsEligible(eventDoc.data())) {
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
        species: item.species || item.commonName || "Tree / Seedling",
        allocated,
        recorded: Math.min(allocated, recordedQuantity),
        remaining: Math.max(0, allocated - recordedQuantity - Number(event.pendingSeedlingsByInventory?.[item.inventoryId] || 0) - Number(event.leftoverSeedlingsByInventory?.[item.inventoryId] || 0)),
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
  const joinedAt = Timestamp.now();
  const expiresAt = expiryFor(joinedAt, configuredHours(
    "GUEST_SESSION_TTL_HOURS", DEFAULT_SESSION_TTL_HOURS, 7 * 24
  ));
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
      joinedAt,
      createdAt: joinedAt,
      expiresAt,
      lastUsedAt: joinedAt,
      revokedAt: null,
    });
  });
  return { eventId, participantId, sessionToken, expiresAt };
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
  if (doc.data().revokedAt) throw new Error("Invalid guest session.");
  if (expired(doc.data(), DEFAULT_SESSION_TTL_HOURS)) {
    throw new Error("Guest session expired.");
  }
  const expected = Buffer.from(doc.data().sessionHash, "hex");
  const actual = Buffer.from(digest(token), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("Invalid guest session.");
  }
  const eventDoc = await events.doc(doc.data().eventId).get();
  if (!eventDoc.exists || !eventIsEligible(eventDoc.data())) {
    throw new Error("Invalid guest session.");
  }
  const participantRef = participants.doc(participantId);
  if (typeof participantRef.update === "function") {
    await participantRef.update({ lastUsedAt: Timestamp.now() });
  }
  return { participantId, eventId: doc.data().eventId, fullName: doc.data().fullName };
}

async function getGuestSessionContext(header) {
  const session = await validateGuestSession(header);
  const eventDoc = await events.doc(session.eventId).get();
  if (!eventDoc.exists || !eventIsEligible(eventDoc.data())) {
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
    if ((!Array.isArray(entry.photos) || entry.photos.length === 0) && !entry.finalReportGroupId || entry.staffReviewStatus === "Rejected") continue;
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


// --------------------------------------------------------------------------
// GUEST ATTENDANCE (attendance-only registration through the event link)
// --------------------------------------------------------------------------
// Attendance is documentation of who attended. It never creates planting
// contributions, never reserves seedlings and is never read by balances,
// planting verification, analytics or monitoring. Records live in their own
// collection, one per event + contact number.
const attendance = db.collection("eventAttendance");
const MAX_ADDRESS_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const attendanceFail = (status, message, fieldErrors) =>
  Object.assign(new Error(message), { status, ...(fieldErrors ? { fieldErrors } : {}) });

// Scheduled start of the event in Bulan (Asia/Manila, UTC+8).
function eventStartsAt(event = {}) {
  const date = String(event.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = /^\d{2}:\d{2}$/.test(String(event.startTime || event.time || "")) ? String(event.startTime || event.time) : "00:00";
  const start = new Date(`${date}T${time}:00+08:00`);
  return Number.isFinite(start.getTime()) ? start : null;
}

// Attendance is accepted during or after the event, until the link expires or
// is revoked. Completed events stay open; cancelled or archived ones do not.
function attendanceState(event = {}, now = new Date()) {
  const status = String(event.status || "").trim().toLowerCase();
  const recordStatus = String(event.recordStatus || "").trim().toLowerCase();
  if (!event || event.archived === true || event.isArchived === true || event.isDeleted === true ||
      status === "cancelled" || ["cancelled", "archived"].includes(recordStatus)) {
    return { open: false, reason: "cancelled" };
  }
  const startsAt = eventStartsAt(event);
  if (!startsAt) return { open: false, reason: "unscheduled" };
  if (now < startsAt) return { open: false, reason: "not-started", opensAt: startsAt.toISOString() };
  return { open: true, opensAt: startsAt.toISOString() };
}

// Same signed, unexpired, unrevoked link as before; only the event rule differs.
async function validateAttendanceInvitation(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) {
    throw attendanceFail(404, "Guest event not found.");
  }
  const eventId = token.split(".")[0];
  const invitationDoc = await invitations.doc(eventId).get();
  const invitation = invitationDoc.data();
  if (!invitationDoc.exists || !invitation?.active || invitation.revokedAt) throw attendanceFail(404, "Guest event not found.");
  if (expired(invitation, DEFAULT_INVITATION_TTL_HOURS)) throw attendanceFail(410, "This invitation link has expired.");
  const expected = Buffer.from(invitation.tokenHash, "hex");
  const actual = Buffer.from(digest(token), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw attendanceFail(404, "Guest event not found.");
  const eventDoc = await events.doc(eventId).get();
  if (!eventDoc.exists) throw attendanceFail(404, "Guest event not found.");
  const state = attendanceState(eventDoc.data());
  if (state.reason === "cancelled") throw attendanceFail(410, "This event is no longer accepting attendance.");
  return { eventId, event: eventDoc.data(), invitation, state };
}

// Public event card for the attendance page: no allocation or balances.
async function attendanceEventView(eventId, event, state = attendanceState(event)) {
  const [siteDoc, requestDoc] = await Promise.all([
    event.plantingSiteId ? sites.doc(event.plantingSiteId).get() : Promise.resolve({ exists: false }),
    event.sourceRequestId ? requests.doc(event.sourceRequestId).get() : Promise.resolve({ exists: false }),
  ]);
  const site = siteDoc.exists ? siteDoc.data() : {};
  const request = requestDoc.exists ? requestDoc.data() : {};
  return {
    id: eventId, name: event.name || "Tree Planting Event", date: event.date || "", startTime: event.startTime || "",
    endTime: event.endTime || "", status: event.status || "",
    barangay: event.barangay || request.eventProposal?.barangay || site.barangay || "",
    plantingSiteNumber: site.siteId || event.plantingSiteNumber || "",
    plantingSiteName: event.plantingSiteName || site.siteName || "",
    attendanceOpen: state.open, attendanceOpensAt: state.opensAt || null,
  };
}

function cleanText(value, { label, min, max, field }) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (typeof value === "string" && CONTROL_CHARACTERS.test(value.replace(/[\r\n\t]/g, " "))) {
    throw attendanceFail(400, `${label} contains unsupported characters.`, { [field]: "Remove unsupported characters." });
  }
  if (text.length < min || text.length > max) {
    throw attendanceFail(400, `${label} is required (${min}–${max} characters).`, { [field]: `Enter ${min}–${max} characters.` });
  }
  return text;
}

async function registerAttendance(token, details = {}) {
  const allowed = new Set(["fullName", "contactNumber", "address"]);
  if (!details || typeof details !== "object" || Object.keys(details).some((key) => !allowed.has(key))) {
    throw attendanceFail(400, "Only Full Name, Contact Number and Address are accepted.");
  }
  const { eventId, event, invitation, state } = await validateAttendanceInvitation(token);
  if (!state.open) {
    throw attendanceFail(409, state.reason === "not-started"
      ? "Attendance opens when the planting event starts." : "This event is not accepting attendance.");
  }
  const fullName = cleanText(details.fullName, { label: "Full name", min: 2, max: 120, field: "fullName" });
  let contactNumber;
  try { contactNumber = normalizeContact(details.contactNumber); } catch {
    throw attendanceFail(400, "A valid Philippine mobile number is required.", { contactNumber: "Enter a valid mobile number, e.g. 09123456789." });
  }
  const address = cleanText(details.address, { label: "Address", min: 5, max: MAX_ADDRESS_LENGTH, field: "address" });
  // One record per event and contact number; the ID never contains the number itself.
  const ref = attendance.doc(digest(`attendance:${eventId}:${contactNumber}`));
  const registeredAt = Timestamp.now();
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) throw attendanceFail(409, "This contact number is already registered for this event.", { contactNumber: "Already registered for this event." });
    transaction.create(ref, {
      eventId, requestId: invitation.requestId || event.sourceRequestId || "",
      fullName, contactNumber, address, source: "guest-invitation", registeredAt, createdAt: registeredAt,
    });
  });
  return { eventId, fullName, registeredAt };
}

// Only the event's requester, MENRO Staff and Admin may read attendance.
async function listEventAttendance(eventId, user = {}) {
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) throw attendanceFail(404, "Event not found.");
  const role = String(user.role || "").toLowerCase();
  if (!user.uid || !["staff", "admin", "participant"].includes(role)) throw attendanceFail(403, "Attendance access is not authorized.");
  const eventDoc = await events.doc(eventId).get();
  if (!eventDoc.exists) throw attendanceFail(404, "Event not found.");
  if (role === "participant") {
    const requestId = eventDoc.data().sourceRequestId;
    const requestDoc = requestId ? await requests.doc(requestId).get() : null;
    if (!requestDoc?.exists || requestDoc.data().participantId !== user.uid) throw attendanceFail(403, "Attendance access is not authorized.");
  }
  const snapshot = await attendance.where("eventId", "==", eventId).get();
  return snapshot.docs.map((doc) => {
    const row = doc.data();
    return { id: doc.id, eventId, fullName: row.fullName || "", contactNumber: row.contactNumber || "", address: row.address || "", registeredAt: row.registeredAt || null };
  }).sort((a, b) => String(a.registeredAt?.toMillis?.() ?? a.registeredAt ?? "").localeCompare(String(b.registeredAt?.toMillis?.() ?? b.registeredAt ?? "")) || a.fullName.localeCompare(b.fullName));
}

module.exports = {
  attendanceState,
  validateAttendanceInvitation,
  attendanceEventView,
  registerAttendance,
  listEventAttendance,
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
