const assert = require("node:assert/strict");
const test = require("node:test");

const records = {
  seedlingRequests: new Map(),
  seedlingInventory: new Map(),
  users: new Map(),
  sites: new Map(),
  counters: new Map(),
  notifications: new Map(),
  distributions: new Map(),
  requestIdentifications: new Map(),
  sensitiveDataAccessLogs: new Map(),
};

let generatedDocumentId = 0;
let transactionTail = Promise.resolve();

const db = {
  collection(name) {
    return {
      doc(id) {
        const resolvedId = id || `new-${++generatedDocumentId}`;
        return {
          id: resolvedId,
          name,
          async get() {
            const data = records[name].get(resolvedId);
            return { id: resolvedId, exists: data !== undefined, data: () => data };
          },
          async update(data) {
            records[name].set(resolvedId, { ...records[name].get(resolvedId), ...data });
          },
        };
      },
      async add(data) {
        const id = `new-${records[name].size + 1}`;
        records[name].set(id, data);
        return { id };
      },
      async get() {
        return {
          docs: [...records[name].entries()].map(([id, data]) => ({ id, data: () => data })),
        };
      },
      where(field, operator, value) {
        return {
          async get() {
            return { docs: [...records[name].entries()]
              .filter(([, data]) => data[field] === value)
              .map(([id, data]) => ({ id, data: () => data })) };
          },
        };
      },
    };
  },
  runTransaction(callback) {
    const execute = async () => {
      const writes = [];
      await callback({
        get: (ref) => ref.get(),
        update(ref, data) { writes.push([ref, data]); },
        set(ref, data) { writes.push([ref, data]); },
        create(ref, data) { writes.push([ref, data]); },
      });
      for (const [ref, data] of writes) {
        records[ref.name].set(ref.id, { ...records[ref.name].get(ref.id), ...data });
      }
    };
    const result = transactionTail.then(execute, execute);
    transactionTail = result.then(() => undefined, () => undefined);
    return result;
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { db, auth: {} },
};

const service = require("../src/services/seedlingRequest.service");
const identificationService = require("../src/services/requestIdentification.service");
const seedlingController = require("../src/controller/seedlingRequest.controller");
const siteService = require("../src/services/site.service");
const siteController = require("../src/controller/site.controller");
const siteRoutes = require("../src/routes/site.routes");
const seedlingRoutes = require("../src/routes/seedlingRequest.routes");
const authRoutes = require("../src/routes/auth.routes");
const authController = require("../src/controller/auth.controller");

const futureDate = new Date();
futureDate.setDate(futureDate.getDate() + 1);
const validPreferredReleaseDate = [
  futureDate.getFullYear(),
  String(futureDate.getMonth() + 1).padStart(2, "0"),
  String(futureDate.getDate()).padStart(2, "0"),
].join("-");

function response() {
  const result = {};
  return {
    result,
    status(code) { result.code = code; return this; },
    json(body) { result.body = body; return this; },
  };
}

test("profile reads the authenticated UID and real Firestore name", async () => {
  records.users.set("participant-1", {
    uid: "participant-1", fullName: "Jose Dela Cruz", role: "participant", status: "active",
  });
  const res = response();
  await authController.getProfile({ user: { uid: "participant-1" }, query: { uid: "someone-else" } }, res);
  assert.equal(res.result.code, 200);
  assert.equal(res.result.body.data.fullName, "Jose Dela Cruz");
  assert.equal(res.result.body.data.uid, "participant-1");
  const profileRoute = authRoutes.stack.find((layer) => layer.route?.path === "/profile" && layer.route.methods.get);
  assert.ok(profileRoute);
  assert.equal(profileRoute.route.stack.length, 3);
});

test("Staff review advances Pending once and retains server-owned inventory details", async () => {
  records.seedlingRequests.set("request-1", { status: "Pending", participantId: "participant-1" });
  records.seedlingInventory.set("inventory-1", {
    species: "Narra", scientificName: "Pterocarpus indicus", category: "Native",
  });
  const review = {
    reviewedBy: "staff-1", reviewedByName: "Staff Name",
    items: [{ inventoryId: "inventory-1", quantity: 12, species: "Forged" }],
    purpose: "Planting", plantingLocation: "Juban",
    preferredReleaseDate: validPreferredReleaseDate, reviewRemarks: "Verified site and quantity",
  };
  const result = await service.reviewSeedlingRequest("request-1", review);
  assert.equal(result.status, "Reviewed");
  assert.equal(result.reviewedBy, "staff-1");
  assert.equal(result.reviewedByUid, "staff-1");
  assert.equal(result.reviewedByName, "Staff Name");
  assert.equal(result.reviewStatus, "Reviewed");
  assert.match(result.reviewId, /^REV-\d{4}-\d{3,}$/);
  assert.match(result.requestNumber, /^REQ-\d{4}-\d{3,}$/);
  assert.equal(result.reviewHistory.at(-1).reviewId, result.reviewId);
  assert.ok(result.reviewedAt?.toDate?.());
  assert.equal(result.items[0].species, "Narra");
  assert.equal((await service.getSeedlingRequestById("request-1")).reviewId, result.reviewId);
  await assert.rejects(service.reviewSeedlingRequest("request-1", review), /Only pending requests/);
});

test("Staff review confirmation requires no findings or observation", async () => {
  records.seedlingRequests.set("request-frontend", { status: "Pending" });
  records.seedlingInventory.set("inventory-1", { species: "Narra" });
  const res = response();
  await seedlingController.markRequestReviewed({
    params: { id: "request-frontend" },
    user: { uid: "staff-1", fullName: "Staff Name" },
    body: {
      items: [{ inventoryId: "inventory-1", quantity: 2 }],
      purpose: "Planting", plantingLocation: "Juban",
      preferredReleaseDate: validPreferredReleaseDate,
    },
  }, res);
  assert.equal(res.result.code, 200);
  assert.equal(res.result.body.data.reviewRemarks, "");
  assert.match(res.result.body.data.reviewId, /^REV-\d{4}-\d{3,}$/);
  assert.equal(res.result.body.data.reviewedByName, "Staff Name");
});

test("site creation assigns unique year-scoped readable IDs while retaining internal document IDs", async () => {
  const input = {
    siteName: "Readable Site",
    barangay: "Bacolod",
    siteType: "Public Land",
    locationDescription: "Bacolod, Juban",
    areaHectares: 1,
    maximumCapacity: 100,
    latitude: 12.82,
    longitude: 124,
    coverageRadiusMeters: 50,
    createdBy: "staff-1",
  };

  await assert.rejects(
    siteService.createSite({ ...input, coverageRadiusMeters: 0 }),
    /coverage radius greater than 0 meters/
  );
  await assert.rejects(
    siteService.createSite({ ...input, coverageRadiusMeters: "letters" }),
    /coverage radius greater than 0 meters/
  );
  await assert.rejects(
    siteService.createSite({ ...input, latitude: "" }),
    /Latitude must be between -90 and 90/
  );

  const first = await siteService.createSite(input);
  const second = await siteService.createSite({ ...input, siteName: "Readable Site Two" });
  const [third, fourth] = await Promise.all([
    siteService.createSite({ ...input, siteName: "Concurrent Site A" }),
    siteService.createSite({ ...input, siteName: "Concurrent Site B" }),
  ]);
  const year = siteService.getJubanYear();

  assert.match(first.id, /^new-\d+$/);
  assert.equal(first.siteId, `SITE-${year}-001`);
  assert.equal(second.siteId, `SITE-${year}-002`);
  assert.notEqual(first.id, first.siteId);
  assert.notEqual(first.siteId, second.siteId);
  assert.equal(first.coverageRadiusMeters, 50);
  assert.equal(Object.hasOwn(first, "polygon"), false);
  assert.notEqual(third.siteId, fourth.siteId);
  assert.deepEqual(
    [third.siteId, fourth.siteId].sort(),
    [`SITE-${year}-003`, `SITE-${year}-004`]
  );
});

test("Staff return and participant resubmission preserve the same request and review history", async () => {
  records.seedlingRequests.set("request-returned", {
    status: "Pending",
    participantId: "participant-1",
    participantName: "Participant One",
    requestNumber: "REQ-2026-001",
    inventoryDeducted: false,
    inventoryReserved: false,
    reviewHistory: [],
  });
  records.seedlingInventory.set("inventory-returned", {
    species: "Narra",
    scientificName: "Pterocarpus indicus",
    category: "Native",
    availableQuantity: 20,
  });
  records.sites.set("site-returned", {
    siteName: "Revision Site",
    status: "active",
    barangay: "Bacolod",
    maximumCapacity: 100,
    planted: 10,
    latitude: 12.82,
    longitude: 124,
  });

  await assert.rejects(
    service.returnSeedlingRequest("request-returned", "staff-1", "MENRO Staff", "   "),
    /Please provide a reason/
  );

  const returned = await service.returnSeedlingRequest(
    "request-returned",
    "staff-1",
    "MENRO Staff",
    "  Please correct the selected planting site.  "
  );
  assert.equal(returned.status, "Returned");
  assert.equal(returned.returnReason, "Please correct the selected planting site.");
  assert.equal(returned.returnedBy, "staff-1");
  assert.equal(returned.reviewHistory.at(-1).action, "returned");
  assert.equal(records.notifications.size, 1);
  await assert.rejects(
    service.returnSeedlingRequest("request-returned", "staff-1", "MENRO Staff", "Again"),
    /Only pending requests/
  );

  const inventoryBefore = { ...records.seedlingInventory.get("inventory-returned") };
  const data = {
    items: [{ inventoryId: "inventory-returned", quantity: 8 }],
    purpose: "Community planting",
    plantingLocation: "Revision Site, Bacolod",
    preferredReleaseDate: validPreferredReleaseDate,
    eventProposal: {
      eventName: "Revised Event",
      barangay: "Bacolod",
      plantingSiteId: "site-returned",
      proposedDate: validPreferredReleaseDate,
      proposedStartTime: "08:00",
      proposedEndTime: "10:00",
      expectedParticipants: 12,
      description: "Corrected request",
    },
  };

  await assert.rejects(
    service.resubmitSeedlingRequest("request-returned", "participant-2", data),
    /only edit your own/
  );
  const resubmitted = await service.resubmitSeedlingRequest(
    "request-returned",
    "participant-1",
    data
  );
  assert.equal(resubmitted.status, "Pending");
  assert.equal(resubmitted.requestNumber, "REQ-2026-001");
  assert.equal(resubmitted.returnReason, "");
  assert.equal(resubmitted.reviewHistory.at(-1).action, "resubmitted");
  assert.deepEqual(records.seedlingInventory.get("inventory-returned"), inventoryBefore);
  await assert.rejects(
    service.resubmitSeedlingRequest("request-returned", "participant-1", data),
    /status has changed/
  );

  const returnedAgain = await service.returnSeedlingRequest(
    "request-returned",
    "staff-2",
    "Second Reviewer",
    "Please correct the preferred release date."
  );
  assert.equal(returnedAgain.status, "Returned");
  assert.equal(returnedAgain.requestNumber, "REQ-2026-001");
  assert.equal(returnedAgain.reviewHistory.filter((entry) => entry.action === "returned").length, 2);
  assert.equal(records.notifications.has("request_returned_request-returned_2"), true);

  const resubmittedAgain = await service.resubmitSeedlingRequest(
    "request-returned",
    "participant-1",
    data
  );
  assert.equal(resubmittedAgain.status, "Pending");
  assert.equal(resubmittedAgain.requestNumber, "REQ-2026-001");
  assert.deepEqual(records.seedlingInventory.get("inventory-returned"), inventoryBefore);
});

test("details return full stored data and missing requests return 404", async () => {
  records.seedlingRequests.set("request-details", {
    status: "Reviewed", participantId: "participant-1",
    reviewRemarks: "Site verified", items: [{ inventoryId: "inventory-1", quantity: 2 }],
    identificationType: "passport", idNumber: "SHOULD-NOT-LEAK",
    encryptedIdNumber: "legacy-sensitive-value", schoolInstitutionName: "Hidden School",
  });
  const found = response();
  await seedlingController.getSeedlingRequest({ params: { id: "request-details" }, user: { role: "participant", uid: "participant-1" } }, found);
  assert.equal(found.result.code, 200);
  assert.equal(found.result.body.data.reviewRemarks, "Site verified");
  for (const field of ["identificationType", "idNumber", "encryptedIdNumber", "schoolInstitutionName"]) {
    assert.equal(found.result.body.data[field], undefined);
  }
  const staff = response();
  await seedlingController.getSeedlingRequest({ params: { id: "request-details" }, user: { role: "staff", uid: "staff-1" } }, staff);
  assert.equal(staff.result.code, 200);
  assert.equal(staff.result.body.data.identification, undefined);
  assert.equal(JSON.stringify(staff.result.body.data).includes("SHOULD-NOT-LEAK"), false);
  const missing = response();
  await seedlingController.getSeedlingRequest({ params: { id: "missing" }, user: { role: "participant", uid: "participant-1" } }, missing);
  assert.equal(missing.result.code, 404);
  const other = response();
  await seedlingController.getSeedlingRequest({ params: { id: "request-details" }, user: { role: "participant", uid: "participant-2" } }, other);
  assert.equal(other.result.code, 403);
});

test("site edit updates only permitted fields and keeps the same record for list and map", async () => {
  records.sites.set("site-1", {
    siteId: "site-1", siteName: "Old Name", barangay: "Bacolod", status: "active",
    latitude: 12, longitude: 123, polygon: [{ lat: 12, lng: 123 }, { lat: 12.1, lng: 123 }, { lat: 12, lng: 123.1 }],
    maximumCapacity: 100, targetTrees: 100, planted: 20, createdBy: "staff-0",
  });
  await assert.rejects(
    siteService.updateSite("site-1", { siteName: "Still Legacy" }, "staff-1"),
    /coverage radius greater than 0 meters/
  );
  const updated = await siteService.updateSite("site-1", {
    siteName: "New Name", maximumCapacity: 80, coverageRadiusMeters: 75,
    createdBy: "forged", planted: 900,
  }, "staff-1");
  assert.equal(updated.id, "site-1");
  assert.equal(updated.siteName, "New Name");
  assert.equal(updated.createdBy, "staff-0");
  assert.equal(updated.planted, 20);
  assert.equal(updated.targetTrees, 80);
  assert.equal(updated.coverageRadiusMeters, 75);
  assert.equal(updated.polygon.length, 3);
  const readableLegacySite = await siteService.getSiteById("site-1");
  assert.match(readableLegacySite.siteId, /^SITE-\d{4}-\d{3,}$/);
  assert.equal(readableLegacySite.id, "site-1");
  await assert.rejects(siteService.updateSite("site-1", { maximumCapacity: 10 }, "staff-1"), /below the planted count/);
  const route = siteRoutes.stack.find((layer) => layer.route?.path === "/:id" && layer.route.methods.patch);
  assert.ok(route);
  const denied = response();
  route.route.stack[1].handle({ user: { role: "participant" } }, denied, () => {});
  assert.equal(denied.result.code, 403);
  const result = response();
  await siteController.updateSite({ params: { id: "site-1" }, user: { uid: "staff-1" }, body: { notes: "Real notes" } }, result);
  assert.equal(result.result.code, 200);
  const detailsRoute = seedlingRoutes.stack.find((layer) => layer.route?.path === "/:id" && layer.route.methods.get);
  let participantAllowed = false;
  detailsRoute.route.stack[1].handle({ user: { role: "participant" } }, response(), () => { participantAllowed = true; });
  assert.equal(participantAllowed, true);
});

test("request submission rejects a real site in a different barangay", async () => {
  records.sites.set("site-2", {
    status: "active", barangay: "Bacolod", maximumCapacity: 100, planted: 0,
  });
  records.seedlingInventory.set("inventory-1", { species: "Narra" });
  const payload = {
    items: [{ inventoryId: "inventory-1", quantity: 2 }],
    eventProposal: { plantingSiteId: "site-2", barangay: "Different" },
    participantId: "participant-1", status: "Pending",
  };
  await assert.rejects(service.createSeedlingRequest(payload), /does not belong/);
  const previousKey = process.env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY;
  process.env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const identification = identificationService.validateIdentificationInput({
    identificationType: "drivers_license",
    idNumber: "  N01-23-456789  ",
    confirmed: true,
  });
  const created = await service.createSeedlingRequest(
    { ...payload, eventProposal: { ...payload.eventProposal, barangay: " bacolod " } },
    identification,
  );
  assert.equal(created.eventProposal.plantingSiteId, "site-2");
  assert.match(created.requestNumber, /^REQ-\d{4}-\d{3,}$/);
  assert.equal(created.identification, undefined);
  const storedIdentification = records.requestIdentifications.get(created.id);
  assert.equal(storedIdentification.identificationType, "drivers_license");
  assert.equal(storedIdentification.idNumber, undefined);
  assert.notEqual(storedIdentification.ciphertext, "N01-23-456789");
  const staffRead = await service.getSeedlingRequestById(created.id);
  assert.equal(staffRead.identification, undefined);
  const adminRead = await service.getSeedlingRequestById(created.id, { includeIdentification: true });
  assert.equal(adminRead.identification.identificationTypeLabel, "Driver's License");
  assert.match(adminRead.identification.maskedIdNumber, /6789$/);
  const revealed = await service.revealIdentification(created.id, "admin-1");
  assert.equal(revealed.idNumber, "N01-23-456789");
  assert.equal([...records.sensitiveDataAccessLogs.values()].at(-1).action, "VIEW_ID_INFORMATION");
  assert.equal(JSON.stringify([...records.sensitiveDataAccessLogs.values()]).includes("N01-23-456789"), false);
  const next = await service.createSeedlingRequest({ ...payload, eventProposal: { ...payload.eventProposal, barangay: "Bacolod" } });
  assert.match(next.requestNumber, /^REQ-\d{4}-\d{3,}$/);
  assert.notEqual(next.requestNumber, created.requestNumber);
  assert.ok((await service.getSeedlingRequestsByParticipantId("participant-1"))
    .some((request) => request.id === created.id));
  if (previousKey === undefined) delete process.env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY;
  else process.env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY = previousKey;
});

test("identification validation preserves supported string formats and requires school name", () => {
  for (const idNumber of ["N01-23-456789", "0012345678", "ABC-2026-001", "2026/00125", "2024-12345-A"]) {
    assert.equal(
      identificationService.validateIdentificationInput({
        identificationType: "passport",
        idNumber: `  ${idNumber}  `,
        confirmed: true,
      }).idNumber,
      idNumber,
    );
  }
  for (const idNumber of ["2023-001234", "2024-12345-A", "BSIT-2025-001", "0012345678", "A-2026-1234", "2026/00125", "123456"]) {
    assert.equal(
      identificationService.validateIdentificationInput({
        identificationType: "school_id",
        idNumber,
        schoolInstitutionName: "Sorsogon State University",
        confirmed: true,
      }).idNumber,
      idNumber,
    );
  }
  assert.throws(() => identificationService.validateIdentificationInput({
    identificationType: "school_id",
    idNumber: "2026-001",
    confirmed: true,
  }), /School \/ Institution Name is required/);
  assert.throws(() => identificationService.validateIdentificationInput({
    identificationType: "passport",
    idNumber: "ABC-1234",
    confirmed: false,
  }), /Please confirm/);
});

test("submission rejects unsupported root-level sensitive fields", async () => {
  const res = response();
  await seedlingController.submitSeedlingRequest({
    user: { uid: "participant-1", fullName: "Participant One" },
    body: { idNumber: "MUST-NOT-BE-IGNORED" },
  }, res);
  assert.equal(res.result.code, 400);
  assert.match(res.result.body.message, /supported request structure/);
});

test("legacy request and review IDs are migrated once without changing document IDs", async () => {
  records.users.set("legacy-staff", {
    fullName: "Maria Santos",
    role: "staff",
  });
  records.seedlingRequests.set("canonical-request-2024", {
    requestNumber: "REQ-2024-125",
    participantId: "participant-legacy",
    createdAt: "2024-01-02T01:00:00.000Z",
    status: "Pending",
  });
  records.seedlingRequests.set("firebase-document-key", {
    requestNumber: "REQ-04D9BU2",
    participantId: "participant-legacy",
    createdAt: "2024-06-10T03:30:00.000Z",
    reviewedAt: "2024-06-11T05:00:00.000Z",
    reviewedBy: "legacy-staff",
    status: "Reviewed",
  });

  const firstRead = (await service.getAllSeedlingRequests())
    .find((request) => request.id === "firebase-document-key");

  assert.ok(firstRead);
  assert.match(firstRead.requestNumber, /^REQ-2024-\d{3,}$/);
  assert.ok(Number(firstRead.requestNumber.split("-").at(-1)) > 125);
  assert.equal(firstRead.legacyRequestNumber, "REQ-04D9BU2");
  assert.match(firstRead.reviewId, /^REV-2024-\d{3,}$/);
  assert.equal(firstRead.reviewedByUid, "legacy-staff");
  assert.equal(firstRead.reviewedByName, "Maria Santos");
  assert.equal(firstRead.reviewStatus, "Reviewed");
  assert.ok(records.seedlingRequests.has("firebase-document-key"));

  const secondRead = await service.getSeedlingRequestById("firebase-document-key");
  assert.equal(secondRead.requestNumber, firstRead.requestNumber);
  assert.equal(secondRead.reviewId, firstRead.reviewId);
});

test("review and decision roles remain separate", () => {
  function roleFor(path) {
    const layer = seedlingRoutes.stack.find((entry) => entry.route?.path === path && entry.route.methods.patch);
    assert.ok(layer);
    return layer.route.stack[1].handle;
  }
  for (const [path, role] of [["/:id/review", "staff"], ["/:id/return", "staff"], ["/:id/resubmit", "participant"], ["/:id/approve", "admin"], ["/:id/reject", "admin"]]) {
    const handler = roleFor(path);
    const allowed = response();
    let nextCalled = false;
    handler({ user: { role } }, allowed, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    const denied = response();
    handler({ user: { role: role === "participant" ? "staff" : "participant" } }, denied, () => {});
    assert.equal(denied.result.code, 403);
  }
});

test("only Admin can reach the full identification reveal route", () => {
  const route = seedlingRoutes.stack.find(
    (entry) => entry.route?.path === "/:id/identification" && entry.route.methods.get,
  );
  assert.ok(route);
  let adminAllowed = false;
  route.route.stack[1].handle({ user: { role: "admin" } }, response(), () => { adminAllowed = true; });
  assert.equal(adminAllowed, true);
  for (const role of ["staff", "participant"]) {
    const denied = response();
    route.route.stack[1].handle({ user: { role } }, denied, () => {});
    assert.equal(denied.result.code, 403);
  }
});
