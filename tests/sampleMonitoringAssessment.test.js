// B4: assessment validation, Dead / Needs Rechecking, per-tree dates, units, growth, summary and Admin notification.
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
const { MORTALITY_CAUSES } = require("../src/config/permanentSampleMonitoringVocabulary");
const { GROWTH_LABELS } = require("../src/config/permanentSampleGrowthCriteria");

const IDS = ["RPT-2026-020-T001", "RPT-2026-020-T002", "RPT-2026-020-T003"];
const today = () => schedule.dateOnlyInManila();
// First day of the month `n` months before the current Manila month.
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
  table("users").set("admin-2", { role: "admin", fullName: "Admin Two" });
  table("users").set("admin-off", { role: "admin", status: "inactive" });
  table("users").set("staff", { role: "staff" });
  // Legacy cohort (approved plan + baseline, no first-visit origin).
  table("verifiedPlantingCohorts").set("c", { source: { siteId: "site" }, samplingPlan: { status: "APPROVED", version: 1 },
    baseline: { approvalStatus: "APPROVED", sampleUnits: [{ permanentId: "TREE-001" }, { permanentId: "TREE-002" }] } });
}
const createFirst = (visitDate = today(), testOnly = true) => s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate, testOnly });
function attach(visitId, date, only = null) {
  const row = table("sampleMonitoringVisits").get(visitId);
  row.sampleAssessments.forEach((a, i) => {
    if (only && !only.includes(a.sampleId)) return;
    a.evidenceHistory = [...(a.evidenceHistory || []), { revision: Number(a.assessmentRevision || 0), privateEvidence: { objectName: `p-${i}` },
      captureSessionId: `cap-${visitId}-${i}-${a.assessmentRevision || 0}`, linkedAt: `${date}T04:00:00.000Z`,
      location: { latitude: 13 + i / 1000, longitude: 124, accuracyMeters: 5 } }];
  });
}
const healthy = (extra = {}) => IDS.map(sampleId => ({ sampleId, condition: "Healthy", heightCentimeters: 45, stemDiameterMillimeters: 6, ...(extra[sampleId] || {}) }));
const save = (visit, assessments, extra = {}) => s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff",
  expectedVersion: table("sampleMonitoringVisits").get(visit.id).version, assessments, ...extra });
const code = (c, status) => e => e.code === c && (status === undefined || e.status === status);
const notifications = () => [...table("notifications").entries()];

test("B4 units: stemDiameterMillimeters is stored as diameterCentimeters exactly and returned as mm; cm stays accepted; conflicts are 400", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst();
    let saved = await save(v, healthy({ [IDS[1]]: { stemDiameterMillimeters: 12.3 }, [IDS[2]]: { stemDiameterMillimeters: undefined, diameterCentimeters: 0.7 } }));
    assert.deepEqual(saved.sampleAssessments.map(a => a.diameterCentimeters), [0.6, 1.23, 0.7]);
    assert.deepEqual(saved.sampleAssessments.map(a => a.stemDiameterMillimeters), [6, 12.3, 7]);
    assert.deepEqual(table("sampleMonitoringVisits").get(v.id).sampleAssessments.map(a => a.diameterCentimeters), [0.6, 1.23, 0.7]);
    assert.ok(saved.sampleAssessments.every(a => a.heightCentimeters === 45));
    // Both units sent and agreeing is accepted; disagreeing is rejected before any write.
    saved = await save(v, healthy({ [IDS[0]]: { diameterCentimeters: 0.6 } }));
    assert.equal(saved.sampleAssessments[0].diameterCentimeters, 0.6);
    const before = table("sampleMonitoringVisits").get(v.id).version;
    await assert.rejects(() => save(v, healthy({ [IDS[0]]: { diameterCentimeters: 0.7 } })), code("DIAMETER_UNIT_CONFLICT", 400));
    assert.equal(table("sampleMonitoringVisits").get(v.id).version, before);
  });
});

