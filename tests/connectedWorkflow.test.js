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
      async get() {
        const docs = [...table(name)].map(([id, data]) => ({ id, data: () => data }));
        return { docs, empty: docs.length === 0 };
      },
      where(field, operator, value) {
        assert.ok(["==", "array-contains"].includes(operator));
        return { limit() { return this; }, async get() {
          const docs = [...table(name)].filter(([, data]) => operator === "array-contains"
            ? Array.isArray(data[field]) && data[field].includes(value) : data[field] === value)
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

test("Admin approval creates a scheduled event and only needed secure invitations", async () => {
  const originalSecret = process.env.GUEST_INVITATION_SECRET;
  const seedReviewed = (id, expectedParticipants) => {
    table("seedlingRequests").set(id, {
      status: "Reviewed", participantId: "participant-1", participantName: "Participant One",
      items: [{ inventoryId: "calamansi", species: "Calamansi", quantity: 10 }],
      eventProposal: {
        eventName: "Planting", barangay: "Bacolod", plantingSiteId: "site-approval",
        proposedDate: "2026-10-20", proposedStartTime: "08:00", proposedEndTime: "10:00",
        expectedParticipants,
      },
    });
    table("seedlingInventory").set("calamansi", { species: "Calamansi", availableQuantity: 100 });
    table("sites").set("site-approval", { status: "active", siteName: "Site", barangay: "Bacolod", maximumCapacity: 100, planted: 0 });
  };
  try {
    delete process.env.GUEST_INVITATION_SECRET;
    seedReviewed("approve-zero", 0);
    const withoutGuests = await requestService.approveSeedlingRequest("approve-zero", "admin-1");
    assert.equal(withoutGuests.status, "Approved");
    assert.equal(table("events").get(withoutGuests.eventId).recordStatus, "scheduled");
    assert.equal(table("events").get(withoutGuests.eventId).sourceRequestId, "approve-zero");
    assert.equal(table("events").get(withoutGuests.eventId).seedlingTotalQuantity, 0);
    assert.equal(table("eventInvitations").has(withoutGuests.eventId), false);

    seedReviewed("approve-guests", 4);
    await assert.rejects(requestService.approveSeedlingRequest("approve-guests", "admin-1"), /GUEST_INVITATION_SECRET/);
    assert.equal(table("seedlingRequests").get("approve-guests").status, "Reviewed");
    process.env.GUEST_INVITATION_SECRET = originalSecret;
    const withGuests = await requestService.approveSeedlingRequest("approve-guests", "admin-1");
    assert.equal(withGuests.status, "Approved");
    assert.equal(table("eventInvitations").get(withGuests.eventId).active, true);
    assert.equal(table("eventInvitations").get(withGuests.eventId).tokenHash.length, 64);
    assert.equal(JSON.stringify(withGuests).includes(originalSecret), false);
    const count = table("events").size;
    await requestService.approveSeedlingRequest("approve-guests", "admin-1");
    assert.equal(table("events").size, count);
  } finally {
    process.env.GUEST_INVITATION_SECRET = originalSecret;
  }
});

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
  assert.equal(table("plantingReports").get("event_EVT-2026-001").verificationStatus, "Pending");
  assert.equal(table("notifications").get("request_released_request-1").relatedEventId, "EVT-2026-001");
  const notificationCount = table("notifications").size;
  await requestService.releaseSeedlingRequest("request-1", "staff-1", input);
  assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 160);
  assert.equal(table("notifications").size, notificationCount);
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

test("own released distributions expose each species and actual partial quantities", async () => {
  seedApproved("request-multi", "EVT-2026-MULTI");
  table("seedlingRequests").get("request-multi").items.push({ inventoryId: "narra", species: "Narra", quantity: 50 });
  table("seedlingInventory").set("narra", {
    species: "Narra", availableQuantity: 60, reservedQuantity: 0, distributedQuantity: 0,
  });
  await requestService.releaseSeedlingRequest("request-multi", "staff-1", {
    items: [
      { inventoryId: "calamansi", releasedQuantity: 90, shortReleaseReason: "Ten damaged" },
      { inventoryId: "narra", releasedQuantity: 40, shortReleaseReason: "Ten damaged" },
    ],
  });
  const controller = require("../src/controller/distribution.controller");
  const res = { result: {}, status(code) { this.result.code = code; return this; },
    json(body) { this.result.body = body; return this; } };
  await controller.getMyDistributions({ user: { uid: "participant-1" }, query: { participantId: "other" } }, res);
  assert.equal(res.result.code, 200);
  const distribution = res.result.body.data.find((item) => item.id === "request-multi");
  assert.deepEqual(distribution.items.map((item) => [item.species, item.releasedQuantity]),
    [["Calamansi", 90], ["Narra", 40]]);
  assert.equal(distribution.totalQuantityReleased, 130);
  assert.equal(res.result.body.data.some((item) => item.participantId !== "participant-1"), false);
});

test("requester evidence moves a released parent from Pending to Pending Review once", async () => {
  const sharp = require("sharp");
  const reportService = require("../src/services/plantingReport.service");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  const reportId = "event_EVT-2026-001";
  const event = table("events").get("EVT-2026-001");
  Object.assign(event, { recordStatus: "scheduled", plantingSiteId: "site-1", barangay: "Bacolod" });
  table("sites").set("site-1", { status: "active", siteName: "Site One", barangay: "Bacolod", latitude: 12, longitude: 123 });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "green" } }).png().toBuffer();
  const payload = {
    distributionId: "request-1", inventoryId: "calamansi", siteId: "site-1",
    participantId: "participant-1", participantType: "requester", participantBarangay: "Bacolod",
    quantityPlanted: 20, plantingDate: "2026-09-17", plantingLocation: "Site One",
    latitude: 12, longitude: 123, eventId: "EVT-2026-001",
  };
  assert.equal(table("plantingReports").get(reportId).verificationStatus, "Pending");
  await assert.rejects(reportService.createPlantingReport(payload, []), /photo is required/);
  assert.equal(table("plantingReports").get(reportId).verificationStatus, "Pending");
  await assert.rejects(reportService.createPlantingReport({ ...payload, plantingDate: "2026-02-30" },
    [{ buffer: image, mimetype: "image/png", originalname: "evidence.png" }]), /valid planting date/);
  assert.equal(table("plantingReports").get(reportId).verificationStatus, "Pending");
  let submitted;
  try {
    submitted = await reportService.createPlantingReport(payload,
      [{ buffer: image, mimetype: "image/png", originalname: "evidence.png" }]);
    assert.equal(submitted.verificationStatus, "Pending Review");
    assert.ok(submitted.submittedAt);
    assert.equal(submitted.submissions.length, 1);
    assert.equal(submitted.submissions[0].plantingDate, "2026-09-17");
    assert.equal(submitted.submissions[0].photos.length, 1);
    assert.equal(table("plantingReports").get(reportId).verificationStatus, "Pending Review");
    await assert.rejects(reportService.createPlantingReport(payload,
      [{ buffer: image, mimetype: "image/png", originalname: "evidence.png" }]));
    assert.equal(table("plantingContributions").size, 1);
  } finally {
    for (const item of submitted?.submissions || []) {
      for (const photo of item.photos || []) await deletePlantingPhoto(photo.photoPath);
    }
  }
});

