const assert = require("node:assert/strict");
const test = require("node:test");

process.env.GUEST_INVITATION_SECRET = "test-only-guest-invitation-secret-with-sufficient-length";

const records = new Map();
let generated = 0;
function table(name) {
  if (!records.has(name)) records.set(name, new Map());
  return records.get(name);
}
function ref(name, id) {
  return {
    id, name,
    async get() {
      const value = table(name).get(id);
      return { id, exists: value !== undefined, data: () => value };
    },
  };
}
const db = {
  collection(name) {
    return {
      doc(id = `generated-${++generated}`) { return ref(name, id); },
      where(field, operator, value) {
        assert.equal(operator, "==");
        return { limit() { return this; }, async get() {
          const docs = [...table(name)].filter(([, data]) => data[field] === value)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs, empty: docs.length === 0 };
        } };
      },
    };
  },
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: (reference) => reference.get(),
      update(reference, value) { writes.push(["update", reference, value]); },
      set(reference, value) { writes.push(["set", reference, value]); },
      create(reference, value) { writes.push(["create", reference, value]); },
    };
    const result = await callback(transaction);
    for (const [operation, reference, value] of writes) {
      const target = table(reference.name);
      if (operation === "create" && target.has(reference.id)) throw new Error("Already exists");
      target.set(reference.id, operation === "update" ? { ...target.get(reference.id), ...value } : value);
    }
    return result;
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true, exports: { db, auth: {} },
};
const requestService = require("../src/services/seedlingRequest.service");
const guestService = require("../src/services/guestEvent.service");
const contributionService = require("../src/services/plantingContribution.service");

function seedApproved(id, eventId, available = 250) {
  table("seedlingRequests").set(id, {
    participantId: "participant-1", participantName: "Participant One",
    status: "Approved", eventId, inventoryReserved: false, inventoryReleased: false,
    items: [{ inventoryId: "calamansi", species: "Calamansi", quantity: 100 }],
  });
  table("events").set(eventId, {
    sourceRequestId: id, name: "Tree Planting", status: "Upcoming",
    expectedParticipants: 2, seedlingItems: [], seedlingTotalQuantity: 0,
  });
  table("seedlingInventory").set("calamansi", {
    species: "Calamansi", availableQuantity: available,
    reservedQuantity: 0, distributedQuantity: 0, lowStockThreshold: 20,
  });
}

test("partial release updates real stock, distribution, event allocation, and notification once", async () => {
  seedApproved("request-1", "EVT-2026-001");
  const input = { items: [{ inventoryId: "calamansi", releasedQuantity: 90, shortReleaseReason: "Ten damaged seedlings" }] };
  const released = await requestService.releaseSeedlingRequest("request-1", "staff-1", input);
  assert.equal(released.status, "Approved");
  assert.equal(released.releaseType, "Partial");
  assert.equal(released.releasedItems[0].difference, 10);
  assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 160);
  assert.equal(table("distributions").get("request-1").items[0].releasedQuantity, 90);
  assert.equal(table("events").get("EVT-2026-001").seedlingItems[0].quantity, 90);
  assert.equal(table("plantingReports").get("event_EVT-2026-001").quantityReleased, 90);
  assert.equal(table("plantingReports").get("event_EVT-2026-001").verificationStatus, "Draft");
  assert.equal(table("notifications").get("request_released_request-1").relatedEventId, "EVT-2026-001");
  await requestService.releaseSeedlingRequest("request-1", "staff-1", input);
  assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 160);
  assert.equal(table("notifications").size, 1);
  assert.equal([...table("plantingReports")].filter(([, report]) => report.eventId === "EVT-2026-001").length, 1);
});

test("invalid release leaves inventory, event, and distribution unchanged", async () => {
  seedApproved("request-2", "EVT-2026-002", 80);
  for (const input of [
    { items: [{ inventoryId: "calamansi", releasedQuantity: 90, shortReleaseReason: "Short" }] },
    { items: [{ inventoryId: "calamansi", releasedQuantity: 120, shortReleaseReason: "" }] },
    { items: [{ inventoryId: "calamansi", releasedQuantity: 90, shortReleaseReason: "" }] },
  ]) {
    await assert.rejects(requestService.releaseSeedlingRequest("request-2", "staff-1", input));
  }
  assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 80);
  assert.equal(table("distributions").has("request-2"), false);
  assert.deepEqual(table("events").get("EVT-2026-002").seedlingItems, []);
});

