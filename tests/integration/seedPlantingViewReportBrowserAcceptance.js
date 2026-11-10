// Emulator-only fixtures for the Staff/Admin "View Report" browser acceptance.
// Seeds a released request/event (parent report created exactly as seedling
// release does), then submits a real geotagged planting report through the
// running backend API as the Participant. `--cleanup` removes everything.
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

const state = validateIntegrationEnvironment();
if (!state.integration) throw new Error("Planting View Report fixtures require the demo emulator environment.");

const { auth, db } = require("../../src/config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { parentForEventInTransaction } = require("../../src/services/parentPlantingReport.service");

const API = process.env.MENRO_SEED_API || "http://127.0.0.1:5000/api";
const PASSWORD = "Planting-View-Browser!2026";
const PREFIX = "planting-view-browser";
const USERS = [
  [`${PREFIX}-participant`, "planting-view.participant@example.test", "participant", "Browser Planter"],
  [`${PREFIX}-staff`, "planting-view.staff@example.test", "staff", "Browser MENRO Staff"],
  [`${PREFIX}-admin`, "planting-view.admin@example.test", "admin", "Browser MENRO Admin"],
];
const SITE_ID = `${PREFIX}-site`;
const REQUEST_ID = `${PREFIX}-request`;
const EVENT_ID = `${PREFIX}-event`;
const REPORT_ID = `event_${EVENT_ID}`;
const INVENTORY_ID = `${PREFIX}-narra`;
const SECOND_INVENTORY_ID = `${PREFIX}-mahogany`;
// A second, still unreported two-type release for the Participant final-report form.
const FORM_REQUEST_ID = `${PREFIX}-form-request`;
const FORM_EVENT_ID = `${PREFIX}-form-event`;
const FORM_REPORT_ID = `event_${FORM_EVENT_ID}`;
const FORM_SITE_ID = `${PREFIX}-form-site`;

async function cleanup() {
  const deletions = [];
  for (const [collection, field] of [["plantingContributions", "reportId"], ["plantingEvidenceHashes", "reportId"],
    ["notifications", "relatedRecordId"], ["verificationLogs", "plantingReportId"]]) {
    for (const reportId of [REPORT_ID, FORM_REPORT_ID]) {
      const snapshot = await db.collection(collection).where(field, "==", reportId).get();
      snapshot.docs.forEach((doc) => deletions.push(doc.ref.delete()));
    }
  }
  for (const [collection, id] of [["plantingReports", REPORT_ID], ["events", EVENT_ID],
    ["distributions", REQUEST_ID], ["seedlingRequests", REQUEST_ID], ["sites", SITE_ID],
    ["plantingReports", FORM_REPORT_ID], ["events", FORM_EVENT_ID], ["sites", FORM_SITE_ID], ["distributions", FORM_REQUEST_ID], ["seedlingRequests", FORM_REQUEST_ID]]) {
    deletions.push(db.collection(collection).doc(id).delete());
  }
  for (const [uid] of USERS) {
    deletions.push(db.collection("users").doc(uid).delete());
    deletions.push(auth.deleteUser(uid).catch((error) => { if (error.code !== "auth/user-not-found") throw error; }));
  }
  await Promise.all(deletions);
}

async function signIn(email) {
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`Sign-in failed: ${JSON.stringify(body)}`);
  return body.idToken;
}

