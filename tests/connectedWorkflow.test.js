const assert = require("node:assert/strict");
const test = require("node:test");

process.env.GUEST_INVITATION_SECRET = "test-only-guest-invitation-secret-with-sufficient-length";
// Historical-compatibility tests: the legacy per-type Participant path still
// exists behind PLANTING_FINAL_REPORT_ENFORCED=false (rollback / old records).
function legacyMode(t) {
  const previous = process.env.PLANTING_FINAL_REPORT_ENFORCED;
  process.env.PLANTING_FINAL_REPORT_ENFORCED = "false";
  t.after(() => { if (previous === undefined) delete process.env.PLANTING_FINAL_REPORT_ENFORCED; else process.env.PLANTING_FINAL_REPORT_ENFORCED = previous; });
}

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
    async update(value) {
      const current = { ...table(name).get(id) };
      for (const [key, nextValue] of Object.entries(value)) {
        const path = key.split(".");
        let target = current;
        while (path.length > 1) {
          const segment = path.shift();
          target[segment] = { ...(target[segment] || {}) };
          target = target[segment];
        }
        target[path[0]] = nextValue;
      }
      table(name).set(id, current);
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

test("Admin approval creates a scheduled event and only needed secure invitations", async (t) => {
  // These fixed October schedules describe a future approval scenario, not wall-clock time.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T00:00:00Z") });
  const originalSecret = process.env.GUEST_INVITATION_SECRET;
  const seedReviewed = (id, expectedParticipants) => {
    table("seedlingRequests").set(id, {
      status: "Reviewed", participantId: "participant-1", participantName: "Participant One",
      preferredReleaseDate: "2026-10-19",
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
    const approvalNotifications = [...table("notifications").values()];
    assert.ok(approvalNotifications.some((item) => item.type === "event_scheduled" &&
      item.recipientUserId === "admin-1" && item.relatedEventId === withoutGuests.eventId));
    assert.ok(approvalNotifications.some((item) => item.type === "request_approved" &&
      item.recipientUserId === "participant-1" && item.relatedEventId === withoutGuests.eventId &&
      item.message.includes("is scheduled for 2026-10-20 08:00-10:00")));

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
      /Insufficient available seedling stock for Calamansi/
    );
    assert.equal(table("seedlingRequests").get("approve-insufficient").status, "Reviewed");
    assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 9);
  } finally {
    process.env.GUEST_INVITATION_SECRET = originalSecret;
  }
});

test("Admin approval rejects an expired effective schedule without creating an event", async () => {
  table("seedlingRequests").set("approve-expired", {
    status: "Reviewed", requestVersion: 0, participantId: "participant-1", participantName: "Participant One",
    preferredReleaseDate: "2020-10-11",
    items: [{ inventoryId: "expired-tree", species: "Narra", quantity: 10 }],
    eventProposal: { eventName: "Expired Planting", barangay: "Bical", plantingSiteId: "site-expired", proposedDate: "2020-10-12", proposedStartTime: "06:00", proposedEndTime: "", expectedParticipants: 0 },
  });
  table("seedlingInventory").set("expired-tree", { species: "Narra", availableQuantity: 100 });
  table("sites").set("site-expired", { status: "active", siteName: "Site", barangay: "Bical", maximumCapacity: 100, planted: 0 });
  const eventCount = table("events").size;
  await assert.rejects(requestService.approveSeedlingRequest("approve-expired", "admin-1", "", 0),
    (error) => error.code === "SCHEDULE_STALE" && /release date is in the past/.test(error.message));
  assert.equal(table("events").size, eventCount);
  assert.equal(table("seedlingRequests").get("approve-expired").status, "Reviewed");
});

test("Admin approval registers a proposed site with the authenticated administrator audit UID", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T00:00:00Z") });
  table("seedlingRequests").set("approve-proposed-site", {
    status: "Reviewed",
    preferredReleaseDate: "2026-10-19",
    participantId: "participant-proposed",
    participantName: "Proposed Site Owner",
    items: [{ inventoryId: "narra-proposed", species: "Narra", quantity: 10 }],
    workflow: {
      siteMode: "proposed",
      siteName: "Participant Proposed Site",
      siteBarangay: "Bical",
      landType: "Private Land",
      specificLocation: "Bical, Bulan",
      areaChoice: "1 hectare",
      latitude: 12.57,
      longitude: 123.965,
    },
    eventProposal: {
      eventName: "Proposed Site Planting",
      barangay: "Bical",
      plantingSiteId: "",
      proposedDate: "2026-10-20",
      proposedStartTime: "08:00",
      proposedEndTime: "10:00",
      expectedParticipants: 0,
    },
  });
  table("seedlingInventory").set("narra-proposed", {
    species: "Narra",
    availableQuantity: 100,
  });

  const approved = await requestService.approveSeedlingRequest(
    "approve-proposed-site",
    "admin-proposed-1"
  );
  const site = table("sites").get(approved.workflow.officialSiteId);

  assert.equal(approved.status, "Approved");
  assert.equal(approved.approvedBy, "admin-proposed-1");
  assert.equal(site.createdBy, "admin-proposed-1");
  assert.equal(site.updatedBy, "admin-proposed-1");
  assert.equal(table("events").get(approved.eventId).createdBy, "admin-proposed-1");
  assert.equal(table("seedlingInventory").get("narra-proposed").availableQuantity, 100);
});

test("Approval and rejection reject a missing authenticated administrator UID before writing", async () => {
  const before = table("seedlingRequests").size;
  await assert.rejects(
    requestService.approveSeedlingRequest("any-request", ""),
    /authenticated administrator is required/
  );
  await assert.rejects(
    requestService.rejectSeedlingRequest("any-request", undefined, "Not eligible"),
    /authenticated administrator is required/
  );
  assert.equal(table("seedlingRequests").size, before);
});

