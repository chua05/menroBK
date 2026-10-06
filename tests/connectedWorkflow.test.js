const assert = require("node:assert/strict");
const test = require("node:test");

process.env.GUEST_INVITATION_SECRET = "test-only-guest-invitation-secret-with-sufficient-length";

const records = new Map();
let generated = 0;
let transactionQueue = Promise.resolve();
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
      limit() { return this; },
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
  runTransaction(callback) {
    const execute = async () => {
      const writes = [];
      const transaction = {
        get: (reference) => reference.get(),
        update(reference, value) { writes.push(["update", reference, value]); },
        set(reference, value) { writes.push(["set", reference, value]); },
        create(reference, value) { writes.push(["create", reference, value]); },
      };
      const transactionResult = await callback(transaction);
      for (const [operation, reference, value] of writes) {
        const target = table(reference.name);
        if (operation === "create" && target.has(reference.id)) throw new Error("Already exists");
        target.set(reference.id, operation === "update" ? { ...target.get(reference.id), ...value } : value);
      }
      return transactionResult;
    };
    const result = transactionQueue.then(execute, execute);
    transactionQueue = result.catch(() => undefined);
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
const guestRoutes = require("../src/routes/guestEvent.routes");

function routeResponse() {
  return {
    result: {},
    status(code) { this.result.code = code; return this; },
    json(body) { this.result.body = body; return this; },
  };
}

async function invokeGuestContribution(headers, body) {
  const layer = guestRoutes.stack.find((entry) =>
    entry.route?.path === "/session/contributions" && entry.route.methods.post);
  assert.ok(layer, "guest contribution route exists");
  const req = { headers, body, ip: "127.0.0.1" };
  const res = routeResponse();
  let authenticated = false;
  await layer.route.stack[0].handle(req, res, () => { authenticated = true; });
  if (authenticated) await layer.route.stack.at(-1).handle(req, res);
  return res.result;
}

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
        eventName: "Planting", barangay: "Bical", plantingSiteId: "site-approval",
        proposedDate: "2026-10-20", proposedStartTime: "08:00", proposedEndTime: "10:00",
        expectedParticipants,
      },
    });
    table("seedlingInventory").set("calamansi", { species: "Calamansi", availableQuantity: 100 });
    table("sites").set("site-approval", { status: "active", siteName: "Site", barangay: "Bical", maximumCapacity: 100, planted: 0 });
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
    assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 100);
    assert.equal(table("seedlingInventory").get("calamansi").reservedQuantity || 0, 0);
    assert.equal(withoutGuests.inventoryDeducted, false);
    assert.equal(withoutGuests.inventoryReserved, false);

    seedReviewed("approve-guests-unconfigured", 4);
    const approvedWithoutInvitation = await requestService.approveSeedlingRequest(
      "approve-guests-unconfigured",
      "admin-1"
    );
    assert.equal(approvedWithoutInvitation.status, "Approved");
    assert.equal(approvedWithoutInvitation.guestInvitationCreated, false);
    assert.equal(table("eventInvitations").has(approvedWithoutInvitation.eventId), false);

    process.env.GUEST_INVITATION_SECRET = originalSecret;
    seedReviewed("approve-guests", 4);
    const withGuests = await requestService.approveSeedlingRequest("approve-guests", "admin-1");
    assert.equal(withGuests.status, "Approved");
    assert.equal(withGuests.guestInvitationCreated, true);
    assert.equal(table("eventInvitations").get(withGuests.eventId).active, true);
    assert.equal(table("eventInvitations").get(withGuests.eventId).tokenHash.length, 64);
    assert.equal(JSON.stringify(withGuests).includes(originalSecret), false);
    const count = table("events").size;
    await requestService.approveSeedlingRequest("approve-guests", "admin-1");
    assert.equal(table("events").size, count);
    assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 100);

    seedReviewed("approve-insufficient", 0);
    table("seedlingInventory").get("calamansi").availableQuantity = 9;
    await assert.rejects(
      requestService.approveSeedlingRequest("approve-insufficient", "admin-1"),
      /Insufficient available sapling stock for Calamansi/
    );
    assert.equal(table("seedlingRequests").get("approve-insufficient").status, "Reviewed");
    assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 9);
  } finally {
    process.env.GUEST_INVITATION_SECRET = originalSecret;
  }
});