test("B4 units: an old centimetre record reads back as cm and mm (never cm treated as mm) without rewriting history", async () => {
  seed();
  const stored = { createdBy: "staff", cohortId: "c", siteId: "site", visitDate: "2025-01-01", status: "APPROVED", version: 3,
    sampleAssessments: [{ sampleId: "TREE-001", condition: "Healthy", heightCentimeters: 52, diameterCentimeters: 0.65 }, { sampleId: "TREE-002", condition: "Dead", diameterCentimeters: null }] };
  table("sampleMonitoringVisits").set("old", JSON.parse(JSON.stringify(stored)));
  const read = await s.get("old", { actorId: "staff", actorRole: "staff" });
  assert.equal(read.sampleAssessments[0].diameterCentimeters, 0.65);
  assert.equal(read.sampleAssessments[0].stemDiameterMillimeters, 6.5);
  assert.equal(read.sampleAssessments[1].stemDiameterMillimeters, null);
  assert.deepEqual(table("sampleMonitoringVisits").get("old"), stored);
  assert.equal(require("../src/services/sampleMonitoringValidation").cmToMm(0.07), 0.7);
  assert.equal(require("../src/services/sampleMonitoringValidation").mmToCm(0.3), 0.03);
});

test("B4 measurements: living trees need height and diameter > 0; zero, negative and malformed values are rejected; Dead/Rechecking ignore them", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst();
    for (const bad of [0, -1, "abc", "NaN", Infinity, "12 cm"]) {
      await assert.rejects(() => save(v, healthy({ [IDS[0]]: { heightCentimeters: bad } })), e => e.status === 400);
      await assert.rejects(() => save(v, healthy({ [IDS[0]]: { stemDiameterMillimeters: bad } })), e => e.status === 400);
    }
    assert.equal(table("sampleMonitoringVisits").get(v.id).version, 0);
    // Drafts may be incomplete; submission requires both measurements for Healthy/Damaged.
    const partial = healthy({ [IDS[0]]: { condition: "Damaged", stemDiameterMillimeters: null } });
    const draft = await save(v, partial);
    assert.equal(draft.sampleAssessments[0].diameterCentimeters, null);
    attach(v.id, today());
    await assert.rejects(() => save(v, partial, { submit: true, dateMonitored: today() }), code("MEASUREMENTS_REQUIRED", 400));
    const ignored = await save(v, healthy({ [IDS[1]]: { condition: "Needs Rechecking", recheckReason: "Tag missing", remarks: "Searched plot" },
      [IDS[2]]: { condition: "Dead", mortalityCause: "Drought", remarks: "Dry stem" } }));
    assert.deepEqual(ignored.sampleAssessments.slice(1).map(a => [a.heightCentimeters, a.diameterCentimeters]), [[null, null], [null, null]]);
  });
});

test("B4 Dead requires a mortality cause from the vocabulary, remarks and current evidence", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst();
    const dead = extra => healthy({ [IDS[2]]: { condition: "Dead", mortalityCause: "Drought", remarks: "Stem dry and brittle", ...extra } });
    await assert.rejects(() => save(v, dead({ mortalityCause: "Aliens" })), code("INVALID_MORTALITY_CAUSE", 400));
    await assert.rejects(() => save(v, dead(), { submit: true, dateMonitored: today() }), code("CURRENT_SAMPLE_EVIDENCE_REQUIRED", 409));
    attach(v.id, today());
    await assert.rejects(() => save(v, dead({ mortalityCause: "" }), { submit: true, dateMonitored: today() }), code("MORTALITY_DETAILS_REQUIRED", 400));
    await assert.rejects(() => save(v, dead({ remarks: "  " }), { submit: true, dateMonitored: today() }), code("MORTALITY_DETAILS_REQUIRED", 400));
    const ok = await save(v, dead(), { submit: true, dateMonitored: today() });
    assert.equal(ok.status, "PENDING_ADMIN_APPROVAL");
    assert.equal(ok.sampleAssessments[2].mortalityCause, "Drought");
    assert.ok(MORTALITY_CAUSES.includes(ok.sampleAssessments[2].mortalityCause));
    assert.equal(ok.summary.confirmedDead, 1);
  });
});

test("B4 Needs Rechecking requires a reason and remarks, stays unresolved and is never Dead", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst(); attach(v.id, today());
    const recheck = extra => healthy({ [IDS[0]]: { condition: "Needs Rechecking", remarks: "Tag not found", recheckReason: "Tree not located", ...extra } });
    await assert.rejects(() => save(v, recheck({ recheckReason: " " }), { submit: true, dateMonitored: today() }), code("RECHECK_REASON_REQUIRED", 400));
    await assert.rejects(() => save(v, recheck({ remarks: "" }), { submit: true, dateMonitored: today() }), e => e.status === 400);
    const ok = await save(v, recheck(), { submit: true, dateMonitored: today() });
    const row = ok.sampleAssessments[0];
    assert.equal(row.condition, "Needs Rechecking"); assert.equal(row.recheckReason, "Tree not located"); assert.equal(row.recheckQueued, true);
    assert.equal(ok.summary.needsRechecking, 1); assert.equal(ok.summary.confirmedDead, 0);
    assert.equal(ok.summary.survivalRate, null); assert.equal(ok.summary.survivalStatus, "PENDING_INCOMPLETE");
  });
});

