const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryFirestore } = require("./helpers/evidenceQuotaMemory");
const validation = require("../src/services/sampleMonitoringValidation");
function setup(status = "DRAFT") {
  const f = memoryFirestore();
  const visit = { createdBy: "owner", cohortId: "cohort", siteId: "site", baselineVersion: 1, samplingPlanVersion: 1,
    version: 0, status, visitDate: "2099-02-01", sampleAssessments: [{ sampleId: "TREE-001", condition: "Healthy", evidenceHistory: [{ revision: 0 }] }], history: [] };
  const cohort = { source: { siteId: "site" }, baselineVersion: 1, samplingPlan: { version: 1, status: "APPROVED" },
    baseline: { approvalStatus: "APPROVED", sampleUnits: [{ permanentId: "TREE-001" }] } };
  f.records("sampleMonitoringVisits").set("visit", visit);
  f.records("verifiedPlantingCohorts").set("cohort", cohort);
  // B5: the visit view context reads the cohort's visits (history and map markers) outside any transaction.
  const baseCollection = f.db.collection.bind(f.db);
  f.db.collection = name => name !== "sampleMonitoringVisits" ? baseCollection(name) : { ...baseCollection(name), where: (field, op, value) => ({
    get: async () => ({ docs: [...f.records(name)].filter(([, row]) => op === "==" && row[field] === value).map(([id, row]) => ({ id, data: () => row })) }) }) };
  require.cache[require.resolve("../src/config/firebase")] = { exports: { db: f.db } };
  require.cache[require.resolve("../src/config/verifiedPlantingCohort")] = { exports: { resolveVerifiedPlantingCohortConfig: () => ({ enabled: true }) } };
  delete require.cache[require.resolve("../src/services/sampleMonitoringVisit.service")];
  return { ...f, visit, cohort, service: require("../src/services/sampleMonitoringVisit.service"),
    save: { visitId: "visit", actorId: "owner", actorRole: "staff", expectedVersion: 0, assessments: [{ sampleId: "TREE-001", condition: "Healthy" }] } };
}
test("measurement parsing preserves empty/null and nonnegative finite values without inventing biological limits", () => {
  for (const value of [undefined, null, "", "  "]) assert.equal(validation.measurement(value), null);
  for (const value of [0, 12.5, "120", " 1.5 ", "1e2"]) assert.equal(validation.measurement(value), Number(value));
  for (const value of [-2, "-0.1", NaN, Infinity, -Infinity, "NaN", "Infinity", "2cm", true, [], {}, "0x10"]) assert.throws(() => validation.measurement(value), { status: 400 });
});
test("save rejects coerced versions and nonboolean submit without writes", async () => {
  for (const changed of [{ expectedVersion: null }, { expectedVersion: "0" }, { expectedVersion: -1 }, { expectedVersion: 0.5 }, { submit: "false" }]) {
    const f = setup(); await assert.rejects(f.service.save({ ...f.save, ...changed }), { status: 400 });
    assert.equal(f.records("sampleMonitoringVisits").get("visit").version, 0);
  }
});
test("review rejects truthy strings, missing decisions, blank reasons and coerced versions", async () => {
  for (const changed of [{ approve: "false" }, { approve: undefined }, { approve: false, reasons: " " }, { expectedVersion: "0" }, { expectedVersion: null }]) {
    const f = setup("PENDING_ADMIN_APPROVAL");
    await assert.rejects(f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: true, ...changed }), { status: 400 });
    assert.equal(f.records("sampleMonitoringVisits").get("visit").status, "PENDING_ADMIN_APPROVAL");
  }
  const f = setup("PENDING_ADMIN_APPROVAL");
  assert.equal((await f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: false, reasons: "Correct assessment." })).status, "RETURNED");
});
test("save and review reject transactional site, plan and baseline changes", async () => {
  for (const mutate of [c => c.source.siteId = "other", c => c.baselineVersion++, c => c.samplingPlan.version++, c => c.baseline.approvalStatus = "RETURNED"]) {
    const f = setup(); mutate(f.cohort);
    await assert.rejects(f.service.save(f.save), { status: 409 });
    f.visit.status = "PENDING_ADMIN_APPROVAL";
    await assert.rejects(f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: true }), { status: 409 });
  }
});
test("forged references and invalid numbers cannot replace authoritative evidence", async () => {
  for (const changed of [{ baselineReference: { sampleId: "OTHER" } }, { previousAssessmentReference: { visitId: "forged" } }, { heightCentimeters: "NaN" }]) {
    const f = setup(); await assert.rejects(f.service.save({ ...f.save, assessments: [{ ...f.save.assessments[0], ...changed }] }));
    assert.equal(f.records("sampleMonitoringVisits").get("visit").sampleAssessments[0].evidenceHistory.length, 1);
  }
  const f = setup(); const saved = await f.service.save(f.save);
  assert.deepEqual(saved.sampleAssessments[0].baselineReference, { sampleId: "TREE-001" });
  assert.equal(saved.sampleAssessments[0].previousAssessmentReference, null);
  assert.equal(saved.sampleAssessments[0].heightCentimeters, null);
});
test("historical references derive from a matching approved prior visit", async () => {
  const f = setup(); f.visit.priorVisitId = "prior";
  f.records("sampleMonitoringVisits").set("prior", { ...f.visit, visitDate: "2099-01-01", status: "APPROVED", sampleAssessments: [{ sampleId: "TREE-001", condition: "Needs Rechecking", remarks: "Search again" }] });
  const saved = await f.service.save(f.save);
  assert.deepEqual(saved.sampleAssessments[0].previousAssessmentReference, { visitId: "prior", sampleId: "TREE-001", condition: "Needs Rechecking", remarks: "Search again", investigationOutcome: null });
});
test("invalid legacy pending measurements require correction, not approval", async () => {
  const f = setup("PENDING_ADMIN_APPROVAL"); f.visit.sampleAssessments[0].heightCentimeters = Infinity;
  await assert.rejects(f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: true }), { status: 400 });
  assert.equal((await f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: false, reasons: "Correct the measurement." })).status, "RETURNED");
});
test("approval rejects forged persisted references without rewriting legacy history", async () => {
  const f = setup("PENDING_ADMIN_APPROVAL");
  f.visit.sampleAssessments[0].baselineReference = { sampleId: "OTHER" };
  await assert.rejects(f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: true }), { status: 409 });
  assert.equal(f.records("sampleMonitoringVisits").get("visit").status, "PENDING_ADMIN_APPROVAL");
  assert.equal(f.records("sampleMonitoringVisits").get("visit").sampleAssessments[0].evidenceHistory.length, 1);
});