test("valid camera-style image submits without captured GPS and preserves missing metadata", async () => {
  const sharp = require("sharp");
  const controller = require("../src/controller/plantingReport.controller");
  const reportService = require("../src/services/plantingReport.service");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  seedApproved("request-no-gps", "EVT-NO-GPS");
  await requestService.releaseSeedlingRequest("request-no-gps", "staff-1", {
    items: [{ inventoryId: "calamansi", releasedQuantity: 100, shortReleaseReason: "" }],
  });
  Object.assign(table("events").get("EVT-NO-GPS"), {
    recordStatus: "scheduled", plantingSiteId: "site-no-gps", barangay: "Bacolod",
  });
  table("sites").set("site-no-gps", { status: "active", siteName: "Site", barangay: "Bacolod", latitude: 12, longitude: 123 });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
  const file = { buffer: image, mimetype: "image/png", originalname: "camera.png" };
  const body = {
    distributionId: "request-no-gps", inventoryId: "calamansi", siteId: "site-no-gps",
    participantType: "requester", participantBarangay: "Bacolod", quantityPlanted: 20,
    plantingDate: "2026-09-17", plantingLocation: "Site", eventId: "EVT-NO-GPS",
    accuracy: "unavailable",
  };
  await assert.rejects(reportService.createPlantingReport({ ...body, participantId: "other" }, [file]), /another participant/);
  await assert.rejects(reportService.createPlantingReport({ ...body, participantId: "participant-1", siteId: "missing" }, [file]), /Site not found|Planting site not found/);
  const res = { result: {}, status(code) { this.result.code = code; return this; },
    json(value) { this.result.body = value; return this; } };
  try {
    await controller.submitPlantingReport({ body, user: { uid: "participant-1" }, files: { photo: [file] } }, res);
    assert.equal(res.result.code, 201);
    const report = res.result.body.data;
    assert.equal(report.verificationStatus, "Pending Review");
    assert.equal(report.submissions[0].latitude, null);
    assert.equal(report.submissions[0].longitude, null);
    assert.equal(report.submissions[0].photos[0].gpsMetadataPresent, false);
    assert.equal(report.submissions[0].photos[0].gpsValid, false);
    assert.ok(report.submissions[0].photos[0].suspiciousFlags.includes("GPS_METADATA_MISSING"));
    assert.equal(report.submissions[0].photos[0].automatedStatus, null);
    assert.equal(report.automatedVerificationStatus, null);
    assert.ok(report.submissions[0].photos[0].photoPath);
  } finally {
    for (const submission of res.result.body?.data?.submissions || []) {
      for (const photo of submission.photos || []) await deletePlantingPhoto(photo.photoPath);
    }
  }
});