test("B4 per-tree assessedOn comes from evidence, else the client; never future or before opening, and a resumed draft keeps it", async () => {
  await withEnv(FLAG, async () => {
    seed(); const opening = monthStart(1); const v = await createFirst(opening);
    const rows = extra => healthy(extra);
    await assert.rejects(() => save(v, rows({ [IDS[0]]: { assessedOn: "2099-01-01" } })), code("INVALID_ASSESSED_ON", 400));
    await assert.rejects(() => save(v, rows({ [IDS[0]]: { assessedOn: "2019-12-31" } })), code("INVALID_ASSESSED_ON", 400));
    await assert.rejects(() => save(v, rows({ [IDS[0]]: { assessedOn: "2026-02-30" } })), code("INVALID_ASSESSED_ON", 400));
    let saved = await save(v, rows({ [IDS[0]]: { assessedOn: opening } }), { dateMonitored: opening });
    assert.equal(saved.sampleAssessments[0].assessedOn, opening);
    assert.equal(saved.sampleAssessments[1].assessedOn ?? null, null);
    // Evidence linked on another day sets the tree's date from the evidence, overriding any client value.
    attach(v.id, today(), [IDS[1]]);
    saved = await save(v, rows({ [IDS[1]]: { assessedOn: opening } }), { dateMonitored: today() });
    assert.equal(saved.sampleAssessments[1].assessedOn, today());
    // Resuming on another day with a new Date Monitored never overwrites existing per-tree dates.
    saved = await save(v, rows(), { dateMonitored: today() });
    assert.equal(saved.sampleAssessments[0].assessedOn, opening);
    assert.equal(saved.sampleAssessments[1].assessedOn, today());
  });
});

test("B4 summary: server-derived spec section 21 formula (15/3/2 -> 90%) and Pending/Incomplete with rechecking or unassessed", () => {
  const rows = [...Array(15).fill("Healthy"), ...Array(3).fill("Damaged"), ...Array(2).fill("Dead")].map((condition, i) => ({ sampleId: `T${i}`, condition }));
  const complete = s._test.summary(rows);
  assert.equal(complete.healthy, 15); assert.equal(complete.damaged, 3); assert.equal(complete.confirmedDead, 2);
  assert.equal(complete.living, 18); assert.equal(complete.total, 20); assert.equal(complete.completed, 20); assert.equal(complete.notAssessed, 0);
  assert.equal(complete.survivalRate, 90); assert.equal(complete.survivalStatus, "COMPLETE");
  const pending = s._test.summary([...rows.slice(1), { sampleId: "R", condition: "Needs Rechecking" }]);
  assert.equal(pending.needsRechecking, 1); assert.equal(pending.survivalRate, null); assert.equal(pending.survivalStatus, "PENDING_INCOMPLETE");
  const unassessed = s._test.summary([...rows.slice(1), { sampleId: "U", condition: null }]);
  assert.equal(unassessed.notAssessed, 1); assert.equal(unassessed.completed, 19); assert.equal(unassessed.survivalRate, null);
  assert.equal(s._test.summary([{ sampleId: "A", condition: "Healthy" }, { sampleId: "B", condition: "Dead" }, { sampleId: "C", condition: "Healthy" }]).survivalRate, 66.67);
  // Client totals are never trusted: a forged summary in the save input is ignored (covered in save); growth aggregates are present.
  assert.deepEqual(Object.keys(complete.growth).sort(), ["baselineOnly", "criteriaVersion", "growthPerformance", "growthStage", "heightDifferences", "measurementDecreased", "stageAdvancements", "stemDiameterDifferences"]);
});

test("B4 overall visit remarks are persisted, bounded, and cannot disagree with visitRemarks", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst();
    const saved = await save(v, healthy(), { overallRemarks: "  Dry season visit  ", summary: { survivalRate: 5 } });
    assert.equal(saved.overallRemarks, "Dry season visit"); assert.equal(saved.visitRemarks, "Dry season visit");
    assert.equal(saved.summary.survivalRate, 100);
    await assert.rejects(() => save(v, healthy(), { overallRemarks: "a".repeat(1001) }), e => e.status === 400);
    await assert.rejects(() => save(v, healthy(), { overallRemarks: "x", visitRemarks: "y" }), e => e.status === 400);
    const kept = await save(v, healthy());
    assert.equal(kept.overallRemarks, "Dry season visit");
  });
});

