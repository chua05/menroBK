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

test("new policy plans preserve one configured cohort target, species identity and explicit Admin validity approval", async () => {
  reset();
  const cohortId = service.cohortIdFor("configured-policy-plan"), sampling = { policyVersion: 2, percentage: 20, minimum: 1, firstVisitDelayWeeks: 2, intervalMonths: 12, speciesAllocationProcedure: "Approved allocation record", physicalSelectionProcedure: "Approved field selection record" };
  table("verifiedPlantingCohorts").set(cohortId, { verifiedPlantedQuantity: 10, baselineVersion: 0, source: { plantingDate: "2026-10-01" }, samplingPolicySnapshot: sampling, samplingReadiness: { pending: [] } });
  const payload = { cohortId, actorId: "staff-1", expectedVersion: 0, selectionMethod: "documented-manual", submitForApproval: true,
    selectedSamples: [{ permanentId: "TREE-001", unitType: "tree", species: "Narra", siteReference: "North", selectionReason: "Approved documented procedure" }, { permanentId: "TREE-002", unitType: "tree", species: "Mahogany", siteReference: "South", selectionReason: "Approved documented procedure" }],
    speciesSiteDistribution: [{ species: "Narra", siteReference: "North", sampleIds: ["TREE-001"] }, { species: "Mahogany", siteReference: "South", sampleIds: ["TREE-002"] }] };
  await assert.rejects(service.saveSamplingPlan({ ...payload, selectedSamples: [payload.selectedSamples[0]] }), /exactly/);
  await assert.rejects(service.saveSamplingPlan({ ...payload, speciesSiteDistribution: payload.speciesSiteDistribution.map(row => ({ ...row, species: "Wrong species" })) }), /species and site distribution/);
  await assert.rejects(service.saveSamplingPlan({ ...payload, selectedSamples: payload.selectedSamples.map(row => ({ ...row, unitType: "plot" })) }), /species and site distribution/);
  const saved = await service.saveSamplingPlan(payload); assert.equal(saved.samplingPlan.provisionalTarget, 2); assert.equal(saved.samplingPlan.samplingPolicyVersion, 2);
  const approved = await service.approveSamplingPlan({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: true, estimationEligibilityApproved: true });
  assert.equal(approved.samplingPlan.estimationEligibilityApproved, true); assert.equal(approved.samplingPlanHistory.at(-1).samplingPolicyVersion, 2); assert.equal(approved.samplingPlanHistory.at(-1).estimationEligibilityApproved, true);
});

test("a policy snapshot without a version saves and reviews a plan with an explicit null version", async () => {
  reset();
  const cohortId = service.cohortIdFor("unversioned-policy-plan");
  table("verifiedPlantingCohorts").set(cohortId, { verifiedPlantedQuantity: 10, baselineVersion: 0, source: { plantingDate: "2026-10-01" }, samplingReadiness: { pending: [] },
    samplingPolicySnapshot: { percentage: 10, minimum: 1, firstVisitDelayWeeks: 2, intervalMonths: 12, speciesAllocationProcedure: "Approved", physicalSelectionProcedure: "Approved" } });
  const saved = await service.saveSamplingPlan({ cohortId, actorId: "staff-1", expectedVersion: 0, selectionMethod: "documented-manual", submitForApproval: true,
    selectedSamples: [{ permanentId: "TREE-001", unitType: "tree", species: "Narra", siteReference: "North", selectionReason: "Approved documented procedure" }],
    speciesSiteDistribution: [{ species: "Narra", siteReference: "North", sampleIds: ["TREE-001"] }] });
  assert.equal(saved.samplingPlan.samplingPolicyVersion, null);
  const approved = await service.approveSamplingPlan({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: true });
  assert.equal(approved.samplingPlan.samplingPolicyVersion, null);
});

