const assert = require("node:assert/strict");
const test = require("node:test");

const tables = new Map();
const table = (name) => tables.get(name) || (tables.set(name, new Map()), tables.get(name));
function ref(collectionName, id) {
  return {
    id, collectionName,
    async get() {
      const value = table(collectionName).get(id);
      return { id, exists: value !== undefined, data: () => value };
    },
  };
}
const db = {
  collection(name) {
    return { doc: (id) => ref(name, id) };
  },
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: (document) => document.get(),
      create: (document, value) => writes.push(["create", document, value]),
      update: (document, value) => writes.push(["update", document, value]),
    };
    await callback(transaction);
    for (const [operation, document, value] of writes) {
      if (operation === "create") table(document.collectionName).set(document.id, value);
      else table(document.collectionName).set(document.id, { ...table(document.collectionName).get(document.id), ...value });
    }
  },
};

const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const service = require("../src/services/verifiedPlantingCohort.service");
const routes = require("../src/routes/verifiedPlantingCohort.routes");

function reset() {
  tables.clear();
  process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true";
}

test.after(() => { delete process.env.VERIFIED_PLANTING_COHORT_ENABLED; });

test("creates exactly one additive cohort for an authoritative completed parent report", async () => {
  reset();
  table("events").set("event-1", { sourceRequestId: "request-1", plantingSiteId: "site-1", seedlingItems: [
    { inventoryId: "inventory-1", species: "Narra", quantity: 20 },
  ] });
  const report = { reportType: "parent", reportingProgress: "Completed", acceptedQuantity: 20,
    requestId: "request-1", eventId: "event-1", distributionId: "request-1", siteId: "site-1" };
  await db.runTransaction((transaction) => service.ensureCohortForAuthoritativeReportInTransaction(transaction, {
    reportId: "report-1", report,
  }));
  await db.runTransaction((transaction) => service.ensureCohortForAuthoritativeReportInTransaction(transaction, {
    reportId: "report-1", report,
  }));
  assert.equal(table("verifiedPlantingCohorts").size, 1);
  const cohort = [...table("verifiedPlantingCohorts").values()][0];
  assert.equal(cohort.source.plantingReportId, "report-1");
  assert.equal(cohort.source.requestId, "request-1");
  assert.equal(cohort.source.eventId, "event-1");
  assert.equal(cohort.source.distributionId, "request-1");
  assert.equal(cohort.source.siteId, "site-1");
  assert.deepEqual(cohort.source.species, [{ inventoryId: "inventory-1", species: "Narra", releasedQuantity: 20 }]);
  assert.equal(cohort.verifiedPlantedQuantity, 20);
  assert.equal(cohort.baselineStatus, "NOT_STARTED");
  assert.equal(cohort.samplingWorkflowEnabled, false);
});

test("does not create cohorts while the feature gate is disabled", async () => {
  reset();
  process.env.VERIFIED_PLANTING_COHORT_ENABLED = "false";
  await db.runTransaction((transaction) => service.ensureCohortForAuthoritativeReportInTransaction(transaction, {
    reportId: "legacy-report", report: { verificationStatus: "Approved", quantityPlanted: 10 },
  }));
  assert.equal(table("verifiedPlantingCohorts").size, 0);
});

test("Staff baseline registration stores permanent sample identifiers and detects stale edits", async () => {
  reset();
  const cohortId = service.cohortIdFor("report-baseline");
  table("verifiedPlantingCohorts").set(cohortId, {
    source: { plantingReportId: "report-baseline" }, baselineStatus: "NOT_STARTED", baselineVersion: 0,
  });
  const saved = await service.registerBaseline({ cohortId, actorId: "staff-1", expectedVersion: 0,
    status: "REGISTERED", sampleUnits: [{ permanentId: "TREE-001", unitType: "tree", latitude: 12.66,
      longitude: 123.93, condition: "Healthy", heightMeters: 0.8, diameterCentimeters: 1.2,
      photoReferences: [{ evidenceId: "baseline-photo-001" }] }],
  });
  assert.equal(saved.baselineStatus, "REGISTERED");
  assert.equal(saved.baselineVersion, 1);
  assert.equal(saved.baseline.sampleUnits[0].permanentId, "TREE-001");
  await assert.rejects(() => service.registerBaseline({ cohortId, actorId: "staff-1", expectedVersion: 0,
    status: "REGISTERED", sampleUnits: [{ permanentId: "TREE-002", unitType: "tree", latitude: 12.66, longitude: 123.93 }],
  }), /changed while you were editing/);
});

test("baseline route remains Staff-only", async () => {
  const route = routes.stack.find((layer) => layer.route?.path === "/:id/baseline");
  assert.ok(route);
  const authorize = route.route.stack[1].handle;
  let allowed = false;
  let responseCode = 0;
  authorize({ user: { uid: "participant-1", role: "participant" } }, {
    status(code) { responseCode = code; return this; }, json() {},
  }, () => { allowed = true; });
  assert.equal(allowed, false);
  assert.equal(responseCode, 403);
});