test("B4 submit notifies active Admins once per submission revision and returns submissionRevision", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst(); attach(v.id, today());
    const first = await save(v, healthy(), { submit: true, dateMonitored: today() });
    assert.equal(first.submissionRevision, 1);
    const ids = notifications().map(([id]) => id).sort();
    assert.deepEqual(ids, [`sample_monitoring_visit_submitted_${v.id}_1_admin-1`, `sample_monitoring_visit_submitted_${v.id}_1_admin-2`]);
    const note = table("notifications").get(ids[0]);
    assert.equal(note.recipientUserId, "admin-1"); assert.equal(note.type, "sample_monitoring_visit_submitted");
    assert.equal(note.relatedRecordType, "sampleMonitoringVisit"); assert.equal(note.relatedRecordId, v.id);
    assert.doesNotMatch(JSON.stringify(note), /privateEvidence|objectName|captureSessionId/);
    // A duplicate submit (same expected version) is refused and creates nothing.
    await assert.rejects(() => s.save({ actorRole: "staff", visitId: v.id, actorId: "staff", expectedVersion: 0, submit: true, dateMonitored: today(), assessments: healthy() }), e => e.status === 409);
    assert.equal(notifications().length, 2);
    // Return and resubmit: a new revision id; an already-existing notification doc is left untouched (no duplicate, no overwrite).
    await s.review({ visitId: v.id, actorId: "admin-1", expectedVersion: first.version, approve: false, reasons: "Re-check T001." });
    table("notifications").set(`sample_monitoring_visit_submitted_${v.id}_2_admin-1`, { marker: "pre-existing" });
    const again = await save(v, healthy(), { submit: true, dateMonitored: today() });
    assert.equal(again.submissionRevision, 2);
    assert.equal(table("notifications").get(`sample_monitoring_visit_submitted_${v.id}_2_admin-1`).marker, "pre-existing");
    assert.equal(notifications().length, 4);
    assert.ok(!notifications().some(([id]) => id.includes("admin-off")));
  });
});

test("B4 legacy visits (no policy version, not first visit) keep their current behaviour", async () => {
  seed();
  const v = await s.create({ actorRole: "staff", cohortId: "c", actorId: "staff", visitDate: "2030-01-01", testOnly: true });
  const saved = await s.save({ actorRole: "staff", visitId: v.id, actorId: "staff", expectedVersion: 0, submit: true,
    assessments: [{ sampleId: "TREE-001", condition: "Healthy" }, { sampleId: "TREE-002", condition: "Dead", heightCentimeters: 0 }] });
  assert.equal(saved.status, "PENDING_ADMIN_APPROVAL");
  assert.equal("mortalityCause" in saved.sampleAssessments[1], false);
  assert.equal("assessedOn" in saved.sampleAssessments[0], false);
  assert.equal("heightDifferenceCm" in saved.sampleAssessments[0], false);
  assert.equal(saved.sampleAssessments[1].heightCentimeters, 0);
  assert.equal(notifications().length, 0);
});

