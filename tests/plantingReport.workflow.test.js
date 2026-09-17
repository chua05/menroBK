const assert = require("node:assert/strict");
const test = require("node:test");

const collections = new Map();
let generatedId = 0;

function table(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

function reference(name, id) {
  return {
    id,
    collectionName: name,
    async get() {
      const value = table(name).get(id);
      return { id, exists: value !== undefined, data: () => value };
    },
  };
}

const db = {
  collection(name) {
    return {
      doc(id = `generated-${++generatedId}`) { return reference(name, id); },
      async get() {
        return { docs: [...table(name)].map(([id, value]) => ({ id, data: () => value })) };
      },
      where(field, operator, value) {
        assert.equal(operator, "==");
        return {
          async get() {
            return {
              docs: [...table(name)].filter(([, item]) => item[field] === value)
                .map(([id, item]) => ({ id, data: () => item })),
            };
          },
        };
      },
    };
  },
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: (ref) => ref.get(),
      update(ref, value) { writes.push(["update", ref, value]); },
      set(ref, value) { writes.push(["set", ref, value]); },
      create(ref, value) { writes.push(["create", ref, value]); },
    };
    await callback(transaction);
    for (const [operation, ref, value] of writes) {
      const target = table(ref === undefined ? "" : ref.collectionName || "plantingReports");
      if (operation === "set" || operation === "create") table(ref.collectionName).set(ref.id, value);
      else target.set(ref.id, { ...target.get(ref.id), ...value });
    }
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { db },
};

const service = require("../src/services/plantingReport.service");
const routes = require("../src/routes/plantingReport.routes");
const controller = require("../src/controller/plantingReport.controller");
const inventoryRoutes = require("../src/routes/inventory.routes");
const eventRoutes = require("../src/routes/event.routes");
const guestRoutes = require("../src/routes/guestEvent.routes");

function seed(id, status = "Pending Review") {
  table("plantingReports").set(id, {
    participantId: "participant-1",
    verificationStatus: status,
    automatedVerificationStatus: "Flagged",
    suspiciousFlags: ["GPS_MISMATCH"],
    photos: [{ gpsValid: false, suspiciousFlags: ["GPS_MISMATCH"] }],
  });
}

function roleHandler(path) {
  const route = routes.stack.find((layer) => layer.route?.path === path && layer.route.methods.patch);
  assert.ok(route, `${path} route exists`);
  return route.route.stack[1].handle;
}

async function authorize(handler, role) {
  let result;
  let allowed = false;
  const res = {
    status(code) { result = { code }; return this; },
    json(body) { result.body = body; return this; },
  };
  handler({ user: { uid: `${role}-1`, role } }, res, () => { allowed = true; });
  return { allowed, result };
}

test("only Staff can reach final decision routes; the intermediate route is gone", async () => {
  assert.equal(routes.stack.some((layer) => layer.route?.path === "/:id/review"), false);
  for (const path of ["/:id/approve", "/:id/reject"]) {
    const handler = roleHandler(path);
    assert.equal((await authorize(handler, "staff")).allowed, true);
    assert.equal((await authorize(handler, "admin")).result.code, 403);
    assert.equal((await authorize(handler, "participant")).result.code, 403);
  }
});

test("Staff approval is final and preserves automated findings", async () => {
  seed("approve-1");
  const report = await service.approvePlantingReport("approve-1", "staff-1", "", "Staff Name");
  assert.equal(report.verificationStatus, "Approved");
  assert.equal(report.reviewedBy, "staff-1");
  assert.equal(report.reviewedByName, "Staff Name");
  assert.ok(report.reviewedAt?.toDate?.());
  assert.equal(report.automatedVerificationStatus, "Flagged");
  assert.deepEqual(report.suspiciousFlags, ["GPS_MISMATCH"]);
  await assert.rejects(service.rejectPlantingReport("approve-1", "staff-2", "Reason"), /Only pending review/);
  await assert.rejects(service.approvePlantingReport("approve-1", "staff-2", ""), /Only pending review/);
});

test("rejection requires a reason and persists the authenticated reviewer", async () => {
  seed("reject-1");
  await assert.rejects(service.rejectPlantingReport("reject-1", "staff-1", "  "), /Rejection reason is required/);
  assert.equal(table("plantingReports").get("reject-1").verificationStatus, "Pending Review");
  const report = await service.rejectPlantingReport("reject-1", "staff-1", "  Evidence mismatch  ", "Staff Name");
  assert.equal(report.verificationStatus, "Rejected");
  assert.equal(report.rejectionRemarks, "Evidence mismatch");
  assert.equal(report.reviewedBy, "staff-1");
  assert.ok(report.reviewedAt?.toDate?.());
  await assert.rejects(service.approvePlantingReport("reject-1", "staff-2", ""), /Only pending review/);
});

test("legacy Flagged records read as pending without mutating historical data", async () => {
  seed("legacy-1", "Flagged");
  table("plantingReports").get("legacy-1").automatedVerificationStatus = undefined;
  const report = await service.getPlantingReportById("legacy-1");
  assert.equal(report.verificationStatus, "Pending Review");
  assert.equal(report.automatedVerificationStatus, "Flagged");
  assert.equal(table("plantingReports").get("legacy-1").verificationStatus, "Flagged");
});

test("legacy Reviewed reports can receive the final Staff decision", async () => {
  seed("legacy-reviewed", "Reviewed");
  const pending = await service.getPlantingReportById("legacy-reviewed");
  assert.equal(pending.verificationStatus, "Pending Review");
  const approved = await service.approvePlantingReport("legacy-reviewed", "staff-1", "", "Staff Name");
  assert.equal(approved.verificationStatus, "Approved");
  assert.equal(approved.automatedVerificationStatus, "Flagged");
  assert.equal(table("plantingReports").get("legacy-reviewed").verificationStatus, "Approved");
});

test("participants can open only their own report details", async () => {
  seed("owned-1");
  async function readAs(uid) {
    let result;
    const res = {
      status(code) { result = { code }; return this; },
      json(body) { result.body = body; return this; },
    };
    await controller.getPlantingReport({ params: { id: "owned-1" }, user: { uid, role: "participant" } }, res);
    return result;
  }
  assert.equal((await readAs("participant-1")).code, 200);
  assert.equal((await readAs("participant-2")).code, 404);
  const myReports = await service.getPlantingReportsByParticipantId("participant-2");
  assert.deepEqual(myReports, []);
});

test("specific inventory archived route precedes item ID route", () => {
  const paths = inventoryRoutes.stack.filter((layer) => layer.route?.methods.get)
    .map((layer) => layer.route.path);
  assert.ok(paths.indexOf("/archived") < paths.indexOf("/:id"));
});

test("Staff and Admin can read event participants; guests have no decision route", async () => {
  const route = eventRoutes.stack.find((layer) =>
    layer.route?.path === "/:id/participants" && layer.route.methods.get);
  assert.ok(route);
  const roleGuard = route.route.stack[1].handle;
  assert.equal((await authorize(roleGuard, "staff")).allowed, true);
  assert.equal((await authorize(roleGuard, "admin")).allowed, true);
  assert.equal((await authorize(roleGuard, "participant")).result.code, 403);
  assert.equal(guestRoutes.stack.some((layer) =>
    /approve|reject/.test(layer.route?.path || "")), false);
});
