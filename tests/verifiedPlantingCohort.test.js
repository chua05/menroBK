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

test("baseline evidence uses a deterministic private-storage-safe record identifier", () => {
  const first = service._test.baselineEvidenceRecordId("VPC-example", "TREE-001");
  assert.match(first, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(first, service._test.baselineEvidenceRecordId("VPC-example", "TREE-001"));
  assert.notEqual(first, service._test.baselineEvidenceRecordId("VPC-example", "TREE-002"));
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
    source: { plantingReportId: "report-baseline" }, verifiedPlantedQuantity: 10,
    baselineStatus: "NOT_STARTED", baselineVersion: 0,
  });
  await service.saveSamplingPlan({ cohortId, actorId: "staff-1", expectedVersion: 0,
    selectionMethod: "documented-manual", submitForApproval: true,
    selectedSamples: [{ permanentId: "TREE-001", unitType: "tree", species: "Narra", siteReference: "Plot A", selectionReason: "Marked permanent sample" }],
    speciesSiteDistribution: [{ species: "Narra", siteReference: "Plot A", sampleIds: ["TREE-001"] }],
  });
  await service.approveSamplingPlan({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: true });
  const saved = await service.registerBaseline({ cohortId, actorId: "staff-1", expectedVersion: 0,
    status: "REGISTERED", sampleUnits: [{ permanentId: "TREE-001", unitType: "tree", latitude: 12.66,
      longitude: 123.93, condition: "Healthy", heightMeters: 0.8, diameterCentimeters: 1.2,
      photoReferences: [{ evidenceId: "baseline-photo-001" }], captureDate: "2026-11-01" }],
  });
  assert.equal(saved.baselineStatus, "REGISTERED");
  assert.equal(saved.baselineVersion, 1);
  assert.equal(saved.baseline.sampleUnits[0].permanentId, "TREE-001");
  await assert.rejects(() => service.registerBaseline({ cohortId, actorId: "staff-1", expectedVersion: 0,
    status: "REGISTERED", sampleUnits: [{ permanentId: "TREE-001", unitType: "tree", latitude: 12.66, longitude: 123.93,
      condition: "Healthy", captureDate: "2026-11-01", photoReferences: [{ evidenceId: "baseline-photo-002" }] }],
  }), /changed while you were editing/);
});

test("Phase 2 uses a documented test-only ten percent target and preserves plan revisions", async () => {
  reset();
  const cohortId = service.cohortIdFor("report-plan");
  table("verifiedPlantingCohorts").set(cohortId, { verifiedPlantedQuantity: 35, baselineVersion: 0 });
  const plan = await service.saveSamplingPlan({ cohortId, actorId: "staff-1", expectedVersion: 0,
    selectionMethod: "stratified", submitForApproval: true,
    selectedSamples: [
      { permanentId: "TREE-001", unitType: "tree", species: "Narra", siteReference: "North", selectionReason: "Species stratum" },
      { permanentId: "TREE-002", unitType: "tree", species: "Narra", siteReference: "North", selectionReason: "Species stratum" },
      { permanentId: "TREE-003", unitType: "tree", species: "Mahogany", siteReference: "South", selectionReason: "Species stratum" },
      { permanentId: "TREE-004", unitType: "tree", species: "Mahogany", siteReference: "South", selectionReason: "Species stratum" },
    ],
    speciesSiteDistribution: [
      { species: "Narra", siteReference: "North", sampleIds: ["TREE-001", "TREE-002"] },
      { species: "Mahogany", siteReference: "South", sampleIds: ["TREE-003", "TREE-004"] },
    ], notes: "Provisional test plan",
  });
  assert.equal(plan.samplingPlan.provisionalTarget, 4);
  assert.equal(plan.samplingPlan.provisionalPolicy, "test-only-ceil-10-percent-min-1-v1");
  const reviewed = await service.approveSamplingPlan({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: true });
  assert.equal(reviewed.samplingPlan.status, "APPROVED");
  assert.equal(reviewed.samplingPlanHistory.length, 2);
});

test("Phase 2 rejects unapproved sample replacements and preserves baseline review history", async () => {
  reset();
  const cohortId = service.cohortIdFor("report-replacement");
  table("verifiedPlantingCohorts").set(cohortId, { verifiedPlantedQuantity: 1, baselineVersion: 0,
    samplingPlan: { version: 1, status: "APPROVED", selectedSamples: [{ permanentId: "TREE-001" }] }, samplingPlanHistory: [] });
  await assert.rejects(() => service.registerBaseline({ cohortId, actorId: "staff-1", expectedVersion: 0, sampleUnits: [{
    permanentId: "TREE-002", unitType: "tree", latitude: 12.66, longitude: 123.93, condition: "Healthy", captureDate: "2026-11-01", photoReferences: [{ evidenceId: "photo-001" }],
  }] }), /must match the Admin-approved sampling plan/);
  await service.registerBaseline({ cohortId, actorId: "staff-1", expectedVersion: 0, sampleUnits: [{
    permanentId: "TREE-001", unitType: "tree", latitude: 12.66, longitude: 123.93, condition: "Healthy", captureDate: "2026-11-01", photoReferences: [{ evidenceId: "photo-001" }],
  }] });
  const approved = await service.approveBaseline({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: true });
  assert.equal(approved.baseline.approvalStatus, "APPROVED");
  assert.equal(approved.baselineHistory.length, 2);
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

test("sampling-plan approval route remains Admin-only", () => {
  const route = routes.stack.find((layer) => layer.route?.path === "/:id/sampling-plan/approve");
  assert.ok(route);
  const authorize = route.route.stack[1].handle;
  let allowed = false;
  let responseCode = 0;
  authorize({ user: { uid: "staff-1", role: "staff" } }, {
    status(code) { responseCode = code; return this; }, json() {},
  }, () => { allowed = true; });
  assert.equal(allowed, false);
  assert.equal(responseCode, 403);
});