// T3: outside isolated tests the test-only provisional sampling rule is never accepted.
async function outsideTestMode(fn) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try { await fn(); } finally { process.env.NODE_ENV = previous; }
}
const t3Plan = cohortId => ({ cohortId, actorId: "staff-1", expectedVersion: 0, selectionMethod: "documented-manual", submitForApproval: true,
  selectedSamples: [{ permanentId: "TREE-001", unitType: "tree", species: "Narra", siteReference: "Plot A", selectionReason: "Marked permanent sample" }],
  speciesSiteDistribution: [{ species: "Narra", siteReference: "Plot A", sampleIds: ["TREE-001"] }] });

test("outside test mode a cohort without an approved policy snapshot cannot save a sampling plan", async () => {
  reset();
  const cohortId = service.cohortIdFor("report-no-snapshot");
  table("verifiedPlantingCohorts").set(cohortId, { source: { plantingReportId: "report-no-snapshot" }, verifiedPlantedQuantity: 10, baselineStatus: "NOT_STARTED", baselineVersion: 0 });
  await outsideTestMode(async () => {
    await assert.rejects(service.saveSamplingPlan(t3Plan(cohortId)), error => error.code === "SAMPLING_POLICY_SNAPSHOT_REQUIRED" && error.status === 409);
  });
  assert.equal(table("verifiedPlantingCohorts").get(cohortId).samplingPlan, undefined);
});

test("outside test mode a pending test-only plan cannot be approved but can still be returned", async () => {
  reset();
  const cohortId = service.cohortIdFor("report-legacy-plan");
  table("verifiedPlantingCohorts").set(cohortId, { source: { plantingReportId: "report-legacy-plan" }, verifiedPlantedQuantity: 10, baselineStatus: "NOT_STARTED", baselineVersion: 0 });
  await service.saveSamplingPlan(t3Plan(cohortId));
  assert.equal(table("verifiedPlantingCohorts").get(cohortId).samplingPlan.provisionalPolicy, "test-only-ceil-10-percent-min-1-v1");
  await outsideTestMode(async () => {
    await assert.rejects(service.approveSamplingPlan({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: true }), error => error.code === "TEST_ONLY_SAMPLING_POLICY_REJECTED");
    assert.equal(table("verifiedPlantingCohorts").get(cohortId).samplingPlan.status, "PENDING_ADMIN_APPROVAL");
    const returned = await service.approveSamplingPlan({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: false, remarks: "Awaiting MENRO policy" });
    assert.equal(returned.samplingPlan.status, "RETURNED");
  });
});

// B2: first monitoring visit acts as the sampling plan plus baseline registration.
const { FIRST_VISIT_BASELINE_POLICY_ID } = require("../src/config/firstVisitBaseline");
const firstVisitCohort = (overrides = {}) => ({ id: "VPC-first-visit-001", verifiedPlantedQuantity: 25, baselineStatus: "NOT_STARTED", baselineVersion: 0, baseline: null,
  source: { plantingReportId: "report-fv", siteId: "site-7", species: [{ inventoryId: "inv-1", species: "Narra", releasedQuantity: 25, verifiedPlantedQuantity: 25 }] }, ...overrides });
const deepFreeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
async function withFirstVisitFlag(value, fn) {
  const previous = process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED;
  if (value === undefined) delete process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED; else process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED = value;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED; else process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED = previous;
  }
}