// FIX-G D-A (spec section 15): Reason for Rechecking is kept on EVERY permanent-sample visit, not only strict ones.
test("FIX-G D-A legacy visits persist and return a bounded recheckReason; optional on save, required at submit", async () => {
  await withEnv({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: undefined, PERMANENT_SAMPLE_SCHEDULE_ENABLED: undefined }, async () => {
    seed();
    const v = await s.create({ actorRole: "staff", cohortId: "c", actorId: "staff", visitDate: "2030-01-01", testOnly: true });
    const stored = () => table("sampleMonitoringVisits").get(v.id);
    assert.equal(stored().schedulePolicyVersion, undefined); assert.notEqual(stored().registersBaseline, true);
    const rows = extra => [{ sampleId: "TREE-001", condition: "Healthy", recheckReason: "ignored on Healthy" },
      { sampleId: "TREE-002", condition: "Needs Rechecking", remarks: "Searched plot", ...extra }];
    // Save (draft): the reason is trimmed, stored and returned; other conditions never carry one.
    const saved = await save(v, rows({ recheckReason: "  Tag missing  " }));
    assert.equal(saved.status, "DRAFT");
    assert.equal(saved.sampleAssessments[1].recheckReason, "Tag missing");
    assert.equal(saved.sampleAssessments[0].recheckReason, null);
    assert.equal(stored().sampleAssessments[1].recheckReason, "Tag missing");
    assert.equal((await s.get(v.id, { actorId: "staff", actorRole: "staff" })).sampleAssessments[1].recheckReason, "Tag missing");
    // Bounded like strict visits: non-text is 400, long text is cut to 1000 characters.
    await assert.rejects(() => save(v, rows({ recheckReason: 42 })), e => e.status === 400 && /Reason for Rechecking/.test(e.message));
    assert.equal((await save(v, rows({ recheckReason: "x".repeat(1500) }))).sampleAssessments[1].recheckReason.length, 1000);
    // Optional on a draft save.
    const draft = await save(v, rows({ recheckReason: "   " }));
    assert.equal(draft.sampleAssessments[1].recheckReason, null);
    // Required at submission, with the field-specific code; nothing is written.
    const version = stored().version;
    for (const reason of [undefined, "", "   "]) {
      await assert.rejects(() => save(v, rows({ recheckReason: reason }), { submit: true }), code("RECHECK_REASON_REQUIRED", 400));
    }
    assert.equal(stored().version, version); assert.equal(stored().status, "DRAFT");
    const submitted = await save(v, rows({ recheckReason: "Tree not located" }), { submit: true });
    assert.equal(submitted.status, "PENDING_ADMIN_APPROVAL");
    assert.equal(submitted.sampleAssessments[1].recheckReason, "Tree not located");
    assert.deepEqual(submitted.recheckQueue, ["TREE-002"]);
    // Legacy behaviour is otherwise unchanged: no strict-only fields appear.
    assert.equal("mortalityCause" in submitted.sampleAssessments[1], false);
    assert.equal("assessedOn" in submitted.sampleAssessments[1], false);
  });
});

test("FIX-G D-A strict visits keep their recheckReason rules (optional on draft, required at submit)", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst(); attach(v.id, today());
    const recheck = extra => healthy({ [IDS[0]]: { condition: "Needs Rechecking", remarks: "Tag not found", ...extra } });
    assert.equal((await save(v, recheck())).sampleAssessments[0].recheckReason, null);
    await assert.rejects(() => save(v, recheck({ recheckReason: 7 })), e => e.status === 400);
    await assert.rejects(() => save(v, recheck(), { submit: true, dateMonitored: today() }), code("RECHECK_REASON_REQUIRED", 400));
    const ok = await save(v, recheck({ recheckReason: "Marker moved" }), { submit: true, dateMonitored: today() });
    assert.equal(ok.sampleAssessments[0].recheckReason, "Marker moved");
  });
});

test("B4 growth: visit 1 is baseline only; visit 2 compares with the latest approved measurement in cm and mm and flags decreases", async () => {
  await withEnv(SCHED, async () => {
    seed();
    const v1date = monthStart(6);
    const v1 = await createFirst(v1date, false); attach(v1.id, v1date);
    const p1 = await save(v1, healthy({ [IDS[2]]: { heightCentimeters: 50, stemDiameterMillimeters: 9 } }), { submit: true, dateMonitored: v1date });
    assert.ok(p1.sampleAssessments.every(a => a.baselineOnly === true && a.heightDifferenceCm === null && a.stemDiameterDifferenceMm === null));
    assert.equal(p1.sampleAssessments[0].growthPerformance, GROWTH_LABELS.NOT_APPLICABLE);
    assert.equal(p1.summary.growth.baselineOnly, true);
    await s.review({ visitId: v1.id, actorId: "admin-1", expectedVersion: p1.version, approve: true });
    const due2 = schedule.addCalendarMonths(v1date, 1);
    const v2 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: due2 });
    assert.equal(v2.schedulePolicyVersion, schedule.POLICY_VERSION);
    attach(v2.id, due2);
    const p2 = await save(v2, healthy({ [IDS[0]]: { heightCentimeters: 61, stemDiameterMillimeters: 8 }, [IDS[2]]: { heightCentimeters: 48, stemDiameterMillimeters: 9.5 } }),
      { submit: true, dateMonitored: due2 });
    const [a, , c] = p2.sampleAssessments;
    assert.equal(a.baselineOnly, false); assert.equal(a.heightDifferenceCm, 16); assert.equal(a.stemDiameterDifferenceMm, 2); assert.equal(a.measurementDecreased, false);
    assert.equal(a.growthPerformance, GROWTH_LABELS.PENDING); assert.equal(a.growthStage, GROWTH_LABELS.STAGE_PENDING);
    assert.equal(c.heightDifferenceCm, -2); assert.equal(c.stemDiameterDifferenceMm, 0.5); assert.equal(c.measurementDecreased, true);
    assert.equal(c.condition, "Healthy");
    assert.equal(p2.summary.growth.heightDifferences, 3); assert.equal(p2.summary.growth.measurementDecreased, 1);
    assert.equal(p2.summary.growth.growthPerformance[GROWTH_LABELS.PENDING], 3);
  });
});