async function seed() {
  await cleanup();
  for (const [uid, email, role, fullName] of USERS) {
    await auth.createUser({ uid, email, password: PASSWORD, emailVerified: true, displayName: fullName });
    await db.collection("users").doc(uid).set({ uid, email, role, fullName, username: uid,
      contactNumber: "09123456789", barangay: "Bical", userType: "Volunteer", profileComplete: true, status: "active", testFixture: true });
  }
  await db.collection("sites").doc(SITE_ID).set({ siteId: SITE_ID, siteName: "View Report Browser Site",
    barangay: "Bical", municipality: "Bulan", province: "Sorsogon", latitude: 12.671, longitude: 123.875,
    coverageRadiusMeters: 100, status: "active", archived: false, testFixture: true });
  // Two released seedling types; the one final report covers both.
  const item = { inventoryId: INVENTORY_ID, species: "Narra", requestedQuantity: 25, releasedQuantity: 25, quantity: 25 };
  const secondItem = { inventoryId: SECOND_INVENTORY_ID, species: "Mahogany", requestedQuantity: 15, releasedQuantity: 15, quantity: 15 };
  await db.collection("seedlingRequests").doc(REQUEST_ID).set({ status: "Released", eventId: EVENT_ID,
    participantId: USERS[0][0], participantName: "Browser Planter", requestNumber: "REQ-VIEW-BROWSER",
    items: [item, secondItem], testFixture: true });
  await db.collection("distributions").doc(REQUEST_ID).set({ status: "Released", requestId: REQUEST_ID,
    eventId: EVENT_ID, participantId: USERS[0][0], participantName: "Browser Planter",
    plantingSiteId: SITE_ID, items: [item, secondItem], totalQuantityReleased: 40, testFixture: true });
  const event = { name: "View Report browser planting", sourceRequestId: REQUEST_ID, plantingSiteId: SITE_ID,
    plantingSiteName: "View Report Browser Site", barangay: "Bical", date: "2026-10-01", startTime: "08:00",
    endTime: "11:00", status: "Completed", recordStatus: "Scheduled", allocationReleasedAt: Timestamp.now(),
    seedlingItems: [{ inventoryId: INVENTORY_ID, species: "Narra", quantity: 25 },
      { inventoryId: SECOND_INVENTORY_ID, species: "Mahogany", quantity: 15 }], seedlingTotalQuantity: 40,
    testFixture: true };
  await db.collection("events").doc(EVENT_ID).set(event);
  await db.runTransaction((transaction) => parentForEventInTransaction(transaction, EVENT_ID, event, Timestamp.now()));

  // Unreported release (Narra 8 + Molave 4) used by the Participant form test, on its own site.
  await db.collection("sites").doc(FORM_SITE_ID).set({ siteId: FORM_SITE_ID, siteName: "View Report Form Site",
    barangay: "Bical", municipality: "Bulan", province: "Sorsogon", latitude: 12.672, longitude: 123.876,
    coverageRadiusMeters: 100, status: "active", archived: false, testFixture: true });
  const formItems = [
    { inventoryId: `${PREFIX}-form-narra`, species: "Narra", requestedQuantity: 8, releasedQuantity: 8, quantity: 8 },
    { inventoryId: `${PREFIX}-form-molave`, species: "Molave", requestedQuantity: 4, releasedQuantity: 4, quantity: 4 },
  ];
  await db.collection("seedlingRequests").doc(FORM_REQUEST_ID).set({ status: "Released", eventId: FORM_EVENT_ID,
    participantId: USERS[0][0], participantName: "Browser Planter", requestNumber: "REQ-VIEW-FORM", items: formItems, testFixture: true });
  await db.collection("distributions").doc(FORM_REQUEST_ID).set({ status: "Released", requestId: FORM_REQUEST_ID,
    eventId: FORM_EVENT_ID, participantId: USERS[0][0], participantName: "Browser Planter",
    plantingSiteId: FORM_SITE_ID, items: formItems, totalQuantityReleased: 12, testFixture: true });
  const formEvent = { ...event, name: "View Report form planting", sourceRequestId: FORM_REQUEST_ID,
    plantingSiteId: FORM_SITE_ID, plantingSiteName: "View Report Form Site",
    seedlingItems: formItems.map(({ inventoryId, species, quantity }) => ({ inventoryId, species, quantity })), seedlingTotalQuantity: 12 };
  await db.collection("events").doc(FORM_EVENT_ID).set(formEvent);
  await db.runTransaction((transaction) => parentForEventInTransaction(transaction, FORM_EVENT_ID, formEvent, Timestamp.now()));

  const token = await signIn(USERS[0][1]);
  const form = new FormData();
  Object.entries({
    // One final report for every released type: Narra 25 - 15 leftovers = 10 planted; Mahogany 15 planted.
    distributionId: REQUEST_ID, siteId: SITE_ID, barangay: "Bical", confirmationMode: "final",
    items: JSON.stringify([{ inventoryId: INVENTORY_ID, leftoverQuantity: 15, leftoverReason: "Seedlings damaged in transport" },
      { inventoryId: SECOND_INVENTORY_ID, leftoverQuantity: 0 }]),
    plantingDate: "2026-10-01", plantingLocation: "View Report Browser Site",
    eventId: EVENT_ID, eventName: event.name, submittedByName: "Browser Planter",
    submittedBySector: "Organization Member", submittedByContactNumber: "09123456789", remarks: "Browser acceptance",
  }).forEach(([key, value]) => form.append(key, value));
  const image = await fs.readFile(path.join(__dirname, "fixtures", "valid-original.jpg"));
  form.append("photos", new Blob([image], { type: "image/jpeg" }), "valid-original.jpg");
  const response = await fetch(`${API}/planting-reports`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
  });
  const payload = await response.json();
  if (response.status !== 201 || payload.success !== true) {
    throw new Error(`Participant submission failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  console.log(`Seeded ${REPORT_ID} with submission ${payload.data.submissions?.[0]?.id}.`);
}

(process.argv.includes("--cleanup") ? cleanup() : seed())
  .then(() => process.exit(0))
  .catch((error) => { console.error(error); process.exit(1); });