test("first-visit plan: a 25-tree single-species cohort gives 3 report-numbered Tree IDs in a valid DRAFT plan", () => {
  const cohort = deepFreeze(firstVisitCohort());
  const { samplingPlan, historyEntry } = service._test.prepareFirstVisitPlan({ cohort, reportNumber: "RPT-2026-020", actorId: "staff-1", now: "NOW" });
  assert.deepEqual(samplingPlan.selectedSamples.map(s => s.permanentId), ["RPT-2026-020-T001", "RPT-2026-020-T002", "RPT-2026-020-T003"]);
  assert.equal(samplingPlan.schemaVersion, 1);
  assert.equal(samplingPlan.version, 1);
  assert.equal(samplingPlan.status, "DRAFT");
  assert.equal(samplingPlan.origin, "FIRST_VISIT");
  assert.equal(samplingPlan.provisionalPolicy, FIRST_VISIT_BASELINE_POLICY_ID);
  assert.equal(samplingPlan.provisionalTarget, 3);
  assert.equal(samplingPlan.selectionMethod, "documented-manual");
  assert.equal(samplingPlan.notes, "");
  assert.equal(samplingPlan.submittedBy, null);
  assert.equal(samplingPlan.submittedAt, null);
  assert.equal(samplingPlan.createdBy, "staff-1");
  assert.equal(samplingPlan.createdAt, "NOW");
  assert.deepEqual(samplingPlan.selectedSamples[0], { permanentId: "RPT-2026-020-T001", unitType: "tree", species: "Narra", siteReference: "site-7",
    selectionReason: "Physically selected by Staff during the first monitoring visit" });
  // Re-validating through the existing normalisers is a no-op.
  assert.deepEqual(service._test.normalizePlannedSamples(samplingPlan.selectedSamples, 3), samplingPlan.selectedSamples);
  assert.deepEqual(service._test.normalizeDistribution(samplingPlan.speciesSiteDistribution, samplingPlan.selectedSamples), samplingPlan.speciesSiteDistribution);
  assert.deepEqual(samplingPlan.speciesSiteDistribution, [{ species: "Narra", siteReference: "site-7", sampleIds: ["RPT-2026-020-T001", "RPT-2026-020-T002", "RPT-2026-020-T003"] }]);
  assert.equal(historyEntry.status, "DRAFT");
  assert.equal(historyEntry.provisionalPolicy, FIRST_VISIT_BASELINE_POLICY_ID);
  assert.deepEqual(historyEntry.selectedSamples, samplingPlan.selectedSamples);
});

test("first-visit plan: a missing or unsafe reportNumber falls back to the cohort id", () => {
  for (const reportNumber of [undefined, "", "RPT 2026/020"]) {
    const { samplingPlan } = service._test.prepareFirstVisitPlan({ cohort: firstVisitCohort(), reportNumber, actorId: "staff-1", now: "NOW" });
    assert.deepEqual(samplingPlan.selectedSamples.map(s => s.permanentId), ["VPC-first-visit-001-T001", "VPC-first-visit-001-T002", "VPC-first-visit-001-T003"]);
  }
  const { samplingPlan } = service._test.prepareFirstVisitPlan({ cohort: firstVisitCohort({ id: undefined }), cohortId: "VPC-explicit", actorId: "staff-1", now: "NOW" });
  assert.equal(samplingPlan.selectedSamples[0].permanentId, "VPC-explicit-T001");
});

test("first-visit plan: refuses multi-species, existing plan or baseline, and zero quantity with 409 codes", () => {
  const prepare = cohort => () => service._test.prepareFirstVisitPlan({ cohort, reportNumber: "RPT-2026-020", actorId: "staff-1", now: "NOW" });
  const is = code => error => error.status === 409 && error.code === code;
  assert.throws(prepare(firstVisitCohort({ source: { siteId: "site-7", species: [
    { inventoryId: "inv-1", species: "Narra", releasedQuantity: 15, verifiedPlantedQuantity: 15 },
    { inventoryId: "inv-2", species: "Mahogany", releasedQuantity: 10, verifiedPlantedQuantity: 10 }] } })), is("SPECIES_ALLOCATION_PENDING"));
  assert.throws(prepare(firstVisitCohort({ samplingPlan: { version: 1, status: "DRAFT" } })), is("FIRST_VISIT_BASELINE_NOT_APPLICABLE"));
  assert.throws(prepare(firstVisitCohort({ baseline: { approvalStatus: "APPROVED" } })), is("FIRST_VISIT_BASELINE_NOT_APPLICABLE"));
  assert.throws(prepare(firstVisitCohort({ verifiedPlantedQuantity: 0 })), is("VERIFIED_QUANTITY_UNAVAILABLE"));
  assert.throws(prepare(firstVisitCohort({ verifiedPlantedQuantity: undefined })), is("VERIFIED_QUANTITY_UNAVAILABLE"));
  // A species with zero planted quantity does not count toward the allocation.
  const single = service._test.prepareFirstVisitPlan({ cohort: firstVisitCohort({ source: { siteId: "site-7", species: [
    { inventoryId: "inv-1", species: "Narra", releasedQuantity: 25, verifiedPlantedQuantity: 25 },
    { inventoryId: "inv-2", species: "Mahogany", releasedQuantity: 5, verifiedPlantedQuantity: 0 }] } }), reportNumber: "RPT-2026-020", actorId: "staff-1", now: "NOW" });
  assert.equal(single.samplingPlan.selectedSamples[0].species, "Narra");
});

