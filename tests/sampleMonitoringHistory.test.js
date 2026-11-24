// B5: monitoring visit history, approved per-tree timeline and tree map marker data (visit view context).
const test = require("node:test"), assert = require("node:assert/strict");
const tables = new Map(), table = n => tables.get(n) || (tables.set(n, new Map()), tables.get(n));
const ref = (c, id) => ({ id, collectionName: c, get: async () => { const v = table(c).get(id); return { id, exists: v !== undefined, data: () => v, ref: ref(c, id) }; } });
const db = { collection: c => { const filters = []; const query = { doc: id => ref(c, id), where: (f, o, x) => { filters.push([f, o, x]); return query; },
  orderBy: () => query, limit: () => query,
  get: async () => { const rows = [...table(c)].filter(([, v]) => filters.every(([f, o, x]) => o === "==" && v[f] === x));
    return { docs: rows.map(([id, v]) => ({ id, data: () => v, ref: ref(c, id) })), empty: rows.length === 0 }; } }; return query; },
runTransaction: async fn => { const w = [], tx = { get: r => r.get(), create: (r, v) => { if (table(r.collectionName).has(r.id)) throw Object.assign(new Error("already exists"), { code: 6 }); w.push([r, v, false]); }, update: (r, v) => w.push([r, v, true]) };
  await fn(tx); w.forEach(([r, v, u]) => table(r.collectionName).set(r.id, u ? { ...table(r.collectionName).get(r.id), ...v } : v)); } };
require.cache[require.resolve("../src/config/firebase")] = { exports: { db } };
require.cache[require.resolve("../src/config/verifiedPlantingCohort")] = { exports: { resolveVerifiedPlantingCohortConfig: () => ({ enabled: true, provisionalSamplingAllowed: true, provisionalSamplingPolicy: "test-only-ceil-10-percent-min-1-v1" }) } };
const s = require("../src/services/sampleMonitoringVisit.service");
const schedule = require("../src/config/permanentSampleSchedule");

const IDS = ["RPT-2026-020-T001", "RPT-2026-020-T002", "RPT-2026-020-T003"];
const today = () => schedule.dateOnlyInManila();
const shiftDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const monthStart = n => { const [y, m] = today().split("-").map(Number); const a = y * 12 + m - 1 - n; return `${Math.floor(a / 12)}-${String(a % 12 + 1).padStart(2, "0")}-01`; };
async function withEnv(vars, fn) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) { prior[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const FLAG = { PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "true" };
const SCHED = { ...FLAG, PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" };
function seed() {
  tables.clear();
  table("verifiedPlantingCohorts").set("fv", { source: { siteId: "site", plantingReportId: "rpt", plantingDate: "2020-01-01",
    species: [{ inventoryId: "inv-1", species: "Narra", releasedQuantity: 25, verifiedPlantedQuantity: 25 }] },
  verifiedPlantedQuantity: 25, baselineStatus: "NOT_STARTED", baselineVersion: 0, baseline: null });
  table("plantingReports").set("rpt", { reportNumber: "RPT-2026-020", verificationStatus: "Approved", quantityPlanted: 25, siteId: "site" });
  table("sites").set("site", { siteName: "Site", barangay: "Bical", status: "active" });
  table("users").set("admin-1", { role: "admin", fullName: "Admin One" });
  table("users").set("staff", { role: "staff" });
}
// Verified capture-session evidence at a distinct latitude base per visit, so marker sources are distinguishable.
function attach(visitId, date, latBase, only = null) {
  const row = table("sampleMonitoringVisits").get(visitId);
  row.sampleAssessments.forEach((a, i) => {
    if (only && !only.includes(a.sampleId)) return;
    a.evidenceHistory = [...(a.evidenceHistory || []), { revision: Number(a.assessmentRevision || 0), privateEvidence: { objectName: `p-${visitId}-${i}` },
      captureSessionId: `cap-${visitId}-${i}-${a.assessmentRevision || 0}`, linkedAt: `${date}T04:00:00.000Z`,
      location: { latitude: latBase + i / 1000, longitude: 124, accuracyMeters: 5 } }];
  });
}
const healthy = (extra = {}) => IDS.map(sampleId => ({ sampleId, condition: "Healthy", heightCentimeters: 45, stemDiameterMillimeters: 6, ...(extra[sampleId] || {}) }));
const save = (visit, assessments, extra = {}) => s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff",
  expectedVersion: table("sampleMonitoringVisits").get(visit.id).version, assessments, ...extra });
const view = visitId => s.get(visitId, { actorId: "staff", actorRole: "staff" });
const approve = async (visit, assessments, date) => {
  const pending = await save(visit, assessments, { submit: true, dateMonitored: date });
  return s.review({ visitId: visit.id, actorId: "admin-1", expectedVersion: pending.version, approve: true });
};
// Visit 1 approved (all Healthy), then visit 2 created at its due date.
async function twoVisits() {
  const v1date = monthStart(11);
  const v1 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: v1date }); attach(v1.id, v1date, 13);
  await approve(v1, healthy(), v1date);
  const due2 = schedule.addCalendarMonths(v1date, 1);
  const v2 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: due2 });
  return { v1, v1date, v2, due2 };
}