test("Administrator rejection records the verified actor and notifies without changing inventory", async () => {
  table("seedlingRequests").set("reject-reviewed", {
    status: "Reviewed",
    requestNumber: "REQ-2026-998",
    participantId: "participant-rejected",
    participantName: "Rejected Participant",
  });
  table("seedlingInventory").set("reject-stock", {
    species: "Narra",
    availableQuantity: 25,
  });

  const rejected = await requestService.rejectSeedlingRequest(
    "reject-reviewed",
    "admin-reject-1",
    "The planting plan requires revision."
  );

  assert.equal(rejected.status, "Rejected");
  assert.equal(rejected.rejectedBy, "admin-reject-1");
  assert.equal(rejected.decisionBy, "admin-reject-1");
  assert.ok(rejected.rejectedAt);
  assert.equal(table("seedlingInventory").get("reject-stock").availableQuantity, 25);
  assert.equal(
    table("notifications").get("request_rejected_reject-reviewed_participant-rejected").recipientUserId,
    "participant-rejected"
  );
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

test("unresolved late-release conflict blocks seedling release", async () => {
  seedApproved("release-conflict", "event-release-conflict", 100);
  table("seedlingRequests").set("release-conflict", {
    ...table("seedlingRequests").get("release-conflict"),
    requestVersion: 2,
    lateReleaseRescheduling: { status: "AwaitingRequester", version: 1 },
  });
  await assert.rejects(
    requestService.releaseSeedlingRequest("release-conflict", "staff-1", {
      expectedVersion: 2,
      availableReleaseDate: "2026-10-20",
      items: [{ inventoryId: "calamansi", releasedQuantity: 100 }],
    }),
    (error) => error.code === "UNRESOLVED_LATE_RELEASE_CONFLICT",
  );
  assert.equal(table("seedlingRequests").get("release-conflict").status, "Approved");
  assert.equal(table("distributions").has("release-conflict"), false);
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
  assert.equal(table("notifications").has("distribution_completed_request-low-stock_low-admin"), true);
  assert.equal(table("notifications").has("distribution_completed_request-low-stock_low-staff"), true);
  assert.equal(table("notifications").has("distribution_completed_request-low-stock_inactive-staff"), false);
  assert.equal([...table("notifications")].filter(([, item]) =>
    item.type === "request_released" && item.recipientUserId === "participant-1" &&
    item.relatedRecordId === "request-low-stock").length, 1);
});

test("release to zero creates one out-of-stock alert cycle and rolls back duplicate release", async () => {
  table("users").set("stock-admin", { role: "admin", status: "active" });
  table("users").set("stock-staff", { role: "staff", status: "active" });
  seedApproved("request-out-stock", "EVT-OUT-STOCK", 10);
  table("seedlingRequests").get("request-out-stock").items[0].quantity = 10;
  const input = { items: [{ inventoryId: "calamansi", releasedQuantity: 10, shortReleaseReason: "" }] };

  await requestService.releaseSeedlingRequest("request-out-stock", "stock-staff", input);
  assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 0);
  assert.equal(table("seedlingInventory").get("calamansi").outOfStockCycle, 1);
  assert.equal(table("notifications").has("out_of_stock_calamansi_1_stock-admin"), true);
  assert.equal(table("notifications").has("out_of_stock_calamansi_1_stock-staff"), true);
  const count = table("notifications").size;
  await assert.rejects(
    requestService.releaseSeedlingRequest("request-out-stock", "stock-staff", input),
    /already been released/
  );
  assert.equal(table("notifications").size, count);
  assert.equal(table("seedlingInventory").get("calamansi").availableQuantity, 0);
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

test("all authenticated participants can use released event distributions with actual item quantities", async () => {
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
  assert.equal(unrelatedRes.result.body.data.some((item) => item.id === "request-multi"), true);
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

test("legacy per-type path: any authenticated participant can submit planting evidence for an eligible activity", async (t) => {
  legacyMode(t);
  const sharp = require("sharp");
  const reportService = require("../src/services/plantingReport.service");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  const eventId = "EVT-AUTH-SCOPE";
  const requestId = "request-auth-scope";
  const reportId = `event_${eventId}`;
  table("users").set("planting-staff", { role: "staff", status: "active" });
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
      reportService.createPlantingReport({ ...payload, barangay: "Calomagon" },
        [{ buffer: image, mimetype: "image/jpeg", originalname: "wrong-barangay.jpg" }]),
      /does not belong to the selected barangay/
    );
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
    assert.equal(submitted.submissions[0].staffReviewStatus, "Pending Review");
    assert.equal(submitted.submissions[0].staffApprovalRequired, true);
    assert.equal(submitted.acceptedQuantity, 0);
    assert.equal(submitted.pendingReviewQuantity, 20);
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
    const contributionId = submitted.submissions[0].id;
    assert.equal(table("notifications").get(
      `planting_report_submitted_${reportId}_${contributionId}_participant-unrelated`,
    ).recipientUserId, "participant-unrelated");
    assert.equal(table("notifications").get(
      `planting_report_submitted_staff_${reportId}_${contributionId}_planting-staff`,
    ).relatedSubrecordId, contributionId);
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
    const notificationCount = table("notifications").size;
    await assert.rejects(reportService.createPlantingReport(payload,
      [{ buffer: image, mimetype: "image/jpeg", originalname: "evidence.jpg" }]));
    assert.equal(table("plantingContributions").size, 1);
    assert.equal(table("notifications").size, notificationCount);
  } finally {
    for (const item of submitted?.submissions || []) {
      for (const photo of item.photos || []) await deletePlantingPhoto(photo.photoPath);
    }
  }
});

test("legacy per-type path: participant planted plus leftover balances reserve once and become accepted only after MENRO review", async (t) => {
  legacyMode(t);
  const service = require("../src/services/plantingReport.service"), sharp = require("sharp");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  const requestId = "request-participant-leftovers", eventId = "event-participant-leftovers";
  seedApproved(requestId, eventId);
  await requestService.releaseSeedlingRequest(requestId, "staff-1", { items: [{ inventoryId: "calamansi", releasedQuantity: 10, shortReleaseReason: "Only ten required" }] });
  Object.assign(table("events").get(eventId), { recordStatus: "scheduled", plantingSiteId: "site-leftovers", barangay: "Bical" });
  table("sites").set("site-leftovers", { status: "active", siteName: "Leftovers site", barangay: "Bical", latitude: 12.57, longitude: 123.965, coverageRadiusMeters: 50 });
  const bytes = await sharp({ create: { width: 7, height: 7, channels: 3, background: "orange" } }).jpeg().withExif({
    IFD0: { Make: "Fixture camera" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1", GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1" },
  }).toBuffer();
  const file = { buffer: bytes, mimetype: "image/jpeg", originalname: "leftovers-evidence.jpg" };
  const payload = { distributionId: requestId, inventoryId: "calamansi", siteId: "site-leftovers", participantId: "participant-1", participantName: "Participant One", participantType: "Volunteer", participantBarangay: "Bical", barangay: "Bical", quantityPlanted: 6, leftoverQuantity: 4, plantingDate: "2026-09-17", plantingLocation: "Leftovers site", eventId };
  let report;
  try {
    for (const leftoverQuantity of [-1, 1.5, Infinity, "1e3"]) await assert.rejects(service.createPlantingReport({ ...payload, leftoverQuantity }, [file]), /whole number/);
    await assert.rejects(service.createPlantingReport({ ...payload, leftoverQuantity: 5 }, [file]), /Only 10/);
    report = await service.createPlantingReport(payload, [file]);
    assert.equal(report.acceptedQuantity, 0); assert.equal(report.pendingReviewQuantity, 6);
    assert.equal(report.pendingReviewLeftoverQuantity, 4); assert.equal(report.remainingAvailableQuantity, 0);
    assert.equal(table("events").get(eventId).recordedSeedlingQuantity, 6);
    assert.equal(table("events").get(eventId).leftoverSeedlingQuantity, 4);
    assert.equal(table("events").get(eventId).remainingSeedlingQuantity, 0);
    assert.equal(report.submissions[0].staffReviewStatus, "Pending Review");
    const approved = await (await service.forwardPlantingReport(report.submissions[0].id, "planting-staff", "Evidence reviewed", "MENRO Staff", "staff"), await service.approvePlantingReport(report.submissions[0].id, "planting-admin", "Confirmed quantities", "MENRO Admin", "admin"));
    assert.equal(approved.acceptedQuantity, 6); assert.equal(approved.acceptedLeftoverQuantity, 4);
    assert.equal(approved.pendingReviewLeftoverQuantity, 0); assert.equal(approved.remainingAvailableQuantity, 0);
  } finally { for (const row of report?.submissions || []) for (const photo of row.photos || []) await deletePlantingPhoto(photo.photoPath); }
});

test("legacy per-type path: participant correction links to the Staff-returned submission and Admin rejection is final", async (t) => {
  legacyMode(t);
  const service = require("../src/services/plantingReport.service"), sharp = require("sharp");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  const requestId = "request-participant-correction", eventId = "event-participant-correction";
  seedApproved(requestId, eventId);
  await requestService.releaseSeedlingRequest(requestId, "staff-1", { items: [{ inventoryId: "calamansi", releasedQuantity: 10, shortReleaseReason: "Only ten required" }] });
  Object.assign(table("events").get(eventId), { recordStatus: "scheduled", plantingSiteId: "site-correction", barangay: "Bical" });
  table("sites").set("site-correction", { status: "active", siteName: "Correction site", barangay: "Bical", latitude: 12.57, longitude: 123.965, coverageRadiusMeters: 50 });
  const photo = async (background, name) => ({ mimetype: "image/jpeg", originalname: name, buffer: await sharp({ create: { width: 9, height: 9, channels: 3, background } }).jpeg().withExif({
    IFD0: { Make: "Fixture camera" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1", GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1" },
  }).toBuffer() });
  const payload = { distributionId: requestId, inventoryId: "calamansi", siteId: "site-correction", participantId: "participant-1", participantName: "Participant One", participantType: "Volunteer", participantBarangay: "Bical", barangay: "Bical", quantityPlanted: 6, leftoverQuantity: 0, plantingDate: "2026-09-17", plantingLocation: "Correction site", eventId };
  const reports = [];
  try {
    const first = await service.createPlantingReport(payload, [await photo("navy", "first.jpg")]);
    reports.push(first);
    const original = first.submissions[0];
    assert.equal(original.workflowStatus, "Pending Review");
    await assert.rejects(service.returnPlantingReport(original.id, "planting-staff", "", "MENRO Staff", "staff"), (error) => error.status === 400);
    const returned = await service.returnPlantingReport(original.id, "planting-staff", "Retake the photo inside the site", "MENRO Staff", "staff");
    const returnedRow = returned.submissions.find((entry) => entry.id === original.id);
    assert.equal(returnedRow.workflowStatus, "Returned for Correction");
    assert.equal(returnedRow.correctionAllowed, true);
    assert.equal(returnedRow.returnReason, "Retake the photo inside the site");
    assert.equal(returned.remainingAvailableQuantity, 10, "a returned submission releases its quantity");
    assert.equal(returned.returnedQuantity, 6);
    assert.equal(returned.rejectedQuantity, 0, "returns are not counted as rejections");
    assert.equal(table("events").get(eventId).recordedSeedlingQuantity, 0);

    await assert.rejects(service.createPlantingReport({ ...payload, participantId: "participant-2", correctionOf: original.id }, [await photo("olive", "other.jpg")]), (error) => error.status === 409);
    const corrected = await service.createPlantingReport({ ...payload, correctionOf: original.id }, [await photo("maroon", "corrected.jpg")]);
    reports.push(corrected);
    const resubmitted = corrected.submissions.find((entry) => entry.correctionOf === original.id);
    assert.ok(resubmitted, "the corrected submission links to the returned one");
    assert.equal(resubmitted.revision, 1);
    assert.equal(resubmitted.workflowStatus, "Pending Review");
    assert.equal(table("plantingContributions").get(original.id).correctedBySubmission, resubmitted.id);
    assert.equal(corrected.submissions.find((entry) => entry.id === original.id).correctionAllowed, false);
    // Within the remaining balance, a second correction of the same return is still refused.
    await assert.rejects(service.createPlantingReport({ ...payload, quantityPlanted: 4, correctionOf: original.id }, [await photo("teal", "again.jpg")]), (error) => error.status === 409);
    const logs = [...table("verificationLogs").values()].filter((log) => log.plantingReportId === corrected.id);
    assert.deepEqual(logs.map((log) => log.action), ["Staff Return for Correction", "Participant Resubmission"]);
    assert.equal(logs[0].submissionId, original.id);

    await service.forwardPlantingReport(resubmitted.id, "planting-staff", "", "MENRO Staff", "staff");
    const rejected = await service.rejectPlantingReport(resubmitted.id, "planting-admin", "Seedlings were planted outside the approved site", "MENRO Admin", "admin");
    const rejectedRow = rejected.submissions.find((entry) => entry.id === resubmitted.id);
    assert.equal(rejectedRow.workflowStatus, "Rejected");
    assert.equal(rejectedRow.correctionAllowed, false);
    assert.equal(rejected.rejectedQuantity, 6);
    assert.equal(rejected.cohortId, undefined);
    await assert.rejects(service.createPlantingReport({ ...payload, correctionOf: resubmitted.id }, [await photo("purple", "after-reject.jpg")]), (error) => error.status === 409, "an Admin rejection cannot be corrected");
  } finally {
    for (const report of reports) for (const row of report.submissions || []) for (const item of row.photos || []) await deletePlantingPhoto(item.photoPath);
  }
});

test("legacy per-type path: final planting confirmation covers exactly 100 released = 80 planted + 20 final leftovers", async t => {
  legacyMode(t);
  const service = require("../src/services/plantingReport.service"), sharp = require("sharp");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  const requestId = "request-final-confirmation", eventId = "event-final-confirmation";
  seedApproved(requestId, eventId);
  await requestService.releaseSeedlingRequest(requestId, "staff-1", { items: [{ inventoryId: "calamansi", releasedQuantity: 100, shortReleaseReason: "Only ten required" }] });
  Object.assign(table("events").get(eventId), { recordStatus: "scheduled", plantingSiteId: "site-final-confirmation", barangay: "Bical" });
  table("sites").set("site-final-confirmation", { status: "active", siteName: "Leftovers site", barangay: "Bical", latitude: 12.57, longitude: 123.965, coverageRadiusMeters: 50 });
  const bytes = await sharp({ create: { width: 9, height: 9, channels: 3, background: "purple" } }).jpeg().withExif({
    IFD0: { Make: "Fixture camera" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1", GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1" },
  }).toBuffer();
  const file = { buffer: bytes, mimetype: "image/jpeg", originalname: "leftovers-evidence.jpg" };
  const payload = { distributionId: requestId, inventoryId: "calamansi", siteId: "site-final-confirmation", participantId: "participant-1", participantName: "Participant One", participantType: "Volunteer", participantBarangay: "Bical", barangay: "Bical", quantityPlanted: 80, leftoverQuantity: 20, confirmationMode: "final", plantingDate: "2026-09-17", plantingLocation: "Leftovers site", eventId };
  let report;
  try {
    for (const leftoverQuantity of [-1, 1.5, Infinity, "1e3"]) await assert.rejects(service.createPlantingReport({ ...payload, leftoverQuantity }, [file]), /whole number/);
    await assert.rejects(service.createPlantingReport({ ...payload, leftoverQuantity: 19 }, [file]), /final confirmation must cover/);
    report = await service.createPlantingReport(payload, [file]);
    assert.equal(report.acceptedQuantity, 0); assert.equal(report.pendingReviewQuantity, 80);
    assert.equal(report.pendingReviewLeftoverQuantity, 20); assert.equal(report.remainingAvailableQuantity, 0);
    assert.equal(table("events").get(eventId).recordedSeedlingQuantity, 80);
    assert.equal(table("events").get(eventId).leftoverSeedlingQuantity, 20);
    assert.equal(table("events").get(eventId).remainingSeedlingQuantity, 0);
    assert.equal(report.submissions[0].staffReviewStatus, "Pending Review");
    const priorGate = process.env.VERIFIED_PLANTING_COHORT_ENABLED;
    process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true";
    t.after(() => { if (priorGate === undefined) delete process.env.VERIFIED_PLANTING_COHORT_ENABLED; else process.env.VERIFIED_PLANTING_COHORT_ENABLED = priorGate; });
    const runTransaction = db.runTransaction.bind(db);
    t.mock.method(db, "runTransaction", handler => runTransaction(transaction => {
      let wrote = false;
      const get = transaction.get.bind(transaction);
      transaction.get = ref => { assert.equal(wrote, false, "Firestore requires all cohort reads before approval writes"); return get(ref); };
      for (const method of ["create", "set", "update"]) { const write = transaction[method].bind(transaction); transaction[method] = (...args) => { wrote = true; return write(...args); }; }
      return handler(transaction);
    }));
    const approved = await (await service.forwardPlantingReport(report.submissions[0].id, "planting-staff", "Evidence reviewed", "MENRO Staff", "staff"), await service.approvePlantingReport(report.submissions[0].id, "planting-admin", "Confirmed quantities", "MENRO Admin", "admin"));
    assert.equal(approved.acceptedQuantity, 80); assert.equal(approved.acceptedLeftoverQuantity, 20);
    assert.equal(approved.pendingReviewLeftoverQuantity, 0); assert.equal(approved.remainingAvailableQuantity, 0);
  } finally { for (const row of report?.submissions || []) for (const photo of row.photos || []) await deletePlantingPhoto(photo.photoPath); }
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
    submittedByName: "Test Participant", submittedBySector: "Volunteer",
    submittedByContactNumber: "09171234567",
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

test("legacy per-type path: valid EXIF GPS outside the assigned site is preserved, flagged, and submitted", async (t) => {
  legacyMode(t);
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
    table("users").set("flag-review-staff", { role: "staff", status: "active" });
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
    const contributionId = submitted.submissions[0].id;
    const flaggedNotification = table("notifications").get(
      `planting_evidence_flagged_event_EVT-VALID-OUTSIDE_${contributionId}_flag-review-staff`,
    );
    assert.equal(flaggedNotification.recipientUserId, "flag-review-staff");
    assert.ok(flaggedNotification.details.suspiciousFlags.includes("OUTSIDE_REGISTERED_SITE"));
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

test("participant monitoring returns owned and reported records and accepts an empty history", async () => {
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
  table("monitoringRecords").set("reported-1", {
    participantId: "participant-2", plantingReportId: "shared-report",
    history: [{ id: "OBS-SHARED", originalReporterId: "participant-1", monitoredBy: "participant-1" }],
  });
  const historicalBefore = JSON.parse(JSON.stringify(table("monitoringRecords").get("reported-1")));
  const own = response();
  await controller.getMyMonitoringRecords({ user: { uid: "participant-1" } }, own);
  assert.equal(own.result.code, 200);
  assert.deepEqual(new Set(own.result.body.data.map((item) => item.id)), new Set(["legacy-own-1", "reported-1"]));
  assert.equal(own.result.body.data.some((item) => item.history.some((entry) => entry.id === "OBS-SHARED")), true);
  assert.deepEqual(table("monitoringRecords").get("reported-1"), historicalBefore,
    "Participant history reads must not rewrite statuses, evidence, or audit data.");
});

test("Participant cannot reach legacy monitoring submit or resubmit routes", () => {
  const routes = require("../src/routes/monitoring.routes");
  const authorize = (path, method, role) => {
    const layer = routes.stack.find(item => item.route?.path === path && item.route.methods[method]);
    assert.ok(layer);
    let status = null, advanced = false;
    layer.route.stack[1].handle({ user: { uid: `${role}-1`, role } }, {
      status(code) { status = code; return this; }, json() { return this; },
    }, () => { advanced = true; });
    return { status, advanced };
  };
  for (const [path, method] of [["/", "post"], ["/early", "post"],
    ["/:monitoringId/observations/:observationId/resubmit", "patch"]]) {
    assert.equal(authorize(path, method, "participant").status, 403);
    assert.equal(authorize(path, method, "staff").advanced, true);
  }
});

test("invitation is scoped to owner and guest contact to event; historical guest contributions keep their data path", async () => {
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
  // New guest contributions are retired (decision C6): the route refuses and reserves nothing.
  const retiredResult = await invokeGuestContribution(
    { authorization: `Guest ${joined.sessionToken}` },
    { inventoryId: "calamansi", quantity: 85, submissionKey: "submission_key_123" }
  );
  assert.equal(retiredResult.code, 410);
  assert.match(retiredResult.body.message, /replaced by attendance registration/);
  assert.equal(table("events").get("EVT-GUEST-SCOPE").pendingSeedlingQuantity || 0, 0, "a retired route reserves nothing");
  // Historical guest contributions (created before retirement) keep their data path.
  const first = await contributionService.recordContribution("EVT-GUEST-SCOPE", joined.participantId, "calamansi", 85, "submission_key_123");
  assert.equal(first.quantity, 85);
  assert.equal(first.participantId, joined.participantId);
  assert.equal(first.eventId, "EVT-GUEST-SCOPE");
  const duplicate = await contributionService.recordContribution("EVT-GUEST-SCOPE", joined.participantId, "calamansi", 85, "submission_key_123");
  assert.equal(duplicate.id, first.id);
  await assert.rejects(guestService.validateGuestSession("Guest invalid"), /Invalid guest session/);
  const expiredGuest = await guestService.joinGuest(token, {
    fullName: "Expired Guest", contactNumber: "09987654321",
  });
  table("eventParticipants").get(expiredGuest.participantId).expiresAt = new Date(0);
  await assert.rejects(guestService.validateGuestSession(`Guest ${expiredGuest.sessionToken}`), /expired/i);
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
  await assert.rejects(contributionService.recordContribution("EVT-GUEST-SCOPE", joined.participantId, "calamansi", 10, "excess_quantity_key"),
    /Only 5 seedlings remain available/);
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
  const reservationResults = await Promise.allSettled([
    contributionService.recordContribution(eventId, "guest-concurrent-a", "narra", 10, "concurrent_key_a"),
    contributionService.recordContribution(eventId, "guest-concurrent-b", "narra", 10, "concurrent_key_b"),
  ]);
  assert.equal(reservationResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(reservationResults.filter((result) => result.status === "rejected").length, 1);
  const first = reservationResults.find((result) => result.status === "fulfilled").value;
  const successfulGuestId = first.participantId;
  const makeImage = (background, model) => sharp({
    create: { width: 5, height: 5, channels: 3, background },
  }).jpeg().withExif({
    IFD0: { Make: "Test Camera", Model: model },
    IFD3: {
      GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1",
      GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1",
    },
  }).toBuffer();
  const firstImage = await makeImage("red", "Concurrent A");
  await attachEvidence(eventId, successfulGuestId, first.id,
    [{ buffer: firstImage, mimetype: "image/jpeg", originalname: "concurrent-a.jpg" }]);
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
  const reviewed = await (await plantingReportService.forwardPlantingReport(one.id, "staff-1", "", "MENRO Staff", "staff"), await plantingReportService.approvePlantingReport(one.id, "admin-1", "", "MENRO Admin", "admin"));
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
    participantId: "participant-search", plantingReportId: "search-own-report", monitoringNumber: "MON-2026-901",
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
  assert.match(participantResults.find((item) => item.id === "search-own-monitoring").path,
    /my-planting-reports\?report=search-own-report/);

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


test("legacy per-type path: partial 60 then final 30 plus 10 leftovers preserves a 40 future balance and confirms only 90 planted", async (t) => {
  legacyMode(t);
  const service = require("../src/services/plantingReport.service"), sharp = require("sharp");
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  const requestId = "request-partial-then-final", eventId = "event-partial-then-final", siteId = "site-partial-then-final";
  seedApproved(requestId, eventId);
  await requestService.releaseSeedlingRequest(requestId, "staff-1", { items: [{ inventoryId: "calamansi", releasedQuantity: 100 }] });
  Object.assign(table("events").get(eventId), { recordStatus: "scheduled", plantingSiteId: siteId, barangay: "Bical" });
  table("sites").set(siteId, { status: "active", siteName: "Partial fixture", barangay: "Bical", latitude: 12.57, longitude: 123.965, coverageRadiusMeters: 50 });
  const body = { distributionId: requestId, inventoryId: "calamansi", siteId, participantId: "participant-1", participantName: "Participant One", participantType: "Volunteer", participantBarangay: "Bical", barangay: "Bical", plantingDate: "2026-09-17", plantingLocation: "Partial fixture", eventId };
  let report;
  try {
    for (const [index, quantity, leftover, mode] of [[0, 60, 0, "partial"], [1, 30, 10, "final"]]) {
      const buffer = await sharp({ create: { width: 11 + index, height: 11 + index, channels: 3, background: index ? "teal" : "pink" } }).jpeg().withExif({
        IFD0: { Make: "Fixture camera" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1", GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1" },
      }).toBuffer();
      const file = { buffer, mimetype: "image/jpeg", originalname: `partial-final-${index}.jpg` };
      report = await service.createPlantingReport({ ...body, quantityPlanted: quantity, leftoverQuantity: leftover, confirmationMode: mode }, [file]);
      const submission = report.submissions.at(-1);
      report = await (await service.forwardPlantingReport(submission.id, "planting-staff", "Evidence reviewed", "MENRO Staff", "staff"), await service.approvePlantingReport(submission.id, "planting-admin", "Confirmed quantities", "MENRO Admin", "admin"));
      if (!index) { assert.equal(report.remainingAvailableQuantity, 40); assert.equal(report.acceptedLeftoverQuantity || 0, 0); }
      else { assert.equal(report.remainingAvailableQuantity, 0); assert.equal(report.acceptedQuantity, 90); assert.equal(report.acceptedLeftoverQuantity, 10); }
      await assert.rejects(service.createPlantingReport({ ...body, quantityPlanted: quantity, leftoverQuantity: leftover, confirmationMode: mode }, [file]));
    }
    assert.equal(report.submissions.length, 2); assert.equal(table("events").get(eventId).recordedSeedlingQuantity, 90);
  } finally { for (const row of report?.submissions || []) for (const photo of row.photos || []) await deletePlantingPhoto(photo.photoPath); }
});

test("new policy reports never synthesize requester aggregate monitoring assignments or accept legacy submissions", async () => {
  const service = require("../src/services/monitoring.service");
  table("plantingReports").set("policy-only-report", { participantId: "new-policy-owner", reportingProgress: "Completed", quantityPlanted: 80, siteId: "policy-site", plantingDate: "2026-10-01", reportingPolicy: { monitoring: "PERMANENT_SAMPLE", requesterMonitoringTasks: false } });
  const rows = await service.getMonitoringRecordsByParticipantId("new-policy-owner");
  assert.equal(rows.some(row => row.plantingReportId === "policy-only-report"), false);
  await assert.rejects(service.createMonitoringRecord({ plantingReportId: "policy-only-report", actorRole: "staff" }), error => error.code === "PURPOSE_POLICY_MONITORING_WORKFLOW");
});

// --------------------------------------------------------------------------
// One final Planting Report per event (submissionWorkflowVersion 4)
// --------------------------------------------------------------------------
async function finalReportFixture(name, { narra = 40 } = {}) {
  const sharp = require("sharp");
  const requestId = `request-${name}`, eventId = `event-${name}`, siteId = `site-${name}`;
  seedApproved(requestId, eventId);
  table("seedlingRequests").get(requestId).items.push({ inventoryId: "narra", species: "Narra", quantity: narra });
  table("seedlingInventory").set("narra", { species: "Narra", availableQuantity: 500, reservedQuantity: 0, distributedQuantity: 0, lowStockThreshold: 5 });
  await requestService.releaseSeedlingRequest(requestId, "staff-1", { items: [
    { inventoryId: "calamansi", releasedQuantity: 100 }, { inventoryId: "narra", releasedQuantity: narra }] });
  Object.assign(table("events").get(eventId), { recordStatus: "scheduled", plantingSiteId: siteId, barangay: "Bical" });
  table("sites").set(siteId, { status: "active", siteName: "Final report site", barangay: "Bical", latitude: 12.57, longitude: 123.965, coverageRadiusMeters: 50 });
  // Unique pixels per fixture photo, so the duplicate-image guard never trips across tests.
  const photo = async (_tone, originalname) => {
    const seed = require("node:crypto").createHash("sha256").update(`${name}:${originalname}`).digest();
    const background = { r: seed[0], g: seed[1], b: seed[2] };
    return { originalname, mimetype: "image/jpeg", buffer: await sharp({ create: { width: 9, height: 9, channels: 3, background } }).jpeg().withExif({
      IFD0: { Make: "Fixture camera" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 34/1 12/1", GPSLongitudeRef: "E", GPSLongitude: "123/1 57/1 54/1" },
    }).toBuffer() };
  };
  const payload = { distributionId: requestId, siteId, participantId: "participant-1", participantName: "Participant One", participantType: "Volunteer",
    participantBarangay: "Bical", barangay: "Bical", plantingDate: "2026-09-17", plantingLocation: "Final report site", eventId,
    submittedByName: "Participant One", submittedBySector: "Volunteer", submittedByContactNumber: "09123456789" };
  return { requestId, eventId, reportId: `event_${eventId}`, photo, payload };
}

async function cleanupPhotos(report) {
  const { deletePlantingPhoto } = require("../src/services/fileStorage.service");
  for (const row of report?.submissions || []) for (const entry of row.photos || []) await deletePlantingPhoto(entry.photoPath);
}

test("one final Participant report covers every released type; Staff and Admin decide it once, leftovers included", async t => {
  const service = require("../src/services/plantingReport.service");
  const fixture = await finalReportFixture("final-v4");
  const items = [{ inventoryId: "calamansi", leftoverQuantity: 20, leftoverReason: "Seedlings wilted before planting" }, { inventoryId: "narra", leftoverQuantity: 0 }];
  let report;
  try {
    // Every released type with a balance is required; a single-type submission is refused.
    await assert.rejects(service.createPlantingReport({ ...fixture.payload, inventoryId: "calamansi", quantityPlanted: 80, leftoverQuantity: 20, confirmationMode: "final" },
      [await fixture.photo("purple", "single.jpg")]), (error) => error.status === 409 && /every released seedling type/.test(error.message));
    await assert.rejects(service.createPlantingReport({ ...fixture.payload, items: [items[0]] }, [await fixture.photo("purple", "missing.jpg")]),
      (error) => error.status === 409 && /every released seedling type/.test(error.message));
    await assert.rejects(service.createPlantingReport({ ...fixture.payload, items: [{ inventoryId: "calamansi", leftoverQuantity: 20 }, items[1]] },
      [await fixture.photo("purple", "no-reason.jpg")]), (error) => error.status === 400 && /reason/.test(error.message));
    await assert.rejects(service.createPlantingReport({ ...fixture.payload, items: [items[0], { inventoryId: "narra", leftoverQuantity: 41, leftoverReason: "x" }] },
      [await fixture.photo("purple", "too-many.jpg")]), (error) => error.status === 409 && /cannot exceed/.test(error.message));
    assert.equal(table("events").get(fixture.eventId).recordedSeedlingQuantity || 0, 0, "refused reports change no balance");

    // Client planted values are ignored: Planted = Remaining - Leftovers per type.
    report = await service.createPlantingReport({ ...fixture.payload, items: JSON.stringify(items.map((item) => ({ ...item, quantityPlanted: 999 }))) },
      [await fixture.photo("purple", "final.jpg")]);
    const rows = report.submissions;
    assert.deepEqual(rows.map((row) => [row.inventoryId, row.quantity, row.leftoverQuantity, row.leftoverReason]),
      [["calamansi", 80, 20, "Seedlings wilted before planting"], ["narra", 40, 0, ""]]);
    assert.ok(rows.every((row) => row.finalReportId === `FPR-${fixture.eventId}` && row.finalReportGroupId === rows[0].id && row.submissionWorkflowVersion === 4));
    assert.equal(rows[0].photos.length, 1); assert.equal(rows[1].photos.length, 0, "one evidence set for the whole report");
    assert.equal(report.photos.length, 1);
    assert.equal(report.pendingReviewQuantity, 120); assert.equal(report.declaredLeftoverQuantity, 20); assert.equal(report.remainingAvailableQuantity, 0);
    assert.equal(report.submissionStatus, "Submitted"); assert.equal(report.reviewStatus, "Pending Review");
    assert.deepEqual(table("events").get(fixture.eventId).recordedSeedlingsByInventory, { calamansi: 80, narra: 40 });
    assert.deepEqual(table("events").get(fixture.eventId).leftoverSeedlingsByInventory, { calamansi: 20, narra: 0 });

    // A second independent final report for the event is refused.
    await assert.rejects(service.createPlantingReport({ ...fixture.payload, items }, [await fixture.photo("teal", "duplicate.jpg")]), (error) => error.status === 409);

    const priorGate = process.env.VERIFIED_PLANTING_COHORT_ENABLED;
    process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true";
    t.after(() => { if (priorGate === undefined) delete process.env.VERIFIED_PLANTING_COHORT_ENABLED; else process.env.VERIFIED_PLANTING_COHORT_ENABLED = priorGate; });
    const runTransaction = db.runTransaction.bind(db);
    t.mock.method(db, "runTransaction", (handler) => runTransaction((transaction) => {
      let wrote = false;
      const get = transaction.get.bind(transaction);
      transaction.get = (ref) => { assert.equal(wrote, false, "Firestore requires all reads before writes"); return get(ref); };
      for (const method of ["create", "set", "update"]) { const write = transaction[method].bind(transaction); transaction[method] = (...args) => { wrote = true; return write(...args); }; }
      return handler(transaction);
    }));
    // Deciding via any row decides the whole report.
    const reviewed = await service.forwardPlantingReport(rows[1].id, "planting-staff", "Evidence reviewed", "MENRO Staff", "staff");
    assert.deepEqual(reviewed.submissions.map((row) => row.workflowStatus), ["Reviewed", "Reviewed"]);
    assert.equal(reviewed.reportingProgress, "Fully Reported — Awaiting Review", "Staff review never completes a report");
    await assert.rejects(service.approvePlantingReport(rows[0].id, "planting-staff", "", "MENRO Staff", "staff"), (error) => error.status === 403);
    const approved = await service.approvePlantingReport(rows[0].id, "planting-admin", "Confirmed", "MENRO Admin", "admin");
    assert.deepEqual(approved.submissions.map((row) => row.workflowStatus), ["Completed", "Completed"]);
    assert.equal(approved.acceptedQuantity, 120); assert.equal(approved.acceptedLeftoverQuantity, 20);
    assert.equal(approved.reportingProgress, "Completed", "Admin approval completes the final report even with leftovers");
    assert.equal(approved.reviewStatus, "Completed");
    const cohort = table("verifiedPlantingCohorts").get(`VPC-${fixture.reportId}`) ||
      [...table("verifiedPlantingCohorts").values()].find((entry) => entry.source?.plantingReportId === fixture.reportId);
    assert.ok(cohort, "monitoring eligibility starts only at Admin approval");
    assert.equal(cohort.verifiedPlantedQuantity, 120);
    const logs = [...table("verificationLogs").values()].filter((log) => log.plantingReportId === fixture.reportId && log.action === "Admin Approval");
    assert.equal(logs.length, 1); assert.deepEqual(logs[0].submissionIds, rows.map((row) => row.id));
    await assert.rejects(service.approvePlantingReport(rows[1].id, "planting-admin", "", "MENRO Admin", "admin"), (error) => error.status === 409);
  } finally { await cleanupPhotos(report); }
});

test("a returned final report is corrected as the next revision of the same logical report; a rejection allows another revision", async () => {
  const service = require("../src/services/plantingReport.service");
  const fixture = await finalReportFixture("final-v4-correction", { narra: 10 });
  const items = [{ inventoryId: "calamansi", leftoverQuantity: 0 }, { inventoryId: "narra", leftoverQuantity: 0 }];
  const reports = [];
  try {
    const first = await service.createPlantingReport({ ...fixture.payload, items }, [await fixture.photo("navy", "first.jpg")]); reports.push(first);
    const [a, b] = first.submissions.map((row) => row.id);
    await service.returnPlantingReport(b, "planting-staff", "Narra count does not match the photos", "MENRO Staff", "staff");
    assert.deepEqual([a, b].map((id) => table("plantingContributions").get(id).workflowStatus), ["Returned for Correction", "Returned for Correction"]);
    assert.deepEqual(table("events").get(fixture.eventId).recordedSeedlingsByInventory, { calamansi: 0, narra: 0 }, "a return releases every type");
    await assert.rejects(service.createPlantingReport({ ...fixture.payload, participantId: "participant-2", items, correctionOf: a }, [await fixture.photo("olive", "other.jpg")]),
      (error) => error.status === 409, "only the original submitter corrects it");
    const corrected = await service.createPlantingReport({ ...fixture.payload, items: [items[0], { inventoryId: "narra", leftoverQuantity: 2, leftoverReason: "Two seedlings were damaged" }], correctionOf: a },
      [await fixture.photo("maroon", "corrected.jpg")]); reports.push(corrected);
    const latest = corrected.submissions.filter((row) => !row.correctedBySubmission);
    assert.deepEqual(latest.map((row) => [row.inventoryId, row.quantity, row.correctionOf, row.finalReportRevision]), [["calamansi", 100, a, 1], ["narra", 8, b, 1]]);
    assert.ok([a, b].every((id) => table("plantingContributions").get(id).correctedBySubmission === latest[0].id), "history is kept, linked to the correction");
    assert.equal(corrected.id, first.id, "the same planting report ID");
    assert.equal(latest[0].finalReportId, `FPR-${fixture.eventId}`);
    // Staff forward, then Admin rejection (final for that revision)...
    await service.forwardPlantingReport(latest[0].id, "planting-staff", "", "MENRO Staff", "staff");
    await service.rejectPlantingReport(latest[1].id, "planting-admin", "Wrong planting site recorded", "MENRO Admin", "admin");
    assert.deepEqual(latest.map((row) => table("plantingContributions").get(row.id).workflowStatus), ["Rejected", "Rejected"]);
    await assert.rejects(service.createPlantingReport({ ...fixture.payload, items, correctionOf: latest[0].id }, [await fixture.photo("purple", "after-reject.jpg")]),
      (error) => error.status === 409, "a rejection is not correctable");
    // ...but a new revision of the same logical report may be submitted.
    const resubmitted = await service.createPlantingReport({ ...fixture.payload, items }, [await fixture.photo("teal", "revision-2.jpg")]); reports.push(resubmitted);
    const revision2 = resubmitted.submissions.filter((row) => row.finalReportRevision === 2);
    assert.equal(revision2.length, 2); assert.equal(revision2[0].finalReportId, `FPR-${fixture.eventId}`);
    assert.equal(resubmitted.submissions.filter((row) => row.workflowStatus === "Rejected").length, 2, "rejection history is preserved");
    assert.equal(resubmitted.reviewStatus, "Pending Review");
  } finally { for (const report of reports) await cleanupPhotos(report); }
});

test("a legacy partial report keeps its history; the final report covers only the remaining unreported balance", async (t) => {
  const service = require("../src/services/plantingReport.service");
  const fixture = await finalReportFixture("final-v4-legacy", { narra: 10 });
  const reports = [];
  try {
    // Historical record: one per-type submission (legacy path), approved.
    process.env.PLANTING_FINAL_REPORT_ENFORCED = "false";
    t.after(() => { delete process.env.PLANTING_FINAL_REPORT_ENFORCED; });
    const legacy = await service.createPlantingReport({ ...fixture.payload, inventoryId: "calamansi", quantityPlanted: 60, confirmationMode: "partial" },
      [await fixture.photo("navy", "legacy.jpg")]); reports.push(legacy);
    await service.forwardPlantingReport(legacy.submissions[0].id, "planting-staff", "", "MENRO Staff", "staff");
    const legacyApproved = await service.approvePlantingReport(legacy.submissions[0].id, "planting-admin", "", "MENRO Admin", "admin");
    assert.equal(legacyApproved.reviewStatus, "Awaiting Remaining Report");
    delete process.env.PLANTING_FINAL_REPORT_ENFORCED;

    const final = await service.createPlantingReport({ ...fixture.payload, items: [
      { inventoryId: "calamansi", leftoverQuantity: 5, leftoverReason: "Spare seedlings kept by the barangay" }, { inventoryId: "narra", leftoverQuantity: 0 }] },
    [await fixture.photo("olive", "final.jpg")]); reports.push(final);
    const finalRows = final.submissions.filter((row) => row.finalReportGroupId);
    assert.deepEqual(finalRows.map((row) => [row.inventoryId, row.quantity, row.leftoverQuantity]), [["calamansi", 35, 5], ["narra", 10, 0]],
      "Planted = remaining unreported balance - leftovers");
    assert.equal(table("plantingContributions").get(legacy.submissions[0].id).workflowStatus, "Completed", "the legacy record is unchanged");
    await service.forwardPlantingReport(finalRows[0].id, "planting-staff", "", "MENRO Staff", "staff");
    const done = await service.approvePlantingReport(finalRows[0].id, "planting-admin", "", "MENRO Admin", "admin");
    assert.equal(done.acceptedQuantity, 105); assert.equal(done.acceptedLeftoverQuantity, 5);
    assert.equal(done.reportingProgress, "Completed"); assert.equal(done.reviewStatus, "Completed");
  } finally { for (const report of reports) await cleanupPhotos(report); }
});

// --------------------------------------------------------------------------
// Phase 4: guest event attendance only + legacy reservation release
// --------------------------------------------------------------------------
async function attendanceFixture(name, eventOverrides = {}) {
  const requestId = `request-${name}`, eventId = `EVT-${name}`;
  table("seedlingRequests").set(requestId, { participantId: "requester-attend", eventId, status: "Released", participantName: "Requester" });
  table("events").set(eventId, { sourceRequestId: requestId, status: "Completed", name: "Attendance planting", date: "2026-09-29", startTime: "08:00",
    allocationReleasedAt: new Date(), seedlingItems: [{ inventoryId: "calamansi", species: "Calamansi", quantity: 40 }], seedlingTotalQuantity: 40,
    plantingSiteId: "site-attend", barangay: "Bical", ...eventOverrides });
  table("sites").set("site-attend", { status: "active", siteName: "Attendance Site", barangay: "Bical", latitude: 12.57, longitude: 123.965 });
  await db.runTransaction(async (transaction) => { guestService.createInvitationInTransaction(transaction, eventId, requestId, new Date()); });
  const { token } = await guestService.getInvitationForRequester(eventId, "requester-attend");
  return { requestId, eventId, token };
}
const guestRoute = (path, method) => {
  const layer = guestRoutes.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  assert.ok(layer, `${method} ${path} exists`);
  return layer.route.stack.at(-1).handle;
};
const snapshotLedgers = (eventId) => JSON.stringify({ event: table("events").get(eventId),
  contributions: [...table("plantingContributions").values()].filter((row) => row.eventId === eventId),
  reports: [...table("plantingReports").entries()].filter(([id]) => id === `event_${eventId}`),
  participants: [...table("eventParticipants").values()].filter((row) => row.eventId === eventId) });

test("guest attendance records only Full Name, Contact Number and Address, once per contact, during or after the event", async () => {
  const { eventId, token } = await attendanceFixture("ATTEND");
  const before = snapshotLedgers(eventId);
  // The public card is attendance-only: no allocation or balances.
  const card = await guestService.attendanceEventView(eventId, table("events").get(eventId));
  assert.equal(card.attendanceOpen, true, "completed events still accept attendance while the link is valid");
  assert.equal("allocation" in card, false);

  const saved = await guestService.registerAttendance(token, { fullName: "  Maria   Santos ", contactNumber: "0912 345 6789", address: "Purok 3, Barangay Bical, Bulan" });
  assert.equal(saved.fullName, "Maria Santos");
  const rows = [...table("eventAttendance").values()].filter((row) => row.eventId === eventId);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["address", "contactNumber", "createdAt", "eventId", "fullName", "registeredAt", "requestId", "source"]);
  assert.deepEqual([rows[0].fullName, rows[0].contactNumber, rows[0].address], ["Maria Santos", "09123456789", "Purok 3, Barangay Bical, Bulan"]);
  assert.ok([...table("eventAttendance").keys()].every((id) => !id.includes("09123456789")), "record IDs never contain the contact number");

  await assert.rejects(guestService.registerAttendance(token, { fullName: "Maria S.", contactNumber: "+639123456789", address: "Another address 1" }),
    (error) => error.status === 409, "one attendance per event and contact");
  for (const [details, field] of [
    [{ fullName: "A", contactNumber: "09170000001", address: "Purok 1, Bical" }, "fullName"],
    [{ fullName: "Juan Cruz", contactNumber: "12345", address: "Purok 1, Bical" }, "contactNumber"],
    [{ fullName: "Juan Cruz", contactNumber: "09170000001", address: "" }, "address"],
    [{ fullName: "Juan Cruz", contactNumber: "09170000001", address: "x".repeat(201) }, "address"],
    [{ fullName: "Juan\u0000Cruz", contactNumber: "09170000001", address: "Purok 1, Bical" }, "fullName"],
  ]) await assert.rejects(guestService.registerAttendance(token, details), (error) => error.status === 400 && Boolean(error.fieldErrors?.[field]), field);
  // Planting fields are not accepted at all.
  for (const extra of [{ inventoryId: "calamansi" }, { quantity: 5 }, { photos: [] }]) {
    await assert.rejects(guestService.registerAttendance(token, { fullName: "Juan Cruz", contactNumber: "09170000001", address: "Purok 1, Bical", ...extra }), (error) => error.status === 400);
  }
  assert.equal(snapshotLedgers(eventId), before, "attendance never touches balances, reservations, contributions, reports or guest sessions");

  // Route: 201 with no personal data echoed beyond the name.
  const res = routeResponse();
  await guestRoute("/:token/attendance", "post")({ params: { token }, body: { fullName: "Pedro Reyes", contactNumber: "09181234567", address: "Zone 2, Bical" } }, res);
  assert.equal(res.result.code, 201);
  assert.deepEqual(Object.keys(res.result.body.data).sort(), ["eventId", "fullName", "registeredAt"]);
});

test("attendance links: not before the event starts; refused when revoked, expired, tampered or the event is cancelled", async () => {
  const future = await attendanceFixture("ATTEND-FUTURE", { date: "2099-01-01", status: "Upcoming" });
  const futureCard = await guestService.attendanceEventView(future.eventId, table("events").get(future.eventId));
  assert.equal(futureCard.attendanceOpen, false); assert.ok(futureCard.attendanceOpensAt);
  await assert.rejects(guestService.registerAttendance(future.token, { fullName: "Early Guest", contactNumber: "09170000002", address: "Purok 1, Bical" }),
    (error) => error.status === 409 && /opens when the planting event starts/.test(error.message));

  const cancelled = await attendanceFixture("ATTEND-CANCELLED", { status: "Cancelled" });
  await assert.rejects(guestService.validateAttendanceInvitation(cancelled.token), (error) => error.status === 410);
  const expired = await attendanceFixture("ATTEND-EXPIRED");
  table("eventInvitations").get(expired.eventId).expiresAt = new Date(0);
  await assert.rejects(guestService.validateAttendanceInvitation(expired.token), (error) => error.status === 410 && /expired/.test(error.message));
  const revoked = await attendanceFixture("ATTEND-REVOKED");
  table("eventInvitations").get(revoked.eventId).revokedAt = new Date();
  await assert.rejects(guestService.validateAttendanceInvitation(revoked.token), (error) => error.status === 404);
  const valid = await attendanceFixture("ATTEND-TAMPER");
  const tampered = `${valid.eventId}.${"0".repeat(64)}.${"0".repeat(64)}`;
  await assert.rejects(guestService.validateAttendanceInvitation(tampered), (error) => error.status === 404);
  // Another event's token cannot register attendance for this event.
  const otherToken = (await attendanceFixture("ATTEND-OTHER")).token;
  const forged = `${valid.eventId}.${otherToken.split(".").slice(1).join(".")}`;
  await assert.rejects(guestService.validateAttendanceInvitation(forged), (error) => error.status === 404);
  // Route errors keep their status.
  const res = routeResponse();
  await guestRoute("/:token", "get")({ params: { token: cancelled.token } }, res);
  assert.equal(res.result.code, 410);
});

test("attendance is visible only to the event requester, MENRO Staff and Admin", async () => {
  const { eventId, token } = await attendanceFixture("ATTEND-RBAC");
  await guestService.registerAttendance(token, { fullName: "Ana Lim", contactNumber: "09191112222", address: "Purok 5, Bical" });
  for (const user of [{ uid: "requester-attend", role: "participant" }, { uid: "staff-1", role: "staff" }, { uid: "admin-1", role: "admin" }]) {
    const rows = await guestService.listEventAttendance(eventId, user);
    assert.deepEqual(rows.map((row) => [row.fullName, row.contactNumber, row.address]), [["Ana Lim", "09191112222", "Purok 5, Bical"]], user.role);
  }
  for (const user of [{ uid: "participant-other", role: "participant" }, { uid: "", role: "staff" }, { uid: "guest", role: "guest" }]) {
    await assert.rejects(guestService.listEventAttendance(eventId, user), (error) => error.status === 403, JSON.stringify(user));
  }
  await assert.rejects(guestService.listEventAttendance("EVT-missing", { uid: "staff-1", role: "staff" }), (error) => error.status === 404);
  await assert.rejects(guestService.listEventAttendance("../x", { uid: "staff-1", role: "staff" }), (error) => error.status === 404);
  // Route guard: only authenticated participant/staff/admin reach the service.
  const eventRoutes = require("../src/routes/event.routes");
  const layer = eventRoutes.stack.find((entry) => entry.route?.path === "/:id/attendance" && entry.route.methods.get);
  assert.ok(layer);
  const guard = layer.route.stack[1].handle;
  for (const [role, allowed] of [["participant", true], ["staff", true], ["admin", true], ["guest", false]]) {
    let passed = false; const res = routeResponse();
    guard({ user: { uid: "u", role } }, res, () => { passed = true; });
    assert.equal(passed, allowed, role);
  }
});

test("new guest and attendee planting/photo contributions are retired; historical contributions stay readable", async () => {
  const eventRoutes = require("../src/routes/event.routes");
  const lastHandler = (router, path) => router.stack.find((entry) => entry.route?.path === path && entry.route.methods.post).route.stack.at(-1).handle;
  for (const [router, path] of [[guestRoutes, "/session/contributions"], [guestRoutes, "/session/contributions/:id/evidence"], [guestRoutes, "/:token/join"],
    [eventRoutes, "/:id/contributions"], [eventRoutes, "/:id/contributions/:contributionId/evidence"]]) {
    const res = routeResponse();
    await lastHandler(router, path)({ params: {}, body: { inventoryId: "calamansi", quantity: 1 }, headers: {} }, res);
    assert.equal(res.result.code, 410, path);
  }
  assert.ok(guestRoutes.stack.some((entry) => entry.route?.path === "/session/contributions" && entry.route.methods.get), "historical contributions stay readable");
});

test("Staff/Admin release an abandoned legacy reservation with a required reason and an audit entry", async () => {
  const { eventId } = await attendanceFixture("RESERVE");
  table("eventParticipants").set("guest-reserve", { eventId, participantType: "guest", fullName: "Old Guest" });
  const reservation = await contributionService.recordContribution(eventId, "guest-reserve", "calamansi", 15, "legacy_reservation_1");
  assert.equal(table("events").get(eventId).pendingSeedlingsByInventory.calamansi, 15);
  assert.equal((await guestService.publicEvent(eventId, table("events").get(eventId))).allocation[0].remaining, 25, "the reservation blocks 15");
  const listed = await contributionService.listLegacyReservations(eventId);
  assert.deepEqual(listed.map((row) => [row.id, row.reservationStatus, row.quantity]), [[reservation.id, "Reserved", 15]]);

  const staffUser = { uid: "staff-1", role: "staff", fullName: "Staff Name" };
  await assert.rejects(contributionService.releaseLegacyReservation(eventId, reservation.id, { uid: "p", role: "participant" }, "x"), (error) => error.status === 403);
  await assert.rejects(contributionService.releaseLegacyReservation(eventId, reservation.id, staffUser, "  "), (error) => error.status === 400);
  await assert.rejects(contributionService.releaseLegacyReservation(eventId, reservation.id, staffUser, "x".repeat(1001)), (error) => error.status === 400);
  await assert.rejects(contributionService.releaseLegacyReservation("EVT-other", reservation.id, staffUser, "Wrong event"), (error) => error.status === 404);
  const released = await contributionService.releaseLegacyReservation(eventId, reservation.id, staffUser, "Guest never uploaded evidence after the event");
  assert.equal(released.reservationStatus, "Released");
  const event = table("events").get(eventId);
  assert.equal(event.pendingSeedlingsByInventory.calamansi, 0); assert.equal(event.pendingSeedlingQuantity, 0);
  assert.equal((await guestService.publicEvent(eventId, event)).allocation[0].remaining, 40, "the balance is available for the final report");
  const row = table("plantingContributions").get(reservation.id);
  assert.ok(row, "the historical record is kept");
  assert.deepEqual([row.allocationReserved, row.reservationReleasedBy, row.reservationReleaseReason], [false, "staff-1", "Guest never uploaded evidence after the event"]);
  const log = [...table("verificationLogs").values()].find((entry) => entry.action === "Legacy Reservation Released" && entry.submissionId === reservation.id);
  assert.equal(log.performedBy, "staff-1"); assert.match(log.remarks, /Guest never uploaded evidence/);
  await assert.rejects(contributionService.releaseLegacyReservation(eventId, reservation.id, staffUser, "Again"), (error) => error.status === 409, "only once");

  // A reservation whose evidence was attached is not abandoned and cannot be released.
  const withEvidence = await contributionService.recordContribution(eventId, "guest-reserve", "calamansi", 5, "legacy_reservation_2");
  table("plantingContributions").get(withEvidence.id).photos = [{ imageHash: "attached" }];
  await assert.rejects(contributionService.releaseLegacyReservation(eventId, withEvidence.id, { ...staffUser, role: "admin" }, "No"), (error) => error.status === 409);
  // Route guard: Staff/Admin only.
  const eventRoutes = require("../src/routes/event.routes");
  const layer = eventRoutes.stack.find((entry) => entry.route?.path === "/:id/reservations/:contributionId/release" && entry.route.methods.post);
  for (const [role, allowed] of [["staff", true], ["admin", true], ["participant", false]]) {
    let passed = false;
    layer.route.stack[1].handle({ user: { uid: "u", role } }, routeResponse(), () => { passed = true; });
    assert.equal(passed, allowed, role);
  }
});

test("a released reservation is never counted as planting activity in analytics", async () => {
  const { eventId } = await attendanceFixture("RESERVE-ANALYTICS");
  table("eventParticipants").set("guest-analytics", { eventId, participantType: "guest", fullName: "Old Guest" });
  const reservation = await contributionService.recordContribution(eventId, "guest-analytics", "calamansi", 7, "legacy_reservation_analytics");
  await contributionService.releaseLegacyReservation(eventId, reservation.id, { uid: "admin-1", role: "admin" }, "Abandoned");
  // With the event report Completed, an unreviewed row would count as accounted planting.
  table("plantingReports").get(`event_${eventId}`).reportingProgress = "Completed";
  const analytics = require("../src/services/analytics.service");
  const totals = (dashboard) => {
    const found = {};
    (function walk(value) {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (["recordedPlantedQuantity", "verifiedPlantedQuantity"].includes(key) && !(key in found)) found[key] = entry;
        walk(entry);
      }
    })(dashboard);
    return found;
  };
  const withRelease = totals(await analytics.getDashboard({}));
  const row = table("plantingContributions").get(reservation.id);
  const saved = { reservationReleasedAt: row.reservationReleasedAt, reservationStatus: row.reservationStatus };
  delete row.reservationReleasedAt; delete row.reservationStatus;
  const withoutExclusion = totals(await analytics.getDashboard({}));
  Object.assign(row, saved);
  assert.equal(withoutExclusion.recordedPlantedQuantity - withRelease.recordedPlantedQuantity, 7, "the released reservation is excluded from recorded planting");
  assert.equal(withoutExclusion.verifiedPlantedQuantity - withRelease.verifiedPlantedQuantity, 7, "and from verified planting");
  // Attendance has no reader in analytics, monitoring or planting verification.
  for (const file of ["analytics.service.js", "monitoring.service.js", "parentPlantingReport.service.js", "plantingReport.service.js", "officialPlantingReport.service.js", "verifiedPlantingCohort.service.js"]) {
    const text = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/services", file), "utf8");
    assert.doesNotMatch(text, /eventAttendance/, `${file} never reads attendance`);
  }
});