test("first-visit plan transitions: submit, return requires remarks, approve; inputs are never mutated", () => {
  const { samplingPlan, historyEntry } = service._test.prepareFirstVisitPlan({ cohort: firstVisitCohort(), reportNumber: "RPT-2026-020", actorId: "staff-1", now: "T0" });
  const draft = deepFreeze({ samplingPlan, samplingPlanHistory: [historyEntry] });
  const submitted = service._test.planReviewTransition(draft, "PENDING_ADMIN_APPROVAL", "staff-1", "T1");
  assert.equal(submitted.samplingPlan.status, "PENDING_ADMIN_APPROVAL");
  assert.equal(submitted.samplingPlan.submittedBy, "staff-1");
  assert.equal(submitted.samplingPlan.submittedAt, "T1");
  assert.equal(submitted.samplingPlanHistory.length, 2);
  assert.equal(submitted.samplingPlanHistory[1].status, "PENDING_ADMIN_APPROVAL");
  assert.equal(draft.samplingPlan.status, "DRAFT");
  deepFreeze(submitted);
  assert.throws(() => service._test.planReviewTransition(submitted, "RETURNED", "admin-1", "T2", "  "), error => error.code === "REVIEW_REMARKS_REQUIRED");
  const returned = service._test.planReviewTransition(submitted, "RETURNED", "admin-1", "T2", "Re-tag tree 2");
  assert.equal(returned.samplingPlan.status, "RETURNED");
  assert.equal(returned.samplingPlan.reviewedBy, "admin-1");
  assert.equal(returned.samplingPlan.reviewedAt, "T2");
  assert.equal(returned.samplingPlan.reviewRemarks, "Re-tag tree 2");
  const resubmitted = service._test.planReviewTransition(deepFreeze(returned), "PENDING_ADMIN_APPROVAL", "staff-1", "T3");
  assert.deepEqual(resubmitted.samplingPlan.selectedSamples, samplingPlan.selectedSamples);
  const approved = service._test.planReviewTransition(deepFreeze(resubmitted), "APPROVED", "admin-1", "T4");
  assert.equal(approved.samplingPlan.status, "APPROVED");
  assert.equal(approved.samplingPlan.reviewedBy, "admin-1");
  assert.equal(approved.samplingPlan.reviewedAt, "T4");
  assert.equal(approved.samplingPlanHistory.length, 5);
  assert.deepEqual(approved.samplingPlanHistory.map(entry => entry.status), ["DRAFT", "PENDING_ADMIN_APPROVAL", "RETURNED", "PENDING_ADMIN_APPROVAL", "APPROVED"]);
  assert.equal(submitted.samplingPlanHistory.length, 2);
  assert.throws(() => service._test.planReviewTransition(draft, "APPROVED", "admin-1", "T5"), error => error.status === 409);
  assert.throws(() => service._test.planReviewTransition(draft, "BOGUS", "admin-1", "T5"));
});