test("B5 history: visits 1 and 2 approved give ordered rows with server-recomputed counts plus the next scheduled row", async () => {
  await withEnv(SCHED, async () => {
    seed();
    const { v1, v1date, v2, due2 } = await twoVisits();
    attach(v2.id, due2, 14);
    await approve(v2, healthy({ [IDS[1]]: { condition: "Damaged" }, [IDS[2]]: { condition: "Dead", mortalityCause: "Flooding", remarks: "Washed out" } }), due2);
    // Stored client-shaped totals are never trusted: corrupt them and the rows still come from the assessments.
    table("sampleMonitoringVisits").get(v1.id).summary = { healthy: 99, damaged: 99, confirmedDead: 99, survivalRate: 1 };
    const context = (await view(v2.id)).visitContext;
    const due3 = schedule.addCalendarMonths(due2, 3);
    assert.deepEqual(context.history, [
      { visitId: v1.id, visitNumber: 1, scheduledDueDate: v1date, visitDate: v1date, dateMonitored: v1date, status: "APPROVED",
        healthy: 3, damaged: 0, confirmedDead: 0, needsRechecking: 0, notAssessed: 0, survivalRate: 100, survivalStatus: "COMPLETE" },
      { visitId: v2.id, visitNumber: 2, scheduledDueDate: due2, visitDate: due2, dateMonitored: due2, status: "APPROVED",
        healthy: 1, damaged: 1, confirmedDead: 1, needsRechecking: 0, notAssessed: 0, survivalRate: 66.67, survivalStatus: "COMPLETE" },
      { visitId: null, visitNumber: 3, scheduledDueDate: due3, visitDate: null, dateMonitored: null, status: "SCHEDULED",
        availability: due3 > today() ? "NOT_YET_AVAILABLE" : "AVAILABLE",
        healthy: null, damaged: null, confirmedDead: null, needsRechecking: null, notAssessed: null, survivalRate: null, survivalStatus: null },
    ]);
    // The same history is returned when viewing visit 1, and no scheduled row is added once visit 3 exists.
    assert.deepEqual((await view(v1.id)).visitContext.history, context.history);
    const v3 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: due3 });
    const after = (await view(v3.id)).visitContext.history;
    assert.deepEqual(after.map(row => [row.visitNumber, row.status]), [[1, "APPROVED"], [2, "APPROVED"], [3, "DRAFT"]]);
    assert.equal(after[2].visitId, v3.id);
    assert.equal(after.filter(row => row.status === "SCHEDULED").length, 0);
  });
});

