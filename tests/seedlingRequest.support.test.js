const assert = require("node:assert/strict");
const test = require("node:test");

const records = {
  seedlingRequests: new Map(),
  seedlingInventory: new Map(),
  users: new Map(),
  sites: new Map(),
};

const db = {
  collection(name) {
    return {
      doc(id) {
        return {
          id,
          name,
          async get() {
            const data = records[name].get(id);
            return { id, exists: data !== undefined, data: () => data };
          },
          async update(data) {
            records[name].set(id, { ...records[name].get(id), ...data });
          },
        };
      },
      async add(data) {
        const id = `new-${records[name].size + 1}`;
        records[name].set(id, data);
        return { id };
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
  async runTransaction(callback) {
    const writes = [];
    await callback({
      get: (ref) => ref.get(),
      update(ref, data) { writes.push([ref, data]); },
    });
    for (const [ref, data] of writes) {
      records[ref.name].set(ref.id, { ...records[ref.name].get(ref.id), ...data });
    }
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { db, auth: {} },
};

const service = require("../src/services/seedlingRequest.service");
const seedlingController = require("../src/controller/seedlingRequest.controller");
const siteService = require("../src/services/site.service");
const siteController = require("../src/controller/site.controller");
const siteRoutes = require("../src/routes/site.routes");
const seedlingRoutes = require("../src/routes/seedlingRequest.routes");
const authRoutes = require("../src/routes/auth.routes");
const authController = require("../src/controller/auth.controller");

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
    preferredReleaseDate: "2026-09-20", reviewRemarks: "Verified site and quantity",
  };
  const result = await service.reviewSeedlingRequest("request-1", review);
  assert.equal(result.status, "Reviewed");
  assert.equal(result.reviewedBy, "staff-1");
  assert.ok(result.reviewedAt?.toDate?.());
  assert.equal(result.items[0].species, "Narra");
  await assert.rejects(service.reviewSeedlingRequest("request-1", review), /Only pending requests/);
});

test("current frontend reviewFindings payload is accepted and stored as reviewRemarks", async () => {
  records.seedlingRequests.set("request-frontend", { status: "Pending" });
  records.seedlingInventory.set("inventory-1", { species: "Narra" });
  const res = response();
  await seedlingController.markRequestReviewed({
    params: { id: "request-frontend" },
    user: { uid: "staff-1", fullName: "Staff Name" },
    body: {
      items: [{ inventoryId: "inventory-1", quantity: 2 }],
      purpose: "Planting", plantingLocation: "Juban",
      preferredReleaseDate: "2026-09-20", reviewFindings: "  Site verified  ",
    },
  }, res);
  assert.equal(res.result.code, 200);
  assert.equal(res.result.body.data.reviewRemarks, "Site verified");
});

test("details return full stored data and missing requests return 404", async () => {
  records.seedlingRequests.set("request-details", {
    status: "Reviewed", participantId: "participant-1",
    reviewRemarks: "Site verified", items: [{ inventoryId: "inventory-1", quantity: 2 }],
  });
  const found = response();
  await seedlingController.getSeedlingRequest({ params: { id: "request-details" }, user: { role: "participant", uid: "participant-1" } }, found);
  assert.equal(found.result.code, 200);
  assert.equal(found.result.body.data.reviewRemarks, "Site verified");
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
  const updated = await siteService.updateSite("site-1", {
    siteName: "New Name", maximumCapacity: 80, createdBy: "forged", planted: 900,
  }, "staff-1");
  assert.equal(updated.id, "site-1");
  assert.equal(updated.siteName, "New Name");
  assert.equal(updated.createdBy, "staff-0");
  assert.equal(updated.planted, 20);
  assert.equal(updated.targetTrees, 80);
  assert.equal(updated.polygon.length, 3);
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
  const created = await service.createSeedlingRequest({ ...payload, eventProposal: { ...payload.eventProposal, barangay: " bacolod " } });
  assert.equal(created.eventProposal.plantingSiteId, "site-2");
  assert.ok((await service.getSeedlingRequestsByParticipantId("participant-1"))
    .some((request) => request.id === created.id));
});

test("review and decision roles remain separate", () => {
  function roleFor(path) {
    const layer = seedlingRoutes.stack.find((entry) => entry.route?.path === path && entry.route.methods.patch);
    assert.ok(layer);
    return layer.route.stack[1].handle;
  }
  for (const [path, role] of [["/:id/review", "staff"], ["/:id/approve", "admin"], ["/:id/reject", "admin"]]) {
    const handler = roleFor(path);
    const allowed = response();
    let nextCalled = false;
    handler({ user: { role } }, allowed, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    const denied = response();
    handler({ user: { role: "participant" } }, denied, () => {});
    assert.equal(denied.result.code, 403);
  }
});
