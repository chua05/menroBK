// Existing monitoring lifecycles (MON records) show the permanent-sample state of their report without being changed.
const test = require("node:test"), assert = require("node:assert/strict");
const { attachPermanentSample, summarizeLifecycle } = require("../src/services/permanentSampleLifecycle.service");
const { cohortIdFor } = require("../src/services/verifiedPlantingCohortEligibility");
const cohort = (extra = {}) => ({ source: { siteId: "site" }, ...extra });
const visit = (visitNumber, status, extra = {}) => ({ id: `v${visitNumber}`, cohortId: "c", siteId: "site", visitNumber, status, createdBy: "staff", dateMonitored: "2026-01-15", sampleAssessments: [{ condition: "Healthy" }, { condition: "Dead" }], ...extra });
const sum = (visits, cohortData = cohort(), today = "2026-02-01") => summarizeLifecycle({ cohortId: "c", cohort: cohortData, visits, actorId: "staff", today });

test("the start date is blank before submission, provisional while pending, blank again when returned and final after approval", () => {
  const start = (...visits) => { const value = sum(visits); return [value.startMonitoringDate, value.startProvisional, value.nextMonitoringDate, value.openVisit?.status || null]; };
  assert.deepEqual(start(), [null, false, null, null]);
  assert.deepEqual(start(visit(1, "DRAFT")), [null, false, null, "DRAFT"]);
  assert.deepEqual(start(visit(1, "PENDING_ADMIN_APPROVAL")), ["2026-01-15", true, null, "PENDING_ADMIN_APPROVAL"]);
  assert.deepEqual(start(visit(1, "RETURNED")), [null, false, null, "RETURNED"]);
  const approved = sum([visit(1, "APPROVED")], cohort({ permanentSampleSchedule: { nextScheduledDueDate: "2026-02-15" } }));
  assert.deepEqual([approved.startMonitoringDate, approved.startProvisional, approved.nextMonitoringDate, approved.nextStatus, approved.nextVisitNumber, approved.latest.survivalRate], ["2026-01-15", false, "2026-02-15", "SCHEDULED", 2, 50]);
});
test("a later draft or return keeps the approved start date and the approved schedule", () => {
  const value = sum([visit(1, "APPROVED"), visit(2, "RETURNED", { dateMonitored: "2026-02-20", createdBy: "other" })], cohort({ permanentSampleSchedule: { nextScheduledDueDate: "2026-02-15" } }), "2026-03-01");
  assert.deepEqual([value.startMonitoringDate, value.nextMonitoringDate, value.nextStatus, value.nextVisitNumber, value.openVisit, value.latest.visitNumber],
    ["2026-01-15", "2026-02-15", "OVERDUE", 2, { visitNumber: 2, status: "RETURNED", ownedByYou: false }, 1]);
});
test("visits of another cohort or site never count", () => {
  assert.equal(sum([visit(1, "APPROVED", { siteId: "other" }), visit(1, "APPROVED", { cohortId: "x" })]).approvedVisits, 0);
});
test("records are returned with the same ID, number, history and values; a failed read never hides them", async () => {
  const record = Object.freeze({ id: "MON-hash", monitoringNumber: "MON-2026-001", plantingReportId: "r1", history: [{ id: "old" }], status: "Awaiting Monitoring Setup", survivalRate: 0 });
  const reads = [], db = { collection: name => ({ doc: id => ({ get: async () => { reads.push(id); if (name === "verifiedPlantingCohorts") throw new Error("down"); } }) }) };
  const before = process.env.VERIFIED_PLANTING_COHORT_ENABLED;
  try {
    process.env.VERIFIED_PLANTING_COHORT_ENABLED = "false";
    assert.deepEqual(await attachPermanentSample([record], { db }), [record]); assert.equal(reads.length, 0);
    process.env.VERIFIED_PLANTING_COHORT_ENABLED = "true";
    const [failed] = await attachPermanentSample([record], { actorId: "staff", db });
    assert.deepEqual(failed, { ...record, permanentSample: null }); assert.deepEqual(reads, [cohortIdFor("r1")]);
    const ok = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) };
    const [value] = await attachPermanentSample([record], { actorId: "staff", db: ok });
    assert.deepEqual({ ...value, permanentSample: undefined }, { ...record, permanentSample: undefined }); assert.equal(value.permanentSample.approvedVisits, 0);
    assert.deepEqual(await attachPermanentSample([{ id: "x", plantingReportId: "" }], { db: ok }), [{ id: "x", plantingReportId: "" }]);
  } finally { if (before === undefined) delete process.env.VERIFIED_PLANTING_COHORT_ENABLED; else process.env.VERIFIED_PLANTING_COHORT_ENABLED = before; }
});