test("B5 history: the next row is AVAILABLE on or after its Manila due date and NOT_YET_AVAILABLE before it", async () => {
  await withEnv(FLAG, async () => {
    seed();
    const v1date = monthStart(2);
    const v1 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: v1date, testOnly: true }); attach(v1.id, v1date, 13);
    await approve(v1, healthy(), v1date);
    const cohort = table("verifiedPlantingCohorts").get("fv");
    assert.equal(cohort.permanentSampleSchedule.nextVisitNumber, 2);
    const next = async () => (await view(v1.id)).visitContext.history.at(-1);
    for (const [date, availability] of [[shiftDays(today(), 1), "NOT_YET_AVAILABLE"], [today(), "AVAILABLE"], [shiftDays(today(), -1), "AVAILABLE"]]) {
      cohort.permanentSampleSchedule = { ...cohort.permanentSampleSchedule, nextScheduledDueDate: date };
      const row = await next();
      assert.equal(row.visitNumber, 2); assert.equal(row.status, "SCHEDULED");
      assert.equal(row.scheduledDueDate, date); assert.equal(row.availability, availability, date);
    }
    // No schedule, no fabricated row.
    delete cohort.permanentSampleSchedule;
    assert.deepEqual((await view(v1.id)).visitContext.history.map(row => row.visitNumber), [1]);
  });
});

test("B5 history: a returned visit shows RETURNED with its recomputed counts, and is excluded from the approved timeline", async () => {
  await withEnv(SCHED, async () => {
    seed();
    const { v1, v2, due2 } = await twoVisits();
    attach(v2.id, due2, 14);
    const pending = await save(v2, healthy({ [IDS[0]]: { condition: "Needs Rechecking", recheckReason: "Tag missing", remarks: "Searched" },
      [IDS[2]]: { condition: "Dead", mortalityCause: "Drought", remarks: "Dry" } }), { submit: true, dateMonitored: due2 });
    await s.review({ visitId: v2.id, actorId: "admin-1", expectedVersion: pending.version, approve: false, reasons: "Recheck tree 1" });
    const context = (await view(v2.id)).visitContext;
    const row = context.history.find(entry => entry.visitId === v2.id);
    assert.deepEqual(row, { visitId: v2.id, visitNumber: 2, scheduledDueDate: due2, visitDate: due2, dateMonitored: due2, status: "RETURNED",
      healthy: 1, damaged: 0, confirmedDead: 1, needsRechecking: 1, notAssessed: 0, survivalRate: null, survivalStatus: "PENDING_INCOMPLETE" });
    // No scheduled row while visit 2 exists (returned visits never advance the schedule).
    assert.equal(context.history.length, 2);
    for (const id of IDS) assert.deepEqual(context.treeTimeline[id].map(entry => entry.visitId), [v1.id]);
  });
});

test("B5 timeline: only approved per-tree assessments appear, ordered by visit; drafts never appear as approved", async () => {
  await withEnv(SCHED, async () => {
    seed();
    const { v1, v1date, v2, due2 } = await twoVisits();
    attach(v2.id, due2, 14);
    await save(v2, healthy({ [IDS[0]]: { condition: "Damaged", heightCentimeters: 70, stemDiameterMillimeters: 9 } }));
    let timeline = (await view(v2.id)).visitContext.treeTimeline;
    assert.deepEqual(Object.keys(timeline).sort(), [...IDS].sort());
    assert.deepEqual(timeline[IDS[0]], [{ visitId: v1.id, visitNumber: 1, assessedOn: v1date, dateMonitored: v1date, condition: "Healthy",
      heightCentimeters: 45, stemDiameterMillimeters: 6, mortalityCause: null, recheckReason: null, remarks: "" }]);
    await approve(v2, healthy({ [IDS[0]]: { condition: "Damaged", heightCentimeters: 70, stemDiameterMillimeters: 9 },
      [IDS[2]]: { condition: "Dead", mortalityCause: "Flooding", remarks: "Washed out" } }), due2);
    timeline = (await view(v2.id)).visitContext.treeTimeline;
    assert.deepEqual(timeline[IDS[0]].map(e => [e.visitNumber, e.condition, e.heightCentimeters, e.stemDiameterMillimeters]), [[1, "Healthy", 45, 6], [2, "Damaged", 70, 9]]);
    assert.deepEqual(timeline[IDS[2]].at(-1), { visitId: v2.id, visitNumber: 2, assessedOn: due2, dateMonitored: due2, condition: "Dead",
      heightCentimeters: null, stemDiameterMillimeters: null, mortalityCause: "Flooding", recheckReason: null, remarks: "Washed out" });
  });
});

