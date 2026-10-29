const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");

const state = validateIntegrationEnvironment();
if (!state.integration || !state.requestLetterAcceptance) {
  throw new Error("Planting-report browser fixtures require the isolated request-letter acceptance environment.");
}

const { db } = require("../../src/config/firebase");

const SITE_ID = "planting-browser-espie";
const INVENTORY_ID = "planting-browser-mangga";
const EVENT_ID = "planting-browser-individual-oct27";
const ORGANIZATION_EVENT_ID = "planting-browser-organization-oct27";
const EMPTY_EVENT_ID = "planting-browser-empty-distribution";

async function seed() {
  const now = new Date();
  const batch = db.batch();
  batch.set(db.collection("sites").doc(SITE_ID), {
    siteId: SITE_ID,
    siteName: "Espie Backyard Planting Site",
    barangay: "N. Roque",
    municipality: "Bulan",
    province: "Sorsogon",
    latitude: 12.66,
    longitude: 123.91,
    coverageRadius: 100,
    status: "Active",
    archived: false,
    testFixture: true,
  });
  batch.set(db.collection("seedlingInventory").doc(INVENTORY_ID), {
    inventoryId: INVENTORY_ID,
    species: "Mangga",
    currentQuantity: 100,
    availableQuantity: 100,
    stockStatus: "Available",
    archived: false,
    testFixture: true,
  });
  for (const [id, eventName, sourceRequestId] of [
    [EVENT_ID, "Individual Planting Schedule", ""],
    [ORGANIZATION_EVENT_ID, "Organization Planting Event", "planting-browser-org-request"],
    [EMPTY_EVENT_ID, "No Distribution Event", ""],
  ]) {
    batch.set(db.collection("events").doc(id), {
      eventId: id,
      eventName,
      plantingSiteId: SITE_ID,
      date: "2026-10-27",
      startTime: "09:00",
      endTime: "11:00",
      recordStatus: "completed",
      status: "Completed",
      archived: false,
      allocationReleasedAt: now,
      sourceRequestId,
      testFixture: true,
    });
  }
  for (const [id, eventId, participantName, participantType] of [
    ["planting-browser-individual-distribution", EVENT_ID, "Synthetic Participant", "Individual"],
    ["planting-browser-organization-distribution", ORGANIZATION_EVENT_ID, "Synthetic Organization", "Organization"],
  ]) {
    batch.set(db.collection("distributions").doc(id), {
      distributionId: id,
      distributionNumber: id,
      status: "Released",
      eventId,
      plantingSiteId: SITE_ID,
      participantName,
      participantType,
      barangay: "N. Roque",
      items: [{ inventoryId: INVENTORY_ID, species: "Mangga", releasedQuantity: 10 }],
      totalQuantityReleased: 10,
      releasedAt: now,
      testFixture: true,
    });
  }
  await batch.commit();
  process.stdout.write(JSON.stringify({ projectId: state.projectId, siteId: SITE_ID, eventIds: [EVENT_ID, ORGANIZATION_EVENT_ID, EMPTY_EVENT_ID] }));
}

seed().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