test("B4 policy visits require current evidence for every new record; a Staff-changed inherited Dead row is 409 CONFIRMED_DEAD_LOCKED (create -> save -> submit -> approve)", async () => {
  await withEnv(SCHED, async () => {
    seed();
    const v1date = monthStart(6);
    const v1 = await createFirst(v1date, false); attach(v1.id, v1date);
    const p1 = await save(v1, healthy(), { submit: true, dateMonitored: v1date });
    await s.review({ visitId: v1.id, actorId: "admin-1", expectedVersion: p1.version, approve: true });
    const due2 = schedule.addCalendarMonths(v1date, 1);
    const v2 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: due2 });
    const deadRows = healthy({ [IDS[2]]: { condition: "Dead", mortalityCause: "Pest/Disease", remarks: "Borer damage" } });
    attach(v2.id, due2, [IDS[0], IDS[1]]);
    await assert.rejects(() => save(v2, deadRows, { submit: true, dateMonitored: due2 }), e => e.code === "CURRENT_SAMPLE_EVIDENCE_REQUIRED" && e.missingSampleIds.join() === IDS[2]);
    attach(v2.id, due2, [IDS[2]]);
    const p2 = await save(v2, deadRows, { submit: true, dateMonitored: due2 });
    const a2 = await s.review({ visitId: v2.id, actorId: "admin-1", expectedVersion: p2.version, approve: true });
    assert.equal(a2.status, "APPROVED");
    const originalEvidence = table("sampleMonitoringVisits").get(v2.id).sampleAssessments[2].evidenceHistory;
    const due3 = schedule.addCalendarMonths(due2, 3);
    const v3 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: due3 });
    const inherited = v3.sampleAssessments[2];
    assert.equal(inherited.condition, "Dead"); assert.deepEqual(inherited.inheritedConfirmedDead, { visitId: v2.id, assessmentRevision: 0 });
    assert.equal(inherited.mortalityCause, "Pest/Disease");
    const v3rows = extra => [...healthy().slice(0, 2), { sampleId: IDS[2], condition: "Dead", ...extra }];
    for (const change of [{ condition: "Healthy", heightCentimeters: 40, stemDiameterMillimeters: 5 }, { mortalityCause: "Drought" }, { heightCentimeters: 30 }, { stemDiameterMillimeters: 3 }, { remarks: "Changed" }]) {
      await assert.rejects(() => save(v3, v3rows(change)), code("CONFIRMED_DEAD_LOCKED", 409));
    }
    assert.equal(table("sampleMonitoringVisits").get(v3.id).version, 0);
    attach(v3.id, due3, [IDS[0], IDS[1]]);
    const p3 = await save(v3, v3rows({ mortalityCause: "Pest/Disease" }), { submit: true, dateMonitored: due3 });
    const locked = p3.sampleAssessments[2];
    assert.deepEqual(locked.inheritedConfirmedDead, { visitId: v2.id, assessmentRevision: 0 });
    assert.deepEqual(locked.evidenceHistory, []); assert.equal(locked.mortalityCause, "Pest/Disease"); assert.equal(locked.remarks, "Borer damage");
    assert.equal(locked.heightCentimeters ?? null, null);
    assert.equal(p3.summary.confirmedDead, 1); assert.equal(p3.summary.living, 2); assert.equal(p3.summary.survivalRate, 66.67);
    const a3 = await s.review({ visitId: v3.id, actorId: "admin-1", expectedVersion: p3.version, approve: true });
    assert.equal(a3.status, "APPROVED");
    // The original mortality evidence is preserved on the visit that recorded the death.
    assert.deepEqual(table("sampleMonitoringVisits").get(v2.id).sampleAssessments[2].evidenceHistory, originalEvidence);
  });
});