test("partial release updates real stock, distribution, event allocation, and notification once", async () => {
  seedApproved("request-1", "EVT-2026-001");
  const input = { items: [{ inventoryId: "calamansi", releasedQuantity: 90, shortReleaseReason: "Ten damaged seedlings" }] };
  const released = await requestService.releaseSeedlingRequest("request-1", "staff-1", input);
  assert.equal(released.status, "Released");
  assert.equal(released.releaseType, "Partial");
  assert.equal(released.releasedItems[0].difference, 10);
  assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 160);
  assert.equal(table("distributions").get("request-1").items[0].releasedQuantity, 90);
  assert.equal(table("events").get("EVT-2026-001").seedlingItems[0].quantity, 90);
  assert.equal(table("plantingReports").get("event_EVT-2026-001").quantityReleased, 90);
  assert.match(
    table("plantingReports").get("event_EVT-2026-001").reportNumber,
    /^RPT-\d{4}-\d{3,}$/
  );
  assert.equal(table("plantingReports").get("event_EVT-2026-001").verificationStatus, "Pending");
  assert.equal(table("notifications").get("request_released_request-1").relatedEventId, "EVT-2026-001");
  const notificationCount = table("notifications").size;
  await assert.rejects(
    requestService.releaseSeedlingRequest("request-1", "staff-1", input),
    /already been released/
  );
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

test("release crossing the stock threshold alerts active Admin and Staff users once", async () => {
  table("users").set("low-admin", { role: "admin", status: "active" });
  table("users").set("low-staff", { role: "staff", status: "active" });
  table("users").set("inactive-staff", { role: "staff", status: "inactive" });
  seedApproved("request-low-stock", "EVT-LOW-STOCK", 25);
  table("seedlingRequests").get("request-low-stock").items[0].quantity = 10;

  await requestService.releaseSeedlingRequest("request-low-stock", "staff-1", {
    items: [{ inventoryId: "calamansi", releasedQuantity: 10, shortReleaseReason: "" }],
  });

  assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 15);
  assert.equal(table("seedlingInventory").get("calamansi").lowStockCycle, 1);
  assert.equal(table("notifications").has("low_stock_calamansi_1_low-admin"), true);
  assert.equal(table("notifications").has("low_stock_calamansi_1_low-staff"), true);
  assert.equal(table("notifications").has("low_stock_calamansi_1_inactive-staff"), false);
});

test("historical Approved requests use a real completed Distribution as Released read compatibility", async () => {
  table("seedlingRequests").set("legacy-released", {
    participantId: "participant-legacy", requestNumber: "REQ-2025-007", status: "Approved",
  });
  table("distributions").set("legacy-released", {
    requestId: "legacy-released", status: "Released", releasedBy: "staff-old",
    releasedAt: new Date("2025-10-01T08:00:00Z"), totalQuantityReleased: 7,
    items: [{ inventoryId: "legacy-narra", species: "Narra", releasedQuantity: 7, quantity: 7 }],
  });

  const view = await requestService.getSeedlingRequestById("legacy-released");
  assert.equal(view.status, "Released");
  assert.equal(view.legacyRequestStatus, "Approved");
  assert.equal(view.totalQuantityReleased, 7);
  assert.equal(view.releasedItems[0].species, "Narra");
  assert.equal(table("seedlingRequests").get("legacy-released").status, "Approved");
});