function firstVisitWithAssessments(overrides = []) {
  const { samplingPlan } = service._test.prepareFirstVisitPlan({ cohort: firstVisitCohort(), reportNumber: "RPT-2026-020", actorId: "staff-1", now: "T0" });
  const cohort = firstVisitCohort({ samplingPlan: { ...samplingPlan, status: "APPROVED" } });
  const conditions = ["Healthy", "Needs Rechecking", "Dead"];
  const assessments = samplingPlan.selectedSamples.map((sample, index) => ({ sampleId: sample.permanentId, condition: conditions[index],
    heightCentimeters: index === 2 ? null : 150 - index * 50, diameterCentimeters: index === 2 ? undefined : 1.2, remarks: `row ${index}`, assessmentRevision: 1,
    evidenceHistory: [
      { revision: 0, privateEvidence: { path: "stale" }, captureSessionId: `stale-${index}`, location: { latitude: 1, longitude: 1 } },
      { revision: 1, privateEvidence: { path: `private/${index}` }, captureSessionId: `session-00${index}`, location: { latitude: 12.6 + index / 100, longitude: 123.9, accuracyMeters: 8 }, linkedAt: "L1" },
    ], ...(overrides[index] || {}) })).reverse();
  return { cohort, visit: { id: "visit-1", createdBy: "staff-1", dateMonitored: "2026-11-20", baselineVersion: 1, sampleAssessments: assessments } };
}

test("baseline from first visit maps units in plan order with current-evidence GPS and no private evidence", () => {
  const { cohort, visit } = firstVisitWithAssessments([{ assessedOn: "2026-11-19" }]);
  deepFreeze(cohort); deepFreeze(visit);
  const result = service._test.buildBaselineFromVisit({ cohort, visit, actorId: "admin-1", now: "T9" });
  assert.equal(result.baselineStatus, "REGISTERED");
  assert.equal(result.baselineVersion, 1);
  const { baseline } = result;
  assert.equal(baseline.registeredBy, "staff-1");
  assert.equal(baseline.registeredAt, "T9");
  assert.equal(baseline.approvedBy, "admin-1");
  assert.equal(baseline.approvedAt, "T9");
  assert.equal(baseline.approvalStatus, "APPROVED");
  assert.deepEqual(baseline.source, { type: "FIRST_VISIT", visitId: "visit-1" });
  assert.deepEqual(baseline.sampleUnits.map(unit => unit.permanentId), ["RPT-2026-020-T001", "RPT-2026-020-T002", "RPT-2026-020-T003"]);
  const [first, second, third] = baseline.sampleUnits;
  assert.equal(first.unitType, "tree");
  assert.equal(first.species, "Narra");
  assert.equal(first.condition, "Healthy");
  assert.equal(first.heightMeters, 1.5);
  assert.equal(first.diameterCentimeters, 1.2);
  assert.equal(first.latitude, 12.6);
  assert.equal(first.longitude, 123.9);
  assert.equal(first.captureDate, "2026-11-19");
  assert.equal(first.remarks, "row 0");
  assert.deepEqual(first.photoReferences, [{ evidenceId: "session-000", capturedAt: "L1", sourceVisitId: "visit-1", sourceAssessmentRevision: 1 }]);
  assert.equal(second.condition, "Unknown");
  assert.equal(second.heightMeters, 1);
  assert.equal(second.latitude, 12.61);
  assert.equal(second.captureDate, "2026-11-20");
  assert.equal(third.condition, "Dead");
  assert.equal(third.heightMeters, null);
  assert.equal(third.diameterCentimeters, null);
  assert.ok(!JSON.stringify(result).includes("privateEvidence"));
  assert.ok(!JSON.stringify(result).includes("private/"));
  assert.equal(result.baselineHistoryAppend.length, 2);
  assert.equal(result.baselineHistoryAppend[0].status, "PENDING_ADMIN_APPROVAL");
  assert.equal(result.baselineHistoryAppend[0].version, 1);
  assert.deepEqual(result.baselineHistoryAppend[0].sampleUnits, baseline.sampleUnits);
  assert.equal(result.baselineHistoryAppend[1].status, "APPROVED");
  assert.equal(result.baselineHistoryAppend[1].reviewedBy, "admin-1");
});