test("out-of-site captured coordinates remain informational and do not block evidence", async () => {
  const sharp = require("sharp");
  const reportService = require("../src/services/plantingReport.service");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  seedApproved("request-outside", "EVT-OUTSIDE");
  await requestService.releaseSeedlingRequest("request-outside", "staff-1", {
    items: [{ inventoryId: "calamansi", releasedQuantity: 100, shortReleaseReason: "" }],
  });
  Object.assign(table("events").get("EVT-OUTSIDE"), {
    recordStatus: "scheduled", plantingSiteId: "site-outside", barangay: "Bacolod",
  });
  table("sites").set("site-outside", { status: "active", siteName: "Site", barangay: "Bacolod", latitude: 12, longitude: 123 });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  let report;
  try {
    report = await reportService.createPlantingReport({
      distributionId: "request-outside", inventoryId: "calamansi", siteId: "site-outside",
      participantId: "participant-1", participantType: "requester", participantBarangay: "Bacolod",
      quantityPlanted: 20, plantingDate: "2026-09-17", plantingLocation: "Site",
      latitude: 0, longitude: 0, eventId: "EVT-OUTSIDE",
    }, [{ buffer: image, mimetype: "image/png", originalname: "outside.png" }]);
    assert.equal(report.verificationStatus, "Pending Review");
    assert.equal(report.submissions[0].siteGpsValid, false);
    assert.ok(report.submissions[0].suspiciousFlags.includes("OUTSIDE_REGISTERED_SITE"));
    assert.equal(report.automatedVerificationStatus, null);
    assert.equal(table("sites").get("site-outside").latitude, 12);
  } finally {
    for (const submission of report?.submissions || []) {
      for (const photo of submission.photos || []) await deletePlantingPhoto(photo.photoPath);
    }
  }
});

test("participant monitoring returns only own records and accepts an empty history", async () => {
  const controller = require("../src/controller/monitoring.controller");
  const routes = require("../src/routes/monitoring.routes");
  const ownRoute = routes.stack.find((layer) => layer.route?.path === "/my-records" && layer.route.methods.get);
  assert.ok(ownRoute);
  let allowed = false;
  ownRoute.route.stack[1].handle({ user: { role: "participant" } }, {}, () => { allowed = true; });
  assert.equal(allowed, true);
  const response = () => ({ result: {}, status(code) { this.result.code = code; return this; },
    json(body) { this.result.body = body; return this; } });
  const empty = response();
  await controller.getMyMonitoringRecords({ user: { uid: "participant-no-records" } }, empty);
  assert.equal(empty.result.code, 200);
  assert.deepEqual(empty.result.body.data, []);
  table("monitoringRecords").set("own-1", { participantId: "participant-1", healthyCount: 8 });
  table("monitoringRecords").set("other-1", { participantId: "participant-2", healthyCount: 5 });
  const own = response();
  await controller.getMyMonitoringRecords({ user: { uid: "participant-1" } }, own);
  assert.equal(own.result.code, 200);
  assert.deepEqual(own.result.body.data.map((item) => item.id), ["own-1"]);
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
  assert.equal(table("plantingReports").get("event_EVT-2026-003").verificationStatus, "Pending");
  assert.equal(table("plantingContributions").get(first.id).reportId, "event_EVT-2026-003");
  table("plantingContributions").get(first.id).photos = [{ imageHash: "guest-only-photo" }];
  const parentService = require("../src/services/parentPlantingReport.service");
  await assert.rejects(parentService.finalizeParent("event_EVT-2026-003", "participant-1"), /Requester planting evidence/);
  assert.equal(table("plantingReports").get("event_EVT-2026-003").verificationStatus, "Pending");
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
  const plantingReportService = require("../src/services/plantingReport.service");
  const approved = await plantingReportService.approvePlantingReport(one.reportId, "staff-1", "", "MENRO Staff");
  assert.equal(approved.verificationStatus, "Approved");
  await assert.rejects(contributionService.recordContribution("EVT-2026-004", "guest-4", "calamansi", 1),
    /already been finalized/);
  assert.equal(table("plantingReports").get(three.reportId).verificationStatus, "Pending");
});