test("all authorized participants can use released event distributions with actual item quantities", async () => {
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
  Object.assign(table("events").get("EVT-2026-MULTI"), {
    recordStatus: "scheduled", plantingSiteId: "site-multi", barangay: "Bical",
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

  table("eventParticipants").set("joined-multi", {
    eventId: "EVT-2026-MULTI", userId: "participant-eligible",
    participantType: "participant", fullName: "Eligible Participant",
  });
  const eligibleRes = { result: {}, status(code) { this.result.code = code; return this; },
    json(body) { this.result.body = body; return this; } };
  await controller.getMyDistributions({ user: { uid: "participant-eligible" } }, eligibleRes);
  assert.equal(eligibleRes.result.body.data.some((item) => item.id === "request-multi"), true);
  const unrelatedRes = { result: {}, status(code) { this.result.code = code; return this; },
    json(body) { this.result.body = body; return this; } };
  await controller.getMyDistributions({ user: { uid: "participant-unrelated" } }, unrelatedRes);
  assert.equal(unrelatedRes.result.body.data.some((item) => item.id === "request-multi"), false);
});

test("planting-report event eligibility allows ongoing and completed events but blocks future and invalid events", () => {
  const { assertReportableEvent } = require("../src/services/plantingReport.service");
  const now = new Date("2026-10-03T12:00:00+08:00");

  assert.equal(assertReportableEvent({
    date: "2026-10-03", startTime: "08:00", endTime: "17:00",
    recordStatus: "scheduled", status: "Ongoing",
  }, now), "2026-10-03");
  assert.equal(assertReportableEvent({
    date: "2026-09-20", startTime: "08:00", endTime: "17:00",
    recordStatus: "completed", status: "Completed",
  }, now), "2026-09-20");
  assert.throws(() => assertReportableEvent({
    date: "2026-10-04", startTime: "08:00", recordStatus: "scheduled",
  }, now), /before the planting event begins/);
  assert.throws(() => assertReportableEvent({
    date: "2026-09-20", recordStatus: "completed", status: "Cancelled",
  }, now), /cancelled, rejected, or unavailable/);
  assert.throws(() => assertReportableEvent({
    date: "2026-09-20", recordStatus: "rejected",
  }, now), /cancelled, rejected, or unavailable/);
  assert.throws(() => assertReportableEvent({
    date: "2026-09-20", recordStatus: "completed", archived: true,
  }, now), /archived/);
});

test("only the request owner or an event participant can submit planting evidence", async () => {
  const sharp = require("sharp");
  const reportService = require("../src/services/plantingReport.service");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  const eventId = "EVT-AUTH-SCOPE";
  const requestId = "request-auth-scope";
  const reportId = `event_${eventId}`;
  seedApproved(requestId, eventId);
  await requestService.releaseSeedlingRequest(requestId, "staff-1", {
    items: [{ inventoryId: "calamansi", releasedQuantity: 90, shortReleaseReason: "Ten damaged" }],
  });
  const event = table("events").get(eventId);
  Object.assign(event, { recordStatus: "scheduled", plantingSiteId: "site-1", barangay: "Bical" });
  table("sites").set("site-1", {
    status: "active", siteName: "Site One", barangay: "Bical",
    latitude: 12.57, longitude: 123.965, coverageRadiusMeters: 50,
  });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "green" } })
    .jpeg()
    .withExif({
      IFD0: { Make: "Test Camera", Model: "Geo Test" },
      IFD3: {
        GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1",
        GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1",
      },
    })
    .toBuffer();
  const payload = {
    distributionId: requestId, inventoryId: "calamansi", siteId: "site-1",
    participantId: "participant-unrelated", participantName: "Maria Santos",
    participantType: "Volunteer", participantBarangay: "Bical", barangay: "Bical",
    quantityPlanted: 20, plantingDate: "2026-09-17", plantingLocation: "Site One",
    eventId,
  };
  assert.equal(table("plantingReports").get(reportId).verificationStatus, "Pending");
  await assert.rejects(reportService.createPlantingReport(payload, []), /photo is required/);
  assert.equal(table("plantingReports").get(reportId).verificationStatus, "Pending");
  await assert.rejects(reportService.createPlantingReport({ ...payload, plantingDate: "2026-02-30" },
    [{ buffer: image, mimetype: "image/jpeg", originalname: "evidence.jpg" }]), /valid planting date/);
  assert.equal(table("plantingReports").get(reportId).verificationStatus, "Pending");
  let submitted;
  try {
    await assert.rejects(
      reportService.createPlantingReport({ ...payload, participantId: "participant-not-joined" },
        [{ buffer: image, mimetype: "image/jpeg", originalname: "unauthorized.jpg" }]),
      /not authorized to submit planting reports/
    );
    await assert.rejects(
      reportService.createPlantingReport({ ...payload, barangay: "Calomagon" },
        [{ buffer: image, mimetype: "image/jpeg", originalname: "wrong-barangay.jpg" }]),
      /does not belong to the selected barangay/
    );
    table("eventParticipants").set("member-1", {
      eventId, userId: "participant-unrelated",
    });
    submitted = await reportService.createPlantingReport(payload,
      [{ buffer: image, mimetype: "image/jpeg", originalname: "evidence.jpg" }]);
    assert.equal(submitted.verificationStatus, "Partial");
    assert.ok(submitted.submittedAt);
    assert.equal(submitted.submissions.length, 1);
    assert.equal(submitted.submissions[0].plantingDate, "2026-09-17");
    assert.equal(submitted.submissions[0].photos.length, 1);
    assert.equal(submitted.participantId, "participant-1");
    assert.equal(submitted.submissions[0].participantId, "participant-unrelated");
    assert.equal(submitted.submissions[0].contributorId, "participant-unrelated");
    assert.equal(submitted.submissions[0].participantType, "participant");
    assert.equal(submitted.participantName, "Participant One");
    assert.equal(submitted.submittedByName, "Maria Santos");
    assert.equal(submitted.gpsValid, true);
    assert.equal(submitted.siteGpsValid, true);
    assert.equal(submitted.siteCoverageRadiusMeters, 50);
    assert.equal(submitted.siteGpsToleranceMeters, 50);
    assert.equal(submitted.siteLocationStatus, "Within Assigned Site");
    assert.equal(submitted.latitude, 12.57);
    assert.equal(submitted.longitude, 123.965);
    assert.equal(submitted.municipalityScope, "inside");
    assert.equal(submitted.locationVerificationStatus, "site_match");
    const mariaReports = await reportService.getPlantingReportsByParticipantId("participant-unrelated");
    assert.equal(mariaReports.some((report) => report.id === reportId), true);
    assert.equal(table("plantingReports").get(reportId).verificationStatus, "Partial");
    const secondImage = await sharp({ create: { width: 5, height: 5, channels: 3, background: "lime" } })
      .jpeg()
      .withExif({
        IFD0: { Make: "Test Camera", Model: "Geo Test 2" },
        IFD3: {
          GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1",
          GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1",
        },
      })
      .toBuffer();
    await assert.rejects(
      reportService.createPlantingReport({ ...payload, quantityPlanted: 71 },
        [{ buffer: secondImage, mimetype: "image/jpeg", originalname: "too-many.jpg" }]),
      /Only 70 trees remain available for reporting/
    );
    await assert.rejects(reportService.createPlantingReport(payload,
      [{ buffer: image, mimetype: "image/jpeg", originalname: "evidence.jpg" }]));
    assert.equal(table("plantingContributions").size, 1);
  } finally {
    for (const item of submitted?.submissions || []) {
      for (const photo of item.photos || []) await deletePlantingPhoto(photo.photoPath);
    }
  }
});