test("baseline from first visit refuses missing current evidence, missing GPS and incomplete samples", () => {
  const build = overrides => () => { const { cohort, visit } = firstVisitWithAssessments(overrides); return service._test.buildBaselineFromVisit({ cohort, visit, actorId: "admin-1", now: "T9" }); };
  const is = code => error => error.status === 409 && error.code === code;
  assert.throws(build([{}, { assessmentRevision: 2 }]), is("BASELINE_EVIDENCE_MISSING"));
  assert.throws(build([{}, { evidenceHistory: [] }]), is("BASELINE_EVIDENCE_MISSING"));
  assert.throws(build([{ evidenceHistory: [{ revision: 1, privateEvidence: { path: "p" }, captureSessionId: "session-000" }] }]), is("BASELINE_EVIDENCE_MISSING"));
  assert.throws(build([{ evidenceHistory: [{ revision: 1, captureSessionId: "session-000", location: { latitude: 12.6, longitude: 123.9 } }] }]), is("BASELINE_EVIDENCE_MISSING"));
  assert.throws(() => { const { cohort, visit } = firstVisitWithAssessments(); return service._test.buildBaselineFromVisit({ cohort, visit: { ...visit, sampleAssessments: visit.sampleAssessments.slice(1) }, actorId: "admin-1", now: "T9" }); }, is("BASELINE_INCOMPLETE"));
});