// ---- B4 fix round 1 ----
test("B4 fix1: a carried-forward Dead tree stays carried, locked, photo-free and Dead in every later visit", async () => {
  await withEnv(SCHED, async () => {
    seed();
    const v1date = monthStart(11);
    const v1 = await createFirst(v1date, false); attach(v1.id, v1date);
    const p1 = await save(v1, healthy(), { submit: true, dateMonitored: v1date });
    await s.review({ visitId: v1.id, actorId: "admin-1", expectedVersion: p1.version, approve: true });
    // The death is recorded (with its own photo) and approved.
    const due2 = schedule.addCalendarMonths(v1date, 1);
    const v2 = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: due2 }); attach(v2.id, due2);
    const p2 = await save(v2, healthy({ [IDS[2]]: { condition: "Dead", mortalityCause: "Flooding", remarks: "Washed out" } }), { submit: true, dateMonitored: due2 });
    await s.review({ visitId: v2.id, actorId: "admin-1", expectedVersion: p2.version, approve: true });
    const source = { visitId: v2.id, assessmentRevision: 0 };
    let due = due2;
    // Two inheriting visits approved in a row, then a further visit that must still carry the death.
    for (let round = 0; round < 3; round++) {
      due = schedule.addCalendarMonths(due, 3);
      const visit = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: due });
      const dead = visit.sampleAssessments[2];
      assert.equal(dead.condition, "Dead", `round ${round}`);
      assert.deepEqual(dead.inheritedConfirmedDead, source);
      assert.equal(dead.mortalityCause, "Flooding"); assert.equal(dead.remarks, "Washed out");
      assert.deepEqual(dead.evidenceHistory, []);
      await assert.rejects(() => save(visit, [...healthy().slice(0, 2), { sampleId: IDS[2], condition: "Healthy", heightCentimeters: 40, stemDiameterMillimeters: 5 }]),
        code("CONFIRMED_DEAD_LOCKED", 409));
      if (round === 2) break;
      attach(visit.id, due, [IDS[0], IDS[1]]);
      const pending = await save(visit, [...healthy().slice(0, 2), { sampleId: IDS[2], condition: "Dead" }], { submit: true, dateMonitored: due });
      assert.equal(pending.summary.confirmedDead, 1); assert.equal(pending.summary.survivalRate, 66.67);
      assert.deepEqual(pending.sampleAssessments[2].inheritedConfirmedDead, source);
      const approved = await s.review({ visitId: visit.id, actorId: "admin-1", expectedVersion: pending.version, approve: true });
      assert.equal(approved.status, "APPROVED");
    }
  });
});

test("B4 fix1: the CONFIRMED_DEAD_LOCKED message names the tree", async () => {
  const stored = { sampleId: "RPT-9-T004", condition: "Dead", remarks: "Dry", mortalityCause: "Drought", inheritedConfirmedDead: { visitId: "v", assessmentRevision: 0 } };
  await withEnv(FLAG, async () => {
    seed();
    const row = table("sampleMonitoringVisits");
    row.set("locked", { createdBy: "staff", cohortId: "c", siteId: "site", samplingPlanVersion: 1, baselineVersion: 0, visitDate: "2026-01-01", openingDate: "2026-01-01",
      schedulePolicyVersion: schedule.POLICY_VERSION, status: "DRAFT", version: 0, priorVisitId: null,
      sampleAssessments: [{ ...stored, sampleId: "TREE-001" }, { sampleId: "TREE-002", condition: null, evidenceHistory: [] }] });
    await assert.rejects(() => s.save({ actorRole: "staff", visitId: "locked", actorId: "staff", expectedVersion: 0,
      assessments: [{ sampleId: "TREE-001", condition: "Healthy" }, { sampleId: "TREE-002", condition: null }] }),
    e => e.code === "CONFIRMED_DEAD_LOCKED" && e.status === 409 && e.message.includes("TREE-001"));
  });
});

test("Save Draft keeps an incomplete Needs Rechecking tree, and search findings persist without an investigation outcome", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst();
    const rows = extra => healthy({ [IDS[0]]: { condition: "Needs Rechecking", remarks: "", recheckReason: "", ...extra } });
    const draft = await save(v, rows({ searchFindings: "  Searched 10 m around the tag  " }));
    assert.deepEqual([draft.status, draft.sampleAssessments[0].condition, draft.sampleAssessments[0].searchFindings, draft.sampleAssessments[0].investigationOutcome], ["DRAFT", "Needs Rechecking", "Searched 10 m around the tag", null]);
    assert.equal((await save(v, rows({ investigationOutcome: "Not Located After Rechecking" }))).sampleAssessments[0].investigationOutcome, "Not Located After Rechecking");
    attach(v.id, today());
    await assert.rejects(() => save(v, rows({ remarks: "Gone", recheckReason: "Not found", investigationOutcome: "Not Located After Rechecking" }), { submit: true, dateMonitored: today() }), /search findings/);
    await assert.rejects(() => save(v, rows({ searchFindings: 42 })), e => e.status === 400);
    // Findings belong to the unresolved tree only.
    assert.equal((await save(v, healthy({ [IDS[0]]: { searchFindings: "old" } }))).sampleAssessments[0].searchFindings, null);
  });
});