test("image without EXIF GPS is rejected even when client coordinates are supplied", async () => {
  const sharp = require("sharp");
  const controller = require("../src/controller/plantingReport.controller");
  const reportService = require("../src/services/plantingReport.service");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  seedApproved("request-no-gps", "EVT-NO-GPS");
  await requestService.releaseSeedlingRequest("request-no-gps", "staff-1", {
    items: [{ inventoryId: "calamansi", releasedQuantity: 100, shortReleaseReason: "" }],
  });
  Object.assign(table("events").get("EVT-NO-GPS"), {
    recordStatus: "scheduled", plantingSiteId: "site-no-gps", barangay: "Bical",
  });
  table("sites").set("site-no-gps", { status: "active", siteName: "Site", barangay: "Bical", latitude: 12, longitude: 123 });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
  const file = { buffer: image, mimetype: "image/png", originalname: "camera.png" };
  const body = {
    distributionId: "request-no-gps", inventoryId: "calamansi", siteId: "site-no-gps",
    participantType: "requester", participantBarangay: "Bical", barangay: "Bical", quantityPlanted: 20,
    plantingDate: "2026-09-17", plantingLocation: "Site", eventId: "EVT-NO-GPS",
    accuracy: "unavailable",
  };
  await assert.rejects(reportService.createPlantingReport({ ...body, participantId: "participant-1" }, [file]), /GPS location metadata was not found/);
  await assert.rejects(reportService.createPlantingReport({ ...body, participantId: "participant-1", siteId: "missing" }, [file]), /Site not found|Planting site not found/);
  const res = { result: {}, status(code) { this.result.code = code; return this; },
    json(value) { this.result.body = value; return this; } };
  body.latitude = 12;
  body.longitude = 123;
  await controller.submitPlantingReport({ body, user: { uid: "participant-1" }, files: { photo: [file] } }, res);
  assert.equal(res.result.code, 400);
  assert.match(res.result.body.message, /GPS location metadata was not found/);
});

test("client device coordinates never substitute for missing photo EXIF GPS", async () => {
  const sharp = require("sharp");
  const reportService = require("../src/services/plantingReport.service");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  seedApproved("request-outside", "EVT-OUTSIDE");
  await requestService.releaseSeedlingRequest("request-outside", "staff-1", {
    items: [{ inventoryId: "calamansi", releasedQuantity: 100, shortReleaseReason: "" }],
  });
  Object.assign(table("events").get("EVT-OUTSIDE"), {
    recordStatus: "scheduled", plantingSiteId: "site-outside", barangay: "Bical",
  });
  table("sites").set("site-outside", { status: "active", siteName: "Site", barangay: "Bical", latitude: 12, longitude: 123 });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(
    reportService.createPlantingReport({
      distributionId: "request-outside", inventoryId: "calamansi", siteId: "site-outside",
      participantId: "participant-1", participantType: "requester", participantBarangay: "Bical", barangay: "Bical",
      quantityPlanted: 20, plantingDate: "2026-09-17", plantingLocation: "Site",
      latitude: 0, longitude: 0, eventId: "EVT-OUTSIDE",
    }, [{ buffer: image, mimetype: "image/png", originalname: "outside.png" }]),
    /GPS location metadata was not found/
  );
  assert.equal(table("sites").get("site-outside").latitude, 12);
});

test("device coordinates cannot replace missing GPS in a Take Photo image", async () => {
  const sharp = require("sharp");
  const reportService = require("../src/services/plantingReport.service");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  seedApproved("request-device-photo", "EVT-DEVICE-PHOTO");
  await requestService.releaseSeedlingRequest("request-device-photo", "staff-1", {
    items: [{ inventoryId: "calamansi", releasedQuantity: 100, shortReleaseReason: "" }],
  });
  Object.assign(table("events").get("EVT-DEVICE-PHOTO"), {
    recordStatus: "scheduled", plantingSiteId: "site-device-photo", barangay: "Bical",
  });
  table("sites").set("site-device-photo", {
    status: "active", siteName: "Assigned Site", barangay: "Bical",
    latitude: 12.57, longitude: 123.965,
    polygon: [
      { lat: 12.794, lng: 123.999 }, { lat: 12.794, lng: 124.001 },
      { lat: 12.796, lng: 124.001 }, { lat: 12.796, lng: 123.999 },
    ],
  });
  const image = await sharp({ create: { width: 5, height: 5, channels: 3, background: "green" } })
    .jpeg().toBuffer();
  const capturedAt = new Date().toISOString();
  const existingContributionCount = table("plantingContributions").size;
  await assert.rejects(reportService.createPlantingReport({
      distributionId: "request-device-photo", inventoryId: "calamansi",
      siteId: "site-device-photo", participantId: "participant-1",
      participantType: "Student / School Representative", participantBarangay: "", barangay: "Bical",
      organizationAffiliation: "Sorsogon State University", participantContactNumber: "09123456789",
      quantityPlanted: 20, plantingDate: "2026-09-24",
      plantingLocation: "Assigned Site", eventId: "EVT-DEVICE-PHOTO",
      locationSource: "Device Location at Capture", latitude: 12.82, longitude: 123.965,
      accuracy: 8, photoCapturedAt: capturedAt, locationCapturedAt: capturedAt,
    }, [{ buffer: image, mimetype: "image/jpeg", originalname: "planting-capture.jpg" }]),
  /GPS location metadata was not found/);
  assert.equal(table("events").get("EVT-DEVICE-PHOTO").recordedSeedlingQuantity || 0, 0);
  assert.equal(table("plantingContributions").size, existingContributionCount);
});