test("B5 markers: visit 1 before approval has only DRAFT markers, and only for trees with server-verified current GPS evidence", async () => {
  await withEnv(FLAG, async () => {
    seed();
    const v1 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: today(), testOnly: true });
    // No evidence at all: no markers.
    assert.deepEqual((await view(v1.id)).visitContext.treeMarkers, []);
    attach(v1.id, today(), 13, [IDS[0]]);
    // Tree 2: evidence without GPS gets no marker. Tree 3: an uploaded original awaiting review (unverified GPS) gets no marker.
    const rows = table("sampleMonitoringVisits").get(v1.id).sampleAssessments;
    rows[1].evidenceHistory = [{ revision: 0, privateEvidence: { objectName: "x" }, captureSessionId: "cap-x", linkedAt: `${today()}T04:00:00.000Z`, location: { latitude: null, longitude: 124 } }];
    rows[2].evidenceHistory = [{ revision: 0, privateEvidence: { objectName: "y" }, source: "uploaded-original", evidenceId: "orig-1", capturedAt: `${today()}T03:00:00.000Z`,
      verificationStatus: "NEEDS_ADMIN_REVIEW", location: { latitude: 13.5, longitude: 124.5 } }];
    await save(v1, healthy());
    const markers = (await view(v1.id)).visitContext.treeMarkers;
    assert.deepEqual(markers, [
      { sampleId: IDS[0], species: "Narra", latitude: 13, longitude: 124, kind: "DRAFT", latestApprovedCondition: null,
        visitNumber: 1, assessedOn: today(), heightCentimeters: 45, stemDiameterMillimeters: 6, gpsVerification: "VERIFIED" },
    ]);
    // Evidence for an older assessment revision is not current: no marker.
    table("sampleMonitoringVisits").get(v1.id).sampleAssessments[0].assessmentRevision = 1;
    assert.deepEqual((await view(v1.id)).visitContext.treeMarkers, []);
  });
});

test("B5 markers: later visits show each registered tree once as APPROVED plus a DRAFT marker only for new verified evidence", async () => {
  await withEnv(SCHED, async () => {
    seed();
    const { v1, v1date, v2, due2 } = await twoVisits();
    // Approved visit 1 viewed on its own: APPROVED markers only, at the registered (visit 1 evidence) positions.
    const approvedOnly = (await view(v1.id)).visitContext.treeMarkers;
    assert.deepEqual(approvedOnly.map(m => [m.sampleId, m.kind, m.latitude, m.longitude]), IDS.map((id, i) => [id, "APPROVED", 13 + i / 1000, 124]));
    assert.deepEqual(approvedOnly[0], { sampleId: IDS[0], species: "Narra", latitude: 13, longitude: 124, kind: "APPROVED", latestApprovedCondition: "Healthy",
      visitNumber: 1, assessedOn: v1date, heightCentimeters: 45, stemDiameterMillimeters: 6, gpsVerification: "VERIFIED" });
    attach(v2.id, due2, 14, [IDS[0], IDS[1]]);
    await save(v2, healthy({ [IDS[0]]: { condition: "Damaged", heightCentimeters: 70, stemDiameterMillimeters: 9 } }));
    const markers = (await view(v2.id)).visitContext.treeMarkers;
    const approved = markers.filter(m => m.kind === "APPROVED"), drafts = markers.filter(m => m.kind === "DRAFT");
    // Never a second permanent tree: one APPROVED marker per registered Tree ID, and every marker is a registered Tree ID.
    assert.deepEqual(approved.map(m => m.sampleId), IDS);
    assert.ok(markers.every(m => IDS.includes(m.sampleId)));
    assert.deepEqual(approved.map(m => [m.latitude, m.latestApprovedCondition, m.visitNumber]), IDS.map((_, i) => [13 + i / 1000, "Healthy", 1]));
    // Draft markers come from visit 2's current evidence only (tree 3 has none), and the draft values never feed APPROVED markers.
    assert.deepEqual(drafts.map(m => [m.sampleId, m.latitude, m.visitNumber, m.latestApprovedCondition]), [[IDS[0], 14, 2, "Healthy"], [IDS[1], 14.001, 2, "Healthy"]]);
    assert.equal(drafts[0].heightCentimeters, 70);
    assert.equal(approved[0].heightCentimeters, 45);
    // After visit 2 is approved: APPROVED markers stay at the registered positions with the latest approved values; no drafts remain.
    attach(v2.id, due2, 14, [IDS[2]]);
    await approve(v2, healthy({ [IDS[0]]: { condition: "Damaged", heightCentimeters: 70, stemDiameterMillimeters: 9 } }), due2);
    const final = (await view(v2.id)).visitContext.treeMarkers;
    assert.deepEqual(final.map(m => [m.sampleId, m.kind, m.latitude, m.latestApprovedCondition, m.visitNumber, m.heightCentimeters]),
      [[IDS[0], "APPROVED", 13, "Damaged", 2, 70], [IDS[1], "APPROVED", 13.001, "Healthy", 2, 45], [IDS[2], "APPROVED", 13.002, "Healthy", 2, 45]]);
  });
});