test("invitation is scoped to owner, guest contact to event, and contribution to released allocation", async () => {
  table("seedlingRequests").set("request-3", {
    participantId: "participant-1", eventId: "EVT-2026-003", status: "Approved",
    participantName: "Requester One",
  });
  table("events").set("EVT-2026-003", {
    sourceRequestId: "request-3", status: "Upcoming", name: "Planting",
    allocationReleasedAt: new Date(), seedlingItems: [{ inventoryId: "calamansi", species: "Calamansi", quantity: 90 }],
    seedlingTotalQuantity: 90,
  });
  await db.runTransaction(async (transaction) => {
    guestService.createInvitationInTransaction(transaction, "EVT-2026-003", "request-3", new Date());
  });
  await assert.rejects(guestService.getInvitationForRequester("EVT-2026-003", "other"), /not found/);
  const { token } = await guestService.getInvitationForRequester("EVT-2026-003", "participant-1");
  assert.equal((await guestService.validateInvitation(token)).eventId, "EVT-2026-003");
  const joined = await guestService.joinGuest(token, {
    fullName: "Guest One", organizationBarangay: "Juban", contactNumber: "09123456789",
  });
  assert.equal((await guestService.validateGuestSession(`Guest ${joined.sessionToken}`)).eventId, "EVT-2026-003");
  await assert.rejects(guestService.joinGuest(token, {
    fullName: "Another", organizationBarangay: "Juban", contactNumber: "+639123456789",
  }), /already joined/);
  const first = await contributionService.recordContribution("EVT-2026-003", joined.participantId, "calamansi", 85);
  assert.equal(first.quantity, 85);
  await assert.rejects(contributionService.recordContribution("EVT-2026-003", joined.participantId, "calamansi", 10), /Only 5/);
  assert.equal(table("events").get("EVT-2026-003").recordedSeedlingQuantity, 85);
  assert.equal(table("plantingReports").get("event_EVT-2026-003").verificationStatus, "Draft");
  assert.equal(table("plantingContributions").get(first.id).reportId, "event_EVT-2026-003");
});

test("one parent groups multiple contributors and separate events get separate parents", async () => {
  const parentService = require("../src/services/parentPlantingReport.service");
  for (const [eventId, requestId] of [["EVT-2026-004", "request-4"], ["EVT-2026-005", "request-5"]]) {
    table("seedlingRequests").set(requestId, {
      participantId: "same-requester", participantName: "Same Requester",
      eventId, status: "Approved",
    });
    table("events").set(eventId, {
      sourceRequestId: requestId, name: "Tree Planting", status: "Upcoming",
      allocationReleasedAt: new Date(),
      seedlingItems: [{ inventoryId: "calamansi", species: "Calamansi", quantity: 40 }],
      seedlingTotalQuantity: 40,
    });
  }
  table("eventParticipants").set("requester-4", {
    eventId: "EVT-2026-004", userId: "same-requester",
    participantType: "participant", fullName: "Same Requester",
  });
  table("eventParticipants").set("guest-4", {
    eventId: "EVT-2026-004", participantType: "guest", fullName: "Guest One",
    contactNumber: "09123456789",
  });
  table("eventParticipants").set("requester-5", {
    eventId: "EVT-2026-005", userId: "same-requester",
    participantType: "participant", fullName: "Same Requester",
  });
  const one = await contributionService.recordContribution("EVT-2026-004", "requester-4", "calamansi", 10);
  const two = await contributionService.recordContribution("EVT-2026-004", "guest-4", "calamansi", 5);
  const three = await contributionService.recordContribution("EVT-2026-005", "requester-5", "calamansi", 7);
  assert.equal(one.reportId, two.reportId);
  assert.notEqual(one.reportId, three.reportId);
  const details = await parentService.reportDetails(one.reportId, table("plantingReports").get(one.reportId));
  assert.equal(details.submissions.length, 2);
  assert.equal(details.contributorCount, 2);
  assert.deepEqual(details.allocationSummary[0], {
    inventoryId: "calamansi", species: "Calamansi", allocated: 40, recorded: 15, remaining: 25,
  });
  const participants = await guestService.getEventParticipants("EVT-2026-004");
  assert.equal(participants.length, 2);
  assert.equal(participants.find((entry) => entry.id === "guest-4").quantityPlanted, 5);
  assert.equal(JSON.stringify(participants).includes("09123456789"), false);
  await assert.rejects(parentService.finalizeParent(one.reportId, "other"), /not found/);
  await assert.rejects(parentService.finalizeParent(one.reportId, "same-requester"), /evidence photos/);
  for (const id of [one.id, two.id]) {
    table("plantingContributions").get(id).photos = [{ imageHash: `${id}-hash`, automatedStatus: "Flagged" }];
  }
  const finalized = await parentService.finalizeParent(one.reportId, "same-requester");
  assert.equal(finalized.verificationStatus, "Pending Review");
  await assert.rejects(contributionService.recordContribution("EVT-2026-004", "guest-4", "calamansi", 1),
    /already been finalized/);
  const plantingReportService = require("../src/services/plantingReport.service");
  const approved = await plantingReportService.approvePlantingReport(one.reportId, "staff-1", "", "MENRO Staff");
  assert.equal(approved.verificationStatus, "Approved");
  assert.equal(table("plantingReports").get(three.reportId).verificationStatus, "Draft");
});