test("valid EXIF GPS outside the assigned site is preserved, flagged, and submitted", async () => {
  const sharp = require("sharp");
  const reportService = require("../src/services/plantingReport.service");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  seedApproved("request-valid-outside", "EVT-VALID-OUTSIDE");
  await requestService.releaseSeedlingRequest("request-valid-outside", "staff-1", {
    items: [{ inventoryId: "calamansi", releasedQuantity: 100, shortReleaseReason: "" }],
  });
  Object.assign(table("events").get("EVT-VALID-OUTSIDE"), {
    recordStatus: "scheduled", plantingSiteId: "site-valid-outside", barangay: "Bical",
  });
  table("sites").set("site-valid-outside", {
    status: "active", siteName: "Assigned Site", barangay: "Bical",
    latitude: 12.57, longitude: 123.965, coverageRadiusMeters: 50,
    polygon: [
      { lat: 12.78, lng: 123.99 }, { lat: 12.78, lng: 124.01 },
      { lat: 12.83, lng: 124.01 }, { lat: 12.83, lng: 123.99 },
    ],
  });
  const image = await sharp({ create: { width: 5, height: 5, channels: 3, background: "purple" } })
    .jpeg()
    .withExif({
      IFD0: { Make: "Test Camera", Model: "Outside GPS Test" },
      IFD3: {
        GPSLatitudeRef: "N", GPSLatitude: "12/1 36/1 0/1",
        GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 0/1",
      },
    })
    .toBuffer();
  let submitted;
  try {
    submitted = await reportService.createPlantingReport({
      distributionId: "request-valid-outside", inventoryId: "calamansi",
      siteId: "site-valid-outside", participantId: "participant-1",
      participantType: "requester", participantBarangay: "Bical", barangay: "Bical",
      quantityPlanted: 20, plantingDate: "2026-09-17",
      plantingLocation: "Assigned Site", eventId: "EVT-VALID-OUTSIDE",
    }, [{ buffer: image, mimetype: "image/jpeg", originalname: "outside-original.jpg" }]);

    assert.equal(submitted.verificationStatus, "Partial");
    assert.equal(submitted.automatedVerificationStatus, "Flagged");
    assert.equal(submitted.gpsMetadataPresent, true);
    assert.equal(submitted.gpsValid, true);
    assert.equal(submitted.siteGpsValid, false);
    assert.equal(submitted.siteCoverageRadiusMeters, 50);
    assert.equal(submitted.siteLocationStatus, "Outside Assigned Site");
    assert.equal(submitted.latitude, 12.6);
    assert.equal(submitted.longitude, 123.95);
    assert.equal(submitted.municipalityScope, "inside");
    assert.equal(submitted.locationVerificationStatus, "site_mismatch");
    assert.equal(submitted.requiresStaffReview, true);
    assert.ok(submitted.suspiciousFlags.includes("OUTSIDE_REGISTERED_SITE"));
    assert.equal(table("events").get("EVT-VALID-OUTSIDE").plantingSiteId, "site-valid-outside");
    assert.equal(submitted.photos[0].siteLocationStatus, "Outside Assigned Site");
  } finally {
    for (const photo of submitted?.photos || []) await deletePlantingPhoto(photo.photoPath);
  }
});

test("photo coordinates outside the Municipality of Bulan are blocked", async () => {
  const sharp = require("sharp");
  const reportService = require("../src/services/plantingReport.service");
  seedApproved("request-outside-bulan", "EVT-OUTSIDE-BULAN");
  await requestService.releaseSeedlingRequest("request-outside-bulan", "staff-1", {
    items: [{ inventoryId: "calamansi", releasedQuantity: 100, shortReleaseReason: "" }],
  });
  Object.assign(table("events").get("EVT-OUTSIDE-BULAN"), {
    recordStatus: "scheduled", plantingSiteId: "site-outside-bulan", barangay: "Bical",
  });
  table("sites").set("site-outside-bulan", {
    status: "active", siteName: "Assigned Site", barangay: "Bical",
    latitude: 12.57, longitude: 123.965,
  });
  const image = await sharp({ create: { width: 5, height: 5, channels: 3, background: "orange" } })
    .jpeg()
    .withExif({
      IFD0: { Make: "Test Camera", Model: "Outside Municipality Test" },
      IFD3: {
        GPSLatitudeRef: "N", GPSLatitude: "14/1 0/1 0/1",
        GPSLongitudeRef: "E", GPSLongitude: "123/1 30/1 0/1",
      },
    })
    .toBuffer();

  await assert.rejects(
    reportService.createPlantingReport({
      distributionId: "request-outside-bulan", inventoryId: "calamansi",
      siteId: "site-outside-bulan", barangay: "Bical", participantId: "participant-1",
      participantType: "Volunteer", participantBarangay: "Bical",
      quantityPlanted: 20, plantingDate: "2026-09-17",
      plantingLocation: "Assigned Site", eventId: "EVT-OUTSIDE-BULAN",
    }, [{ buffer: image, mimetype: "image/jpeg", originalname: "outside-bulan.jpg" }]),
    /outside the Municipality of Bulan coverage area/
  );
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
  assert.deepEqual(own.result.body.data.map((item) => item.id), ["legacy-own-1"]);
  assert.deepEqual(own.result.body.data[0].history.map((item) => item.id), ["own-1"]);
});