test("B5 legacy: with the first-visit flag off a legacy visit keeps every existing context field (additive only) and never fabricates coordinates", async () => {
  await withEnv({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: undefined, PERMANENT_SAMPLE_SCHEDULE_ENABLED: undefined }, async () => {
    seed();
    table("verifiedPlantingCohorts").set("c", { source: { siteId: "site" }, samplingPlan: { status: "APPROVED", version: 1 },
      baseline: { approvalStatus: "APPROVED", sampleUnits: [
        { permanentId: "TREE-001", latitude: 12.5, longitude: 123.5, condition: "Healthy", heightMeters: 0.5, diameterCentimeters: 0.4, captureDate: "2025-01-01",
          photoReferences: [{ evidenceId: "cap-1", verificationStatus: "VERIFIED" }] },
        { permanentId: "TREE-002", latitude: null, longitude: null, condition: "Healthy", captureDate: "2025-01-01", photoReferences: [{ evidenceId: "manual-2" }] }] } });
    table("sampleMonitoringVisits").set("old", { createdBy: "staff", cohortId: "c", siteId: "site", visitDate: "2025-02-01", status: "DRAFT", version: 0,
      sampleAssessments: [{ sampleId: "TREE-001", condition: null, evidenceHistory: [] }, { sampleId: "TREE-002", condition: null, evidenceHistory: [] }] });
    const context = (await view("old")).visitContext;
    for (const key of ["plantingReportId", "reportNumber", "siteName", "barangay", "plantingDate", "reportStatus", "verifiedPlantedQuantity", "speciesQuantities",
      "planStatus", "baselineStatus", "approvedSampleTarget", "sampleTarget", "registersBaseline", "registeredSampleTrees", "site", "schedule", "samples"]) {
      assert.ok(Object.hasOwn(context, key), key);
    }
    assert.equal(context.registersBaseline, false);
    assert.equal(context.samples.length, 2);
    assert.deepEqual(context.history.map(row => [row.visitId, row.visitNumber, row.status, row.notAssessed, row.survivalRate]), [["old", null, "DRAFT", 2, null]]);
    assert.deepEqual(context.treeTimeline, {});
    // Registered baseline position only; the tree without stored coordinates gets no marker.
    assert.deepEqual(context.treeMarkers, [{ sampleId: "TREE-001", species: null, latitude: 12.5, longitude: 123.5, kind: "APPROVED",
      latestApprovedCondition: "Healthy", visitNumber: null, assessedOn: "2025-01-01", heightCentimeters: 50, stemDiameterMillimeters: 4, gpsVerification: "VERIFIED" }]);
  });
});