// ---- B3: visit 1 (registers the baseline) under the strict transactional double (reads before writes) ----
function firstVisitSetup() {
  const f = setup("DRAFT");
  const evidence = index => [{ revision: 0, privateEvidence: { objectName: `p-${index}` }, captureSessionId: `cap-${index}`, location: { latitude: 13, longitude: 124, accuracyMeters: 5 } }];
  Object.assign(f.visit, { registersBaseline: true, visitNumber: 1, visitDate: "2026-11-01", scheduledDueDate: "2026-11-01", openingDate: "2026-11-01",
    sampleAssessments: [{ sampleId: "RPT-1-T001", assessmentRevision: 0, evidenceHistory: evidence(0) }] });
  Object.assign(f.cohort, { baselineVersion: 0, baseline: null, samplingPlanHistory: [],
    samplingPlan: { version: 1, status: "DRAFT", origin: "FIRST_VISIT", provisionalPolicy: "menro-ceil-10-percent-first-visit-baseline-v1", provisionalTarget: 1,
      selectedSamples: [{ permanentId: "RPT-1-T001", unitType: "tree", species: "Narra", siteReference: "site", selectionReason: "x" }] } });
  f.save.assessments = [{ sampleId: "RPT-1-T001", condition: "Healthy", heightCentimeters: 50, stemDiameterMillimeters: 5 }];
  // Fix round 1 (M1): submit and approval re-read the verified report and site.
  Object.assign(f.cohort, { verifiedPlantedQuantity: 10 }); f.cohort.source.plantingReportId = "rpt";
  f.records("plantingReports").set("rpt", { reportNumber: "RPT-1", verificationStatus: "Approved", quantityPlanted: 10, siteId: "site" });
  f.records("sites").set("site", { status: "active" });
  // B4: submission reads the active Admins (existing notification infrastructure) inside the same transaction.
  const collection = f.db.collection.bind(f.db);
  f.db.collection = name => name !== "users" ? collection(name) : { ...collection(name), where: (field, op, value) => ({
    get: async () => ({ docs: [...f.records("users")].filter(([, user]) => user[field] === value).map(([id, user]) => ({ id, data: () => user })) }) }) };
  f.records("users").set("admin-1", { role: "admin" });
  delete require.cache[require.resolve("../src/services/notification.service")];
  return f;
}
test("B3 first-visit submit and approval write plan, baseline and visit in one transaction after all reads", async () => {
  const prior = process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED;
  process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED = "true";
  try {
    const f = firstVisitSetup();
    const pending = await f.service.save({ ...f.save, submit: true, dateMonitored: "2026-11-02" });
    assert.equal(pending.status, "PENDING_ADMIN_APPROVAL");
    assert.equal(f.records("verifiedPlantingCohorts").get("cohort").samplingPlan.status, "PENDING_ADMIN_APPROVAL");
    assert.deepEqual([...f.records("notifications").keys()], ["sample_monitoring_visit_submitted_visit_1_admin-1"]);
    const approved = await f.service.review({ visitId: "visit", actorId: "admin", expectedVersion: pending.version, approve: true });
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.nextScheduledDueDate, "2026-12-02");
    const cohort = f.records("verifiedPlantingCohorts").get("cohort");
    assert.equal(cohort.samplingPlan.status, "APPROVED");
    assert.equal(cohort.baseline.approvalStatus, "APPROVED");
    assert.equal(cohort.baselineVersion, 1);
    assert.equal(cohort.permanentSampleSchedule.nextScheduledDueDate, "2026-12-02");
    // Approval with missing GPS is refused without any partial write.
    const g = firstVisitSetup(); delete g.visit.sampleAssessments[0].evidenceHistory[0].location;
    Object.assign(g.visit, { status: "PENDING_ADMIN_APPROVAL", dateMonitored: "2026-11-02", sampleAssessments: [{ ...g.visit.sampleAssessments[0], condition: "Healthy" }] });
    g.cohort.samplingPlan.status = "PENDING_ADMIN_APPROVAL";
    await assert.rejects(g.service.review({ visitId: "visit", actorId: "admin", expectedVersion: 0, approve: true }), e => e.code === "CURRENT_SAMPLE_EVIDENCE_REQUIRED");
    assert.equal(g.records("verifiedPlantingCohorts").get("cohort").samplingPlan.status, "PENDING_ADMIN_APPROVAL");
    assert.equal(g.records("verifiedPlantingCohorts").get("cohort").baseline, null);
    assert.equal(g.records("sampleMonitoringVisits").get("visit").status, "PENDING_ADMIN_APPROVAL");
  } finally {
    if (prior === undefined) delete process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED;
    else process.env.PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED = prior;
  }
});