test("invitation is scoped to owner, guest contact to event, and contribution to released allocation", async () => {
  table("seedlingRequests").set("request-3", {
    participantId: "participant-1", eventId: "EVT-GUEST-SCOPE", status: "Approved",
    participantName: "Requester One",
  });
  table("events").set("EVT-GUEST-SCOPE", {
    sourceRequestId: "request-3", status: "Upcoming", name: "Planting", date: "2026-09-29",
    allocationReleasedAt: new Date(), seedlingItems: [{ inventoryId: "calamansi", species: "Calamansi", quantity: 90 }],
    seedlingTotalQuantity: 90, plantingSiteId: "site-guest-scope", barangay: "Bical",
  });
  table("sites").set("site-guest-scope", {
    status: "active", siteName: "Guest Site", barangay: "Bical",
    latitude: 12.57, longitude: 123.965, coverageRadiusMeters: 100,
  });
  await db.runTransaction(async (transaction) => {
    guestService.createInvitationInTransaction(transaction, "EVT-GUEST-SCOPE", "request-3", new Date());
  });
  await assert.rejects(guestService.getInvitationForRequester("EVT-GUEST-SCOPE", "other"), /not found/);
  const { token } = await guestService.getInvitationForRequester("EVT-GUEST-SCOPE", "participant-1");
  const invitation = await guestService.validateInvitation(token);
  assert.equal(invitation.eventId, "EVT-GUEST-SCOPE");
  const publicEvent = await guestService.publicEvent(invitation.eventId, invitation.event);
  assert.deepEqual(publicEvent.allocation[0], {
    inventoryId: "calamansi", species: "Calamansi", allocated: 90, recorded: 0, remaining: 90,
  });
  const joined = await guestService.joinGuest(token, {
    fullName: "Guest One", contactNumber: "09123456789",
  });
  assert.equal(table("eventParticipants").get(joined.participantId).organizationBarangay, undefined);
  assert.equal((await guestService.validateGuestSession(`Guest ${joined.sessionToken}`)).eventId, "EVT-GUEST-SCOPE");
  await assert.rejects(guestService.joinGuest(token, {
    fullName: "Another", contactNumber: "+639123456789",
  }), /already joined/);
  const routeResult = await invokeGuestContribution(
    { authorization: `Guest ${joined.sessionToken}` },
    { inventoryId: "calamansi", quantity: 85, submissionKey: "submission_key_123" }
  );
  assert.equal(routeResult.code, 201);
  const first = routeResult.body.data;
  assert.equal(first.quantity, 85);
  assert.equal(first.participantId, joined.participantId);
  assert.equal(first.eventId, "EVT-GUEST-SCOPE");
  const duplicateResult = await invokeGuestContribution(
    { authorization: `Guest ${joined.sessionToken}` },
    { inventoryId: "calamansi", quantity: 85, submissionKey: "submission_key_123" }
  );
  assert.equal(duplicateResult.code, 201);
  const duplicate = duplicateResult.body.data;
  assert.equal(duplicate.id, first.id);
  const invalidSessionResult = await invokeGuestContribution(
    { authorization: "Guest invalid" },
    { inventoryId: "calamansi", quantity: 1, submissionKey: "invalid_session_key" }
  );
  assert.equal(invalidSessionResult.code, 401);
  assert.equal(invalidSessionResult.body.message, "Invalid guest session.");
  const expiredGuest = await guestService.joinGuest(token, {
    fullName: "Expired Guest", contactNumber: "09987654321",
  });
  table("eventParticipants").get(expiredGuest.participantId).expiresAt = new Date(0);
  const expiredSessionResult = await invokeGuestContribution(
    { authorization: `Guest ${expiredGuest.sessionToken}` },
    { inventoryId: "calamansi", quantity: 1, submissionKey: "expired_session_key" }
  );
  assert.equal(expiredSessionResult.code, 401);
  assert.match(expiredSessionResult.body.message, /expired/i);
  assert.equal(table("events").get("EVT-GUEST-SCOPE").recordedSeedlingQuantity || 0, 0);
  const sharp = require("sharp");
  const evidenceImage = await sharp({ create: { width: 5, height: 5, channels: 3, background: "green" } })
    .jpeg()
    .withExif({
      IFD0: { Make: "Test Camera", Model: "Guest Photo" },
      IFD3: {
        GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1",
        GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1",
      },
    })
    .toBuffer();
  const { attachEvidence } = require("../src/services/plantingEvidence.service");
  await attachEvidence("EVT-GUEST-SCOPE", joined.participantId, first.id,
    [{ buffer: evidenceImage, mimetype: "image/jpeg", originalname: "guest-original.jpg" }]);
  const excessiveResult = await invokeGuestContribution(
    { authorization: `Guest ${joined.sessionToken}` },
    { inventoryId: "calamansi", quantity: 10, submissionKey: "excess_quantity_key" }
  );
  assert.equal(excessiveResult.code, 400);
  assert.match(excessiveResult.body.message, /Only 5 seedlings remain available/);
  assert.equal(table("events").get("EVT-GUEST-SCOPE").recordedSeedlingQuantity, 85);
  assert.equal(table("plantingContributions").get(first.id).staffReviewStatus, "Pending Review");
  assert.equal(table("plantingReports").get("event_EVT-GUEST-SCOPE").reportingProgress, "Partial");
  assert.equal(table("plantingContributions").get(first.id).reportId, "event_EVT-GUEST-SCOPE");
  table("plantingContributions").get(first.id).photos = [{ imageHash: "guest-only-photo" }];
  const parentService = require("../src/services/parentPlantingReport.service");
  await assert.rejects(parentService.finalizeParent("event_EVT-GUEST-SCOPE", "participant-1"), /Planting evidence photos/);
  assert.equal(table("plantingReports").get("event_EVT-GUEST-SCOPE").reportingProgress, "Partial");
});