test("B5 fix1: Staff see another Staff member's unapproved visit without its id or counts; Admin sees them", async () => {
  await withEnv(SCHED, async () => {
    seed();
    table("users").set("staff-b", { role: "staff" });
    const v1date = monthStart(11);
    const v1 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: v1date }); attach(v1.id, v1date, 13);
    await approve(v1, healthy(), v1date);
    const due2 = schedule.addCalendarMonths(v1date, 1);
    const v2 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff-b", visitDate: due2 });
    await s.save({ actorRole: "staff", visitId: v2.id, actorId: "staff-b", expectedVersion: table("sampleMonitoringVisits").get(v2.id).version,
      assessments: healthy({ [IDS[0]]: { condition: "Damaged" } }) });
    const staffRows = (await view(v1.id)).visitContext.history;
    assert.deepEqual(staffRows[1], { visitId: null, visitNumber: 2, scheduledDueDate: due2, visitDate: due2, dateMonitored: null, status: "DRAFT",
      healthy: null, damaged: null, confirmedDead: null, needsRechecking: null, notAssessed: null, survivalRate: null, survivalStatus: null });
    assert.equal(staffRows[0].visitId, v1.id); assert.equal(staffRows[0].healthy, 3);
    assert.equal(JSON.stringify(staffRows).includes(v2.id), false);
    const adminRows = (await s.get(v1.id, { actorId: "admin-1", actorRole: "admin" })).visitContext.history;
    assert.equal(adminRows[1].visitId, v2.id);
    assert.deepEqual([adminRows[1].healthy, adminRows[1].damaged, adminRows[1].notAssessed, adminRows[1].survivalStatus], [2, 1, 0, "COMPLETE"]);
    // Staff B sees their own open visit in full.
    const ownRows = (await s.get(v2.id, { actorId: "staff-b", actorRole: "staff" })).visitContext.history;
    assert.equal(ownRows[1].visitId, v2.id); assert.equal(ownRows[1].damaged, 1);
  });
});

test("B5 fix1: approved visits bound to an older baseline or plan version are excluded from the timeline and marker values", async () => {
  await withEnv(SCHED, async () => {
    seed();
    const { v1, v1date } = await twoVisits();
    const current = table("sampleMonitoringVisits").get(v1.id);
    const stale = (baselineVersion, samplingPlanVersion, visitNumber) => ({ ...current, status: "APPROVED", baselineVersion, samplingPlanVersion, visitNumber,
      sampleAssessments: current.sampleAssessments.map(row => ({ ...row, condition: "Dead", mortalityCause: "Drought", remarks: "Old" })) });
    table("sampleMonitoringVisits").set("old-baseline", stale(current.baselineVersion - 1, current.samplingPlanVersion, 7));
    table("sampleMonitoringVisits").set("old-plan", stale(current.baselineVersion, current.samplingPlanVersion + 1, 8));
    const context = (await view(v1.id)).visitContext;
    for (const id of IDS) assert.deepEqual(context.treeTimeline[id].map(entry => entry.visitId), [v1.id]);
    assert.deepEqual(context.treeMarkers.filter(m => m.kind === "APPROVED").map(m => [m.latestApprovedCondition, m.visitNumber, m.assessedOn]),
      IDS.map(() => ["Healthy", 1, v1date]));
  });
});

test("B5 fix2: a Staff save response never includes another Staff member's unapproved visit id or counts", async () => {
  await withEnv(FLAG, async () => {
    seed();
    // Another Staff member's unapproved visit of the same cohort (seeded directly; the open-visit rule blocks creating it).
    const foreign = { cohortId: "fv", siteId: "site", createdBy: "staff-b", status: "PENDING_ADMIN_APPROVAL", version: 1, visitNumber: 9,
      visitDate: "2026-01-05", scheduledDueDate: "2026-01-05", dateMonitored: "2026-01-05",
      sampleAssessments: IDS.map(sampleId => ({ sampleId, condition: "Healthy", evidenceHistory: [] })) };
    const v1 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: today(), testOnly: true });
    table("sampleMonitoringVisits").set("VPMV-foreign-staff-b", foreign);
    const redacted = { visitId: null, visitNumber: 9, scheduledDueDate: "2026-01-05", visitDate: "2026-01-05", dateMonitored: "2026-01-05",
      status: "PENDING_ADMIN_APPROVAL", healthy: null, damaged: null, confirmedDead: null, needsRechecking: null, notAssessed: null, survivalRate: null, survivalStatus: null };
    const saved = await save(v1, healthy());
    assert.deepEqual(saved.visitContext.history.find(row => row.visitNumber === 9), redacted);
    assert.equal(JSON.stringify(saved.visitContext).includes("VPMV-foreign-staff-b"), false);
    assert.equal(saved.visitContext.history.find(row => row.visitNumber === 1).visitId, v1.id);
  });
});