test("baseline from first visit refuses a missing or non-positive baseline version", () => {
  for (const baselineVersion of [undefined, null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    const { cohort, visit } = firstVisitWithAssessments();
    assert.throws(() => service._test.buildBaselineFromVisit({ cohort, visit: { ...visit, baselineVersion }, actorId: "admin-1", now: "T9" }),
      error => error.status === 409 && error.code === "BASELINE_VERSION_INVALID", String(baselineVersion));
  }
});

test("currentEvidenceEntry does not drift from the visit service currentEvidence predicate", () => {
  // Source predicate: src/services/sampleMonitoringVisit.service.js currentEvidence (exported via _test).
  const { currentEvidence } = require("../src/services/sampleMonitoringVisit.service")._test;
  const fixtures = {
    currentWithPrivate: { assessmentRevision: 2, evidenceHistory: [{ revision: 2, privateEvidence: { path: "p" } }] },
    olderRevisionOnly: { assessmentRevision: 2, evidenceHistory: [{ revision: 1, privateEvidence: { path: "p" } }] },
    currentWithoutPrivate: { assessmentRevision: 2, evidenceHistory: [{ revision: 2, captureSessionId: "session-1" }] },
    revisionUndefinedWithZero: { evidenceHistory: [{ revision: 0, privateEvidence: { path: "p" } }] },
    revisionUndefinedWithOne: { evidenceHistory: [{ revision: 1, privateEvidence: { path: "p" } }] },
    noHistory: { assessmentRevision: 0 },
  };
  const expected = { currentWithPrivate: true, olderRevisionOnly: false, currentWithoutPrivate: false, revisionUndefinedWithZero: true, revisionUndefinedWithOne: false, noHistory: false };
  for (const [name, row] of Object.entries(fixtures)) {
    assert.equal(currentEvidence(row), expected[name], `visit predicate: ${name}`);
    assert.equal(service._test.currentEvidenceEntry(row) !== null, currentEvidence(row), `drift: ${name}`);
  }
});

// I1 (fix round 1): a FIRST_VISIT cohort's plan and baseline change only through its first monitoring visit.
// These replace the earlier tests that let the legacy routes save, approve or return a first-visit plan.
function storeFirstVisitCohort(reportId, transform = value => value) {
  const cohortId = service.cohortIdFor(reportId);
  const cohort = firstVisitCohort({ id: cohortId });
  const { samplingPlan, historyEntry } = service._test.prepareFirstVisitPlan({ cohort, reportNumber: "RPT-2026-020", actorId: "staff-1", now: "T0" });
  const { id, ...stored } = cohort;
  table("verifiedPlantingCohorts").set(cohortId, transform({ ...stored, samplingPlan, samplingPlanHistory: [historyEntry] }));
  return cohortId;
}
const firstVisitActive = error => error.status === 409 && error.code === "FIRST_VISIT_BASELINE_ACTIVE";
const planPayload = (cohortId, plan) => ({ cohortId, actorId: "staff-1", expectedVersion: plan.version, selectionMethod: "documented-manual", submitForApproval: true,
  selectedSamples: plan.selectedSamples, speciesSiteDistribution: plan.speciesSiteDistribution });

test("I1: PUT /sampling-plan refuses a FIRST_VISIT plan in every status, with the flag on or off, without writing", async () => {
  for (const flag of ["true", undefined]) {
    for (const status of ["DRAFT", "RETURNED", "PENDING_ADMIN_APPROVAL", "APPROVED"]) {
      reset();
      const cohortId = storeFirstVisitCohort(`report-i1-save-${status}`, value => ({ ...value, samplingPlan: { ...value.samplingPlan, status } }));
      const before = JSON.stringify(table("verifiedPlantingCohorts").get(cohortId));
      await withFirstVisitFlag(flag, async () => {
        await assert.rejects(service.saveSamplingPlan(planPayload(cohortId, table("verifiedPlantingCohorts").get(cohortId).samplingPlan)), firstVisitActive, `${flag} ${status}`);
      });
      assert.equal(JSON.stringify(table("verifiedPlantingCohorts").get(cohortId)), before);
    }
  }
});

test("I1: plan approve and return refuse a pending FIRST_VISIT plan, with the flag on or off", async () => {
  for (const flag of ["true", undefined]) {
    reset();
    const cohortId = storeFirstVisitCohort(`report-i1-approve-${flag}`, value => ({ ...value,
      ...service._test.planReviewTransition(value, "PENDING_ADMIN_APPROVAL", "staff-1", "T1") }));
    await withFirstVisitFlag(flag, async () => {
      await assert.rejects(service.approveSamplingPlan({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: true }), firstVisitActive);
      await assert.rejects(service.approveSamplingPlan({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: false, remarks: "Return" }), firstVisitActive);
    });
    assert.equal(table("verifiedPlantingCohorts").get(cohortId).samplingPlan.status, "PENDING_ADMIN_APPROVAL");
  }
});

test("I1: after the first visit locks the baseline, baseline registration and review are refused", async () => {
  reset();
  const cohortId = storeFirstVisitCohort("report-i1-baseline", value => ({ ...value, samplingPlan: { ...value.samplingPlan, status: "APPROVED" },
    baselineVersion: 1, baselineStatus: "REGISTERED", baseline: { approvalStatus: "APPROVED", sampleUnits: [] } }));
  const before = JSON.stringify(table("verifiedPlantingCohorts").get(cohortId));
  await withFirstVisitFlag("true", async () => {
    await assert.rejects(service.registerBaseline({ cohortId, actorId: "staff-1", expectedVersion: 1, status: "REGISTERED",
      sampleUnits: [{ permanentId: "RPT-2026-020-T001", unitType: "tree", latitude: 12.65, longitude: 123.91, condition: "Healthy", captureDate: "2026-11-02", photoReferences: [{ evidenceId: "photo-1" }] }] }), firstVisitActive);
    await assert.rejects(service.approveBaseline({ cohortId, actorId: "admin-1", expectedVersion: 1, approve: true }), firstVisitActive);
  });
  assert.equal(JSON.stringify(table("verifiedPlantingCohorts").get(cohortId)), before);
});