test("concurrent guest evidence submissions cannot exceed the released allocation", async () => {
  const sharp = require("sharp");
  const { attachEvidence } = require("../src/services/plantingEvidence.service");
  const eventId = "EVT-GUEST-CONCURRENT";
  table("seedlingRequests").set("request-guest-concurrent", {
    participantId: "owner-concurrent", status: "Approved", eventId,
  });
  table("events").set(eventId, {
    sourceRequestId: "request-guest-concurrent", status: "Upcoming", date: "2026-09-30",
    allocationReleasedAt: new Date(), plantingSiteId: "site-guest-concurrent", barangay: "Bical",
    seedlingItems: [{ inventoryId: "narra", species: "Narra", quantity: 10 }],
    seedlingTotalQuantity: 10,
  });
  table("sites").set("site-guest-concurrent", {
    status: "active", siteName: "Concurrent Site", barangay: "Bical",
    latitude: 12.57, longitude: 123.965, coverageRadiusMeters: 100,
  });
  for (const guestId of ["guest-concurrent-a", "guest-concurrent-b"]) {
    table("eventParticipants").set(guestId, {
      eventId, participantType: "guest", fullName: guestId,
    });
  }
  const [first, second] = await Promise.all([
    contributionService.recordContribution(eventId, "guest-concurrent-a", "narra", 10, "concurrent_key_a"),
    contributionService.recordContribution(eventId, "guest-concurrent-b", "narra", 10, "concurrent_key_b"),
  ]);
  const makeImage = (background, model) => sharp({
    create: { width: 5, height: 5, channels: 3, background },
  }).jpeg().withExif({
    IFD0: { Make: "Test Camera", Model: model },
    IFD3: {
      GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1",
      GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1",
    },
  }).toBuffer();
  const [firstImage, secondImage] = await Promise.all([
    makeImage("red", "Concurrent A"), makeImage("blue", "Concurrent B"),
  ]);
  const results = await Promise.allSettled([
    attachEvidence(eventId, "guest-concurrent-a", first.id,
      [{ buffer: firstImage, mimetype: "image/jpeg", originalname: "concurrent-a.jpg" }]),
    attachEvidence(eventId, "guest-concurrent-b", second.id,
      [{ buffer: secondImage, mimetype: "image/jpeg", originalname: "concurrent-b.jpg" }]),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message,
    /remaining reportable quantity|no longer accepting evidence/);
  assert.equal(table("events").get(eventId).recordedSeedlingQuantity, 10);
  assert.equal(table("plantingReports").get(`event_${eventId}`).activeSubmittedQuantity, 10);
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
  table("plantingContributions").get(one.id).photos = [
    { imageHash: `${one.id}-hash`, automatedStatus: "Flagged" },
  ];
  table("plantingContributions").get(two.id).photos = [
    { imageHash: `${two.id}-hash`, automatedStatus: "Passed Automated Check" },
  ];
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
  await assert.rejects(parentService.finalizeParent(one.reportId, "other"), /Planting evidence photos/);
  const requesterPhotos = table("plantingContributions").get(one.id).photos;
  table("plantingContributions").get(one.id).photos = [];
  await assert.rejects(parentService.finalizeParent(one.reportId, "same-requester"), /evidence photos/);
  table("plantingContributions").get(one.id).photos = requesterPhotos;
  const finalized = await parentService.finalizeParent(one.reportId, "same-requester");
  assert.equal(finalized.reportingProgress, "Partial");
  const plantingReportService = require("../src/services/plantingReport.service");
  Object.assign(table("plantingContributions").get(one.id), {
    verificationStatus: "Needs Review", staffReviewStatus: "Pending Review",
  });
  const reviewed = await plantingReportService.approvePlantingReport(one.id, "staff-1", "", "MENRO Staff");
  assert.equal(reviewed.reportingProgress, "Partial");
  const additional = await contributionService.recordContribution("EVT-2026-004", "guest-4", "calamansi", 1);
  assert.equal(additional.quantity, 1);
  assert.equal(table("plantingReports").get(three.reportId).verificationStatus, "Pending");
});

test("global search returns role-safe record links without exposing another participant's request", async () => {
  table("seedlingRequests").set("search-own", {
    participantId: "participant-search", requestNumber: "REQ-2026-901",
    participantName: "Needle Query Owner", status: "Reviewed",
  });
  table("seedlingRequests").set("search-other", {
    participantId: "another-participant", requestNumber: "REQ-2026-902",
    participantName: "Needle Query Other", status: "Pending",
  });
  table("seedlingInventory").set("search-inventory", {
    species: "Needle Query Narra", availableQuantity: 10,
  });
  table("plantingReports").set("search-own-report", {
    participantId: "participant-search", reportNumber: "RPT-2026-901",
    eventName: "Needle Query Planting", verificationStatus: "Approved",
  });
  table("plantingReports").set("search-other-report", {
    participantId: "another-participant", reportNumber: "RPT-2026-902",
    eventName: "Needle Query Private Planting", verificationStatus: "Approved",
  });
  table("monitoringRecords").set("search-own-monitoring", {
    recordType: "monitoringLifecycle",
    participantId: "participant-search", monitoringNumber: "MON-2026-901",
    siteName: "Needle Query Site", monitoringDate: "2026-09-26",
  });
  table("monitoringRecords").set("search-other-monitoring", {
    recordType: "monitoringLifecycle",
    participantId: "another-participant", monitoringNumber: "MON-2026-902",
    siteName: "Needle Query Private Site", monitoringDate: "2026-09-26",
  });
  table("generatedReports").set("search-generated", {
    reportNumber: "RPT-2026-903", type: "annual", status: "Generated",
    title: "Needle Query Annual Report", generatedAt: new Date("2026-09-26T08:00:00Z"),
  });
  const { globalSearch } = require("../src/services/search.service");

  const participantResults = await globalSearch({
    query: "needle query", role: "participant", userId: "participant-search", limit: 20,
  });
  assert.equal(participantResults.some((item) => item.id === "search-own"), true);
  assert.equal(participantResults.some((item) => item.id === "search-other"), false);
  assert.equal(participantResults.some((item) => item.id === "search-own-report"), true);
  assert.equal(participantResults.some((item) => item.id === "search-other-report"), false);
  assert.equal(participantResults.some((item) => item.id === "search-own-monitoring"), true);
  assert.equal(participantResults.some((item) => item.id === "search-other-monitoring"), false);
  assert.equal(participantResults.some((item) => item.type === "Inventory Sapling"), false);
  assert.equal(participantResults.some((item) => item.type === "Generated Report"), false);
  assert.match(participantResults.find((item) => item.id === "search-own").path, /my-requests\?request=search-own/);
  assert.match(participantResults.find((item) => item.id === "search-own-report").path, /my-planting-reports\?report=search-own-report/);
  assert.match(participantResults.find((item) => item.id === "search-own-monitoring").path, /survival-monitoring\?monitoring=search-own-monitoring/);

  const awaitingApproval = await globalSearch({
    query: "awaiting approval", role: "participant", userId: "participant-search", limit: 20,
  });
  assert.equal(awaitingApproval.some((item) => item.id === "search-own"), true);
  assert.match(awaitingApproval.find((item) => item.id === "search-own").subtitle, /Awaiting Approval/);

  const staffResults = await globalSearch({
    query: "needle query", role: "staff", userId: "staff-1", limit: 20,
  });
  assert.equal(staffResults.some((item) => item.id === "search-other"), true);
  assert.equal(staffResults.some((item) => item.id === "search-inventory"), true);
  assert.equal(staffResults.some((item) => item.id === "search-generated"), true);
  assert.match(staffResults.find((item) => item.id === "search-generated").path, /reports\?report=search-generated/);

  const searchController = require("../src/controller/search.controller");
  const roleTamperResponse = {
    result: {},
    status(code) { this.result.code = code; return this; },
    json(body) { this.result.body = body; return this; },
  };
  await searchController.search({
    query: { q: "needle query", limit: 20, role: "admin" },
    user: { uid: "participant-search", role: "participant" },
  }, roleTamperResponse);
  assert.equal(roleTamperResponse.result.code, 200);
  assert.equal(roleTamperResponse.result.body.data.results.some((item) => item.id === "search-other"), false);
  assert.equal(roleTamperResponse.result.body.data.results.some((item) => item.type === "Inventory Sapling"), false);
});