test("Save Tree Assessment checks only the named tree like a submission, including its photo, and writes nothing when refused", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst();
    const stored = () => table("sampleMonitoringVisits").get(v.id), version = stored().version;
    const empty = { condition: null, heightCentimeters: null, stemDiameterMillimeters: null };
    const partial = extra => healthy({ [IDS[1]]: empty, [IDS[2]]: empty, ...extra });
    await assert.rejects(() => save(v, partial(), { assessedSampleId: IDS[0] }), e => e.code === "CURRENT_SAMPLE_EVIDENCE_REQUIRED" && e.sampleId === IDS[0] && e.missingSampleIds.join() === IDS[0]);
    attach(v.id, today());
    await assert.rejects(() => save(v, partial({ [IDS[0]]: { heightCentimeters: null } }), { assessedSampleId: IDS[0] }), e => e.code === "MEASUREMENTS_REQUIRED" && e.sampleId === IDS[0]);
    await assert.rejects(() => save(v, partial({ [IDS[0]]: { condition: "Dead", remarks: "Dry" } }), { assessedSampleId: IDS[0] }), e => e.code === "MORTALITY_DETAILS_REQUIRED");
    await assert.rejects(() => save(v, partial(), { assessedSampleId: IDS[1] }), code("TREE_CONDITION_REQUIRED", 400));
    await assert.rejects(() => save(v, partial(), { assessedSampleId: "OTHER-T001" }), code("INVALID_TREE_ASSESSMENT", 400));
    await assert.rejects(() => save(v, partial(), { assessedSampleId: IDS[0], submit: true, dateMonitored: today() }), e => e.status === 400);
    assert.equal(stored().version, version);
    const saved = await save(v, partial(), { assessedSampleId: IDS[0] });
    assert.deepEqual([saved.status, saved.version, saved.summary.healthy, saved.summary.notAssessed], ["DRAFT", version + 1, 1, 2]);
  });
});

test("a returned visit stays returned while corrected; each corrected tree needs one new photo, whichever save changed it", async () => {
  await withEnv(FLAG, async () => {
    seed(); const v = await createFirst(); attach(v.id, today());
    const pending = await save(v, healthy(), { submit: true, dateMonitored: today() });
    await s.review({ visitId: v.id, actorId: "admin-1", expectedVersion: pending.version, approve: false, reasons: "Re-measure." });
    const revisions = visit => visit.sampleAssessments.map(row => row.assessmentRevision).join();
    const first = await save(v, healthy({ [IDS[0]]: { heightCentimeters: 130 } }));
    assert.deepEqual([first.status, first.reviewReasons, revisions(first)], ["RETURNED", "Re-measure.", "1,0,0"]);
    const corrected = healthy({ [IDS[0]]: { heightCentimeters: 131 }, [IDS[1]]: { heightCentimeters: 140 } });
    const second = await save(v, corrected);
    assert.deepEqual([second.status, revisions(second)], ["RETURNED", "1,1,0"]);
    await assert.rejects(() => save(v, corrected, { submit: true, dateMonitored: today() }), e => e.code === "CURRENT_SAMPLE_EVIDENCE_REQUIRED" && e.missingSampleIds.join() === IDS.slice(0, 2).join());
    assert.equal(table("sampleMonitoringVisits").get(v.id).sampleAssessments[0].evidenceHistory.length, 1, "earlier evidence is kept");
    attach(v.id, today(), IDS.slice(0, 2));
    const again = await save(v, corrected, { submit: true, dateMonitored: today() });
    assert.equal(again.status, "PENDING_ADMIN_APPROVAL");
    // A second return is a new correction round.
    await s.review({ visitId: v.id, actorId: "admin-1", expectedVersion: again.version, approve: false, reasons: "Once more." });
    assert.equal(revisions(await save(v, healthy({ [IDS[0]]: { heightCentimeters: 150 }, [IDS[1]]: { heightCentimeters: 140 } }))), "2,1,0");
  });
});
