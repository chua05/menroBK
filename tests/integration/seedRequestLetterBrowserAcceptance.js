const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

const state = validateIntegrationEnvironment();
if (!state.integration || !state.requestLetterAcceptance) {
  throw new Error("Request-letter browser fixtures require the explicit 8181 acceptance gate.");
}

const { auth, db } = require("../../src/config/firebase");

const PASSWORD = "Request-Letter-Browser!2026";
const USERS = [
  ["request-letter-browser-participant", "request-letter.browser.participant@example.test", "participant", "Browser Participant"],
  ["request-letter-browser-other", "request-letter.browser.other@example.test", "participant", "Other Browser Participant"],
  ["request-letter-browser-staff", "request-letter.browser.staff@example.test", "staff", "Browser MENRO Staff"],
  ["request-letter-browser-admin", "request-letter.browser.admin@example.test", "admin", "Browser MENRO Admin"],
];
const SITE_ID = "request-letter-browser-site";
const INVENTORY_ID = "request-letter-browser-inventory";

async function seed() {
  for (const [uid, email, role, fullName] of USERS) {
    try { await auth.deleteUser(uid); } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
    await auth.createUser({ uid, email, password: PASSWORD, emailVerified: true, displayName: fullName });
    await db.collection("users").doc(uid).set({ uid, email, role, fullName, username: uid,
      contactNumber: "09123456789", organization: role === "participant" ? "Browser Test Organization" : "MENRO",
      userType: role === "participant" ? "Organization Member" : "MENRO",
      userTypeDetail: role === "participant" ? "Browser Test Organization" : "",
      affiliationName: role === "participant" ? "Browser Test Organization" : "",
      barangay: "Bical", profileComplete: true, status: "active", testFixture: true });
  }
  await db.collection("sites").doc(SITE_ID).set({ siteId: SITE_ID, siteName: "Zone 8 Community Green Site",
    barangay: "Zone VIII", municipality: "Bulan", province: "Sorsogon", latitude: 12.671,
    longitude: 123.875, coverageRadius: 100, maximumCapacity: 1000, currentTreeCount: 0,
    status: "Active", archived: false, testFixture: true });
  await db.collection("seedlingInventory").doc(INVENTORY_ID).set({ inventoryId: INVENTORY_ID,
    species: "Narra", treeName: "Narra", category: "Native Tree", currentQuantity: 500,
    availableQuantity: 500, initialQuantity: 500, stockStatus: "Available", sourceType: "MENRO Propagation",
    dateReceived: "2026-10-01", storageLocation: "MENRO Nursery", archived: false, testFixture: true });
  await db.collection("seedlingRequests").doc("request-letter-browser-historical").set({
    participantId: "request-letter-browser-participant", requestNumber: "REQ-HISTORICAL-BROWSER",
    status: "Pending Review", requestVersion: 0, purpose: "Historical metadata fixture",
    workflow: { requestLetter: { name: "historical-only.pdf", type: "application/pdf", size: 12 } },
    testFixture: true, createdAt: new Date(), updatedAt: new Date(),
  });
  for (const [id, title, createdAt] of [
    ["request-letter-topbar-one", "Topbar unread one", new Date(Date.now() + 1_000)],
    ["request-letter-topbar-two", "Topbar unread two", new Date(Date.now() + 2_000)],
  ]) {
    await db.collection("notifications").doc(id).set({
      notificationId: id,
      recipientUserId: "request-letter-browser-participant",
      title,
      message: "Synthetic Topbar acceptance notification.",
      type: "request_submitted",
      relatedRecordType: "seedlingRequest",
      relatedRecordId: "request-letter-browser-historical",
      isRead: false,
      readAt: null,
      createdAt,
      testFixture: true,
    });
  }
  process.stdout.write(JSON.stringify({ projectId: state.projectId, users: USERS.map(([, email, role]) => ({ email, role })),
    siteId: SITE_ID, inventoryId: INVENTORY_ID }));
}

seed().catch((error) => { console.error(error.message); process.exitCode = 1; });
