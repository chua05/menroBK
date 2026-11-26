const assert = require("node:assert/strict");
const test = require("node:test");

const data = {
  seedlingInventory: [], seedlingRequests: [],
  distributions: [{ id: "dist-1", status: "Released", plantingSiteId: "site-1", releasedAt: "2026-05-10", totalQuantityReleased: 80,
    items: [{ species: "Narra", releasedQuantity: 50 }, { species: "Molave", releasedQuantity: 30 }] }],
  events: [{ id: "event-1", plantingSiteId: "site-1", barangay: "Bical" }],
  plantingReports: [
    { id: "report-1", reportType: "parent", eventId: "event-1", siteId: "site-1", barangay: "Bical", quantityPlanted: 80,
      verificationStatus: "Approved", approvedAt: "2026-06-20", eventDate: "2026-06-01" },
    { id: "pending-1", reportType: "parent", eventId: "event-1", siteId: "site-1", barangay: "Bical",
      verificationStatus: "Pending Review", submittedAt: "2026-06-21", quantityPlanted: 5 },
  ],
  plantingContributions: [
    { id: "c1", reportId: "report-1", species: "Narra", quantity: 50, recordedAt: "2026-06-01" },
    { id: "c2", reportId: "report-1", species: "Molave", quantity: 20, recordedAt: "2026-06-01" },
    { id: "c3", reportId: "report-1", species: "Molave", quantity: 10, recordedAt: "2026-06-02" },
    { id: "c4", reportId: "pending-1", species: "Narra", quantity: 5, recordedAt: "2026-06-21",
      verificationStatus: "Needs Review", staffReviewStatus: "Pending Review" },
  ],
  monitoringRecords: [{ id: "monitor-1", plantingReportId: "report-1", siteId: "site-1", barangay: "Bical", species: "Narra",
    startMonitoringDate: "2026-06-15", nextMonitoringDate: "2026-09-01", monitoringEndDate: "2028-06-01",
    history: [
      { monitoredDate: "2026-06-15", healthyCount: 50, damagedCount: 20, deadCount: 10, totalMonitored: 80,
        reviewStatus: "Approved" },
      { monitoredDate: "2026-08-01", healthyCount: 60, damagedCount: 10, deadCount: 10, totalMonitored: 80,
        reviewStatus: "Approved" },
    ] }],
  sites: [{ id: "site-1", siteName: "Bical Site", barangay: "Bical", status: "Active" }],
};

const db = { collection: (name) => ({ get: async () => ({ docs: data[name].map((row) => ({ id: row.id, data: () => row })) }) }) };
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const { getDashboard, lifecycleStatus } = require("../src/services/analytics.service");

test("analytics lifecycle eligibility uses only approved full observations", () => {
  const base = { startMonitoringDate: "2026-06-15", nextMonitoringDate: null,
    monitoringEndDate: "2028-06-01", quantityPlanted: 80 };
  const phaseTwo = { workflowVersion: 2, monitoredDate: "2026-08-01",
    totalMonitored: 80, cohortQuantityAtObservation: 80 };
  for (const reviewStatus of ["Pending Review", "Reviewed", "Returned for Rechecking", "Rejected"]) {
    assert.equal(lifecycleStatus({ ...base, history: [{ ...phaseTwo, reviewStatus }] }, "2026-10-15"),
      "Available for Monitoring", `${reviewStatus} must not complete an official cycle`);
  }
  assert.equal(lifecycleStatus({ ...base, history: [{ ...phaseTwo, reviewStatus: "Approved",
    adminDecision: "Approve", adminDecidedBy: "admin-1", adminDecidedAt: "2026-08-02" }],
    nextMonitoringDate: "2026-11-01" }, "2026-10-15"), "Next Monitoring Scheduled");
  assert.equal(lifecycleStatus({ ...base, history: [{ ...phaseTwo, totalMonitored: 25,
    isFullCohortAssessment: false, reviewStatus: "Approved", adminDecision: "Approve",
    adminDecidedBy: "admin-1", adminDecidedAt: "2026-08-02" }] }, "2026-10-15"),
  "Available for Monitoring");
  assert.equal(lifecycleStatus({ ...base, history: [{ monitoredDate: "2026-08-01",
    totalMonitored: 80, reviewStatus: "Validated" }], nextMonitoringDate: "2026-11-01" },
  "2026-10-15"), "Next Monitoring Scheduled");
  assert.equal(lifecycleStatus({ ...base, history: [{ monitoredDate: "2026-10-01",
    totalMonitored: 80, reviewStatus: "Validated" }], nextMonitoringDate: null },
  "2026-10-15"), "Next Monitoring Scheduled");
  assert.equal(lifecycleStatus({ ...base, history: [], startMonitoringDate: "2026-11-01" },
    "2026-10-15"), "Not Yet Available");
  assert.equal(lifecycleStatus({ ...base, history: [], monitoringEndDate: "2026-10-15" },
    "2026-10-15"), "Monitoring Completed");
});

test("analytics uses actual releases, contribution rows, final approvals, and latest monitoring history", async () => {
  const result = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  assert.equal(result.summary.totalSaplingsDistributed, 80);
  assert.equal(result.summary.totalTreesPlanted, 80, "parent aggregate must not be added to its child contributions");
  assert.equal(result.summary.verifiedPlantingReports, 1);
  assert.equal(result.summary.barangaysCovered, 1);
  assert.equal(result.summary.activePlantingSites, 1);
  assert.equal(result.summary.overallSurvivalRate, 87.5);
  assert.deepEqual(result.monitoringConditions, [
    { condition: "Healthy", count: 60 }, { condition: "Damaged", count: 10 }, { condition: "Dead", count: 10 },
  ]);
  assert.equal(result.decisionSupport.pendingPlantingReports, 1);
  assert.equal(result.decisionSupport.distributionPlantingDifference, 0);
});

test("analytics filters remain synchronized and empty periods do not invent chart points", async () => {
  const narra = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-12-31", species: "Narra" });
  assert.equal(narra.summary.totalSaplingsDistributed, 50);
  assert.equal(narra.summary.totalTreesPlanted, 50);
  const empty = await getDashboard({ dateFrom: "2025-01-01", dateTo: "2025-03-31" });
  assert.equal(empty.summary.totalTreesPlanted, 0);
  assert.deepEqual(empty.plantingTrend.map((item) => item.count), [0, 0, 0]);
  assert.deepEqual(empty.survivalTrend.map((item) => item.rate), [null, null, null]);
  assert.equal(empty.summary.overallSurvivalRate, null);
  assert.equal(empty.summary.activePlantingSites, 1);
});

test("analytics counts qualifying submissions without flattening verification, review, and progress", async () => {
  data.distributions.push({ id: "dist-2", status: "Released", plantingSiteId: "site-2", releasedAt: "2026-07-01",
    items: [{ species: "Narra", releasedQuantity: 50 }] });
  data.sites.push({ id: "site-2", siteName: "Submission Site", barangay: "Calpi", status: "Active",
    maximumCapacity: 100 });
  data.plantingReports.push({ id: "report-2", reportType: "parent", siteId: "site-2", barangay: "Calpi",
    reportingProgress: "Partial", createdAt: "2026-07-01" });
  data.plantingContributions.push(
    { id: "verified", reportId: "report-2", species: "Narra", quantity: 10, recordedAt: "2026-07-02",
      verificationStatus: "Verified", staffReviewStatus: "Not Required" },
    { id: "accepted", reportId: "report-2", species: "Narra", quantity: 20, recordedAt: "2026-07-03",
      reviewedAt: "2026-07-04", verificationStatus: "Needs Review", staffReviewStatus: "Accepted" },
    { id: "pending", reportId: "report-2", species: "Narra", quantity: 15, recordedAt: "2026-07-04",
      verificationStatus: "Needs Review", staffReviewStatus: "Pending Review" },
    { id: "rejected", reportId: "report-2", species: "Narra", quantity: 5, recordedAt: "2026-07-05",
      verificationStatus: "Needs Review", staffReviewStatus: "Rejected" },
  );
  try {
    const result = await getDashboard({ site: "site-2", dateFrom: "2026-07-01", dateTo: "2026-07-31" });
    assert.equal(result.summary.totalSaplingsDistributed, 50);
    assert.equal(result.summary.totalTreesPlanted, 30);
    assert.equal(result.summary.verifiedPlantingReports, 1);
    assert.equal(result.verificationAnalytics.pending, 1);
    assert.equal(result.verificationAnalytics.rejected, 1);
    assert.equal(result.accountability.difference, 20);
    assert.equal(result.siteMap[0].planted, 30);
  } finally {
    data.distributions.pop();
    data.sites.pop();
    data.plantingReports.pop();
    data.plantingContributions.splice(-4);
  }
});

test("official survival analytics use the latest approved observation chronologically", async () => {
  const originalHistory = data.monitoringRecords[0].history;
  data.monitoringRecords[0].history = [
    { monitoredDate: "2026-09-01", healthyCount: 5, damagedCount: 5, deadCount: 70,
      totalMonitored: 80, reviewStatus: "Pending" },
    { monitoredDate: "2026-08-01", healthyCount: 55, damagedCount: 5, deadCount: 20,
      totalMonitored: 80, reviewStatus: "Approved" },
    { monitoredDate: "2026-10-01", healthyCount: 0, damagedCount: 0, deadCount: 80,
      totalMonitored: 80, reviewStatus: "Rejected" },
    { monitoredDate: "2026-07-01", healthyCount: 40, damagedCount: 10, deadCount: 30,
      totalMonitored: 80, reviewStatus: "Validated" },
  ];

  try {
    const result = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    assert.equal(result.summary.overallSurvivalRate, 75);
    assert.deepEqual(result.monitoringConditions, [
      { condition: "Healthy", count: 55 },
      { condition: "Damaged", count: 5 },
      { condition: "Dead", count: 20 },
    ]);
    assert.equal(result.meta.monitoringEntryCount, 2,
      "pending and rejected observations must not enter official trends");
    assert.equal(result.meta.latestMonitoringCount, 1);
  } finally {
    data.monitoringRecords[0].history = originalHistory;
  }
});

test("Phase 2 Reviewed is excluded until Admin approval", async () => {
  const originalHistory = data.monitoringRecords[0].history;
  data.monitoringRecords[0].history = [
    { workflowVersion: 2, monitoredDate: "2026-08-01", healthyCount: 70,
      damagedCount: 5, deadCount: 5, totalMonitored: 80,
      cohortQuantityAtObservation: 80, reviewStatus: "Reviewed", staffReviewedBy: "staff-1" },
  ];
  try {
    let result = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    assert.equal(result.summary.overallSurvivalRate, null);
    data.monitoringRecords[0].history[0] = { ...data.monitoringRecords[0].history[0],
      reviewStatus: "Approved", adminDecision: "Approve", adminDecidedBy: "admin-1",
      adminDecidedAt: "2026-08-02T00:00:00Z" };
    result = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    assert.equal(result.summary.overallSurvivalRate, 93.75);
  } finally {
    data.monitoringRecords[0].history = originalHistory;
  }
});

test("records without an approved observation do not imply healthy or dead trees", async () => {
  const originalHistory = data.monitoringRecords[0].history;
  data.monitoringRecords[0].history = [
    { monitoredDate: "2026-08-01", healthyCount: 80, damagedCount: 0, deadCount: 0,
      totalMonitored: 80, reviewStatus: "Pending Review" },
    { monitoredDate: "2026-09-01", healthyCount: 0, damagedCount: 0, deadCount: 80,
      totalMonitored: 80, reviewStatus: "Rejected" },
  ];

  try {
    const result = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    assert.equal(result.summary.overallSurvivalRate, null);
    assert.deepEqual(result.monitoringConditions, [
      { condition: "Healthy", count: 0 },
      { condition: "Damaged", count: 0 },
      { condition: "Dead", count: 0 },
    ]);
    assert.equal(result.meta.monitoringEntryCount, 0);
    assert.equal(result.meta.latestMonitoringCount, 0);
  } finally {
    data.monitoringRecords[0].history = originalHistory;
  }
});

test("a latest approved partial observation makes official cohort analytics unavailable", async () => {
  const originalHistory = data.monitoringRecords[0].history;
  data.monitoringRecords[0].history = [
    { monitoredDate: "2026-07-01", healthyCount: 60, damagedCount: 10, deadCount: 10,
      totalMonitored: 80, cohortQuantityAtObservation: 80, reviewStatus: "Approved" },
    { monitoredDate: "2026-08-01", healthyCount: 20, damagedCount: 3, deadCount: 2,
      totalMonitored: 25, cohortQuantityAtObservation: 80, isFullCohortAssessment: false,
      reviewStatus: "Approved" },
  ];
  try {
    const result = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    assert.equal(result.summary.overallSurvivalRate, null);
    assert.equal(result.meta.latestMonitoringCount, 0);
    assert.equal(result.meta.monitoringEntryCount, 1);
    assert.equal(result.meta.partialMonitoringEntryCount, 1);
  } finally {
    data.monitoringRecords[0].history = originalHistory;
  }
});

test("analytics use monitoredDate and deduplicate full cohorts within each month", async () => {
  const originalHistory = data.monitoringRecords[0].history;
  data.monitoringRecords[0].history = [
    { id: "first", monitoredDate: "2026-08-05", monitoredAt: "2026-10-20T00:00:00Z",
      healthyCount: 40, damagedCount: 20, deadCount: 20, totalMonitored: 80,
      cohortQuantityAtObservation: 80, reviewStatus: "Approved" },
    { id: "latest-in-month", monitoredDate: "2026-08-25", monitoredAt: "2026-09-01T00:00:00Z",
      healthyCount: 60, damagedCount: 10, deadCount: 10, totalMonitored: 80,
      cohortQuantityAtObservation: 80, reviewStatus: "Approved" },
  ];
  try {
    const result = await getDashboard({ dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    assert.equal(result.summary.overallSurvivalRate, 87.5,
      "actual monitoredDate, not later submission time, determines the latest observation");
    const august = result.survivalTrend.find((item) => item.period === "Aug 2026");
    assert.equal(august.rate, 87.5,
      "one lifecycle must contribute only its latest full observation in the month");
  } finally {
    data.monitoringRecords[0].history = originalHistory;
  }
});

test("a newer approved partial observation prevents fallback to an older full observation in the same month", async () => {
  const originalHistory = data.monitoringRecords[0].history;
  data.monitoringRecords[0].history = [
    { id: "older-full", monitoredDate: "2026-08-05", healthyCount: 70, damagedCount: 5,
      deadCount: 5, totalMonitored: 80, cohortQuantityAtObservation: 80,
      reviewStatus: "Approved", adminDecision: { decidedBy: "admin-1", decidedAt: "2026-08-06T00:00:00Z" } },
    { id: "newer-partial", monitoredDate: "2026-08-25", healthyCount: 15, damagedCount: 3,
      deadCount: 2, totalMonitored: 20, cohortQuantityAtObservation: 80,
      reviewStatus: "Approved", adminDecision: { decidedBy: "admin-1", decidedAt: "2026-08-26T00:00:00Z" } },
  ];
  try {
    const result = await getDashboard({ dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    assert.equal(result.summary.overallSurvivalRate, null);
    assert.equal(result.meta.latestMonitoringCount, 0);
    assert.equal(result.survivalTrend.find((item) => item.period === "Aug 2026").rate, null);
  } finally {
    data.monitoringRecords[0].history = originalHistory;
  }
});

test("statusless legacy history inherits a validated lifecycle review without including pending entries", async () => {
  const record = data.monitoringRecords[0];
  const originalHistory = record.history;
  const originalReviewStatus = record.reviewStatus;
  record.reviewStatus = "Reviewed";
  record.history = [
    { monitoredDate: "2026-07-01", healthyCount: 40, damagedCount: 20, deadCount: 20, totalMonitored: 80 },
    { monitoredDate: "2026-08-01", healthyCount: 50, damagedCount: 10, deadCount: 20,
      totalMonitored: 80, reviewStatus: "Pending" },
  ];

  try {
    const result = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    assert.equal(result.summary.overallSurvivalRate, 75);
    assert.equal(result.meta.monitoringEntryCount, 1);
  } finally {
    record.history = originalHistory;
    if (originalReviewStatus === undefined) delete record.reviewStatus;
    else record.reviewStatus = originalReviewStatus;
  }
});

test("empty analytics keeps zero chart periods and stable response sections", async () => {
  const saved = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, [...rows]]));
  for (const rows of Object.values(data)) rows.length = 0;
  try {
    const result = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-03-31" });
    assert.deepEqual(result.summary, {
      totalSaplingsDistributed: 0, totalTreesPlanted: 0, overallSurvivalRate: null,
      verifiedPlantingReports: 0, barangaysCovered: 0, activePlantingSites: 0,
    });
    assert.deepEqual(result.plantingTrend.map((item) => item.count), [0, 0, 0]);
    assert.deepEqual(result.survivalTrend.map((item) => item.rate), [null, null, null]);
    assert.deepEqual(result.monitoringConditions.map((item) => item.count), [0, 0, 0]);
    assert.deepEqual(result.siteMap, []);
  } finally {
    for (const [name, rows] of Object.entries(saved)) data[name].push(...rows);
  }
});

test("analytics module: release location, name variants, planting month, final approval, distinct reports and history", async () => {
  const saved = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, [...rows]]));
  for (const rows of Object.values(data)) rows.length = 0;
  data.seedlingInventory.push({ id: "inv-1", species: "Narra" }, { id: "inv-2", species: "narra " }, { id: "inv-3", species: "Pili" });
  data.sites.push({ id: "s1", siteName: "Zone 8 Site", barangay: "Zone VIII Poblacion", status: "active", latitude: 12.67, longitude: 123.87 },
    { id: "s2", siteName: "Bical Site", barangay: "Bical", status: "active", latitude: 12.66, longitude: 123.9 });
  data.events.push({ id: "e1", plantingSiteId: "s1", barangay: "ZoneVIIIPoblacion", date: "2026-03-20" },
    { id: "e2", plantingSiteId: "s2", barangay: "Bical", date: "2026-04-02" });
  data.distributions.push(
    // Released for an event: located at the event's site, not at the requester's home barangay.
    { id: "d1", status: "Released", eventId: "e1", barangay: "Bical", releasedAt: "2026-03-10T17:30:00Z", items: [{ species: "Narra", releasedQuantity: 40 }, { species: "Pili", releasedQuantity: 10 }] },
    // Household use: no planting site. It is distributed, but not planting activity of any barangay.
    { id: "d2", status: "Released", barangay: "Bical", releasedAt: "2026-03-11", items: [{ species: "narra", releasedQuantity: 7 }] },
    { id: "d3", status: "Approved", eventId: "e2", releasedAt: "2026-03-12", items: [{ species: "Narra", releasedQuantity: 99 }] });
  data.plantingReports.push({ id: "r1", reportType: "parent", eventId: "e1", siteId: "s1", barangay: "Zone VIII Poblacion", plantingDate: "2026-03-20" },
    { id: "r2", reportType: "parent", eventId: "e2", siteId: "s2", barangay: "Bical", plantingDate: "2026-04-02" });
  const row = (id, reportId, extra) => ({ id, reportId, quantity: 10, species: "Narra", recordedAt: "2026-05-30T01:00:00Z", ...extra });
  data.plantingContributions.push(
    row("a1", "r1", { quantity: 30, workflowStatus: "Completed", staffReviewStatus: "Accepted" }),
    row("a2", "r1", { quantity: 5, species: "narra", workflowStatus: "Completed", staffReviewStatus: "Accepted" }),
    row("a3", "r1", { workflowStatus: "Reviewed", staffReviewStatus: "Pending Review" }),
    row("a4", "r1", { workflowStatus: "Returned for Correction", staffReviewStatus: "Rejected" }),
    row("a5", "r1", { workflowStatus: "Pending Admin Approval", staffReviewStatus: "Pending Review", officialStaffReport: true }),
    row("b1", "r2", { quantity: 12, species: "Pili", workflowStatus: "Completed", staffReviewStatus: "Accepted" }));
  try {
    const all = await getDashboard({});
    assert.equal(all.summary.totalSaplingsDistributed, 57, "only released quantities, household use included");
    assert.equal(all.summary.totalTreesPlanted, 47, "only Admin-approved rows; reviewed, returned and pending official rows excluded");
    assert.equal(all.summary.verifiedPlantingReports, 2, "one per report, not per row");
    assert.equal(all.summary.barangaysCovered, 2, "Zone VIII spellings are one barangay");
    assert.deepEqual(all.speciesDistribution.map((item) => [item.species, item.planted]), [["Narra", 35], ["Pili", 12]]);
    assert.deepEqual(all.options.barangays, ["Bical", "Zone VIII Poblacion"]);
    assert.deepEqual(all.options.species, ["Narra", "Pili"]);
    const month = (trend, period) => trend.find((item) => item.period === period)?.count;
    assert.equal(month(all.distributionTrend, "Mar 2026"), 57, "released 17:30 UTC on Mar 10 is Mar 11 in Manila, still March");
    assert.equal(month(all.plantingTrend, "Mar 2026"), 35, "grouped by planting day, not by when the report was typed");
    assert.equal(month(all.plantingTrend, "Apr 2026"), 12);
    assert.equal(month(all.plantingTrend, "May 2026"), 0);
    assert.equal(all.distributionTrend[0].period, "Mar 2026", "history before the last six months stays visible");
    const bical = await getDashboard({ barangay: "Bical" });
    assert.equal(bical.summary.totalSaplingsDistributed, 0, "the requester's home barangay is not where seedlings were planted");
    assert.equal(bical.summary.totalTreesPlanted, 12);
    const zone = await getDashboard({ barangay: "zoneviiipoblacion" });
    assert.deepEqual([zone.summary.totalSaplingsDistributed, zone.summary.totalTreesPlanted, zone.barangaySurvival.length], [50, 35, 1]);
    const april = await getDashboard({ dateFrom: "2026-04-01", dateTo: "2026-04-30" });
    assert.deepEqual([april.summary.verifiedPlantingReports, april.summary.totalTreesPlanted, april.summary.totalSaplingsDistributed], [1, 12, 0]);
    const piliSites = await getDashboard({ species: "Pili" });
    assert.deepEqual(piliSites.siteMap.map((site) => [site.id, site.planted]), [["s2", 12]], "the map keeps the site where the species was planted");
    assert.equal(piliSites.summary.activePlantingSites, 1);
    const pili = await getDashboard({ species: "PILI", site: "s1" });
    assert.deepEqual([pili.summary.totalSaplingsDistributed, pili.summary.totalTreesPlanted], [10, 0]);
  } finally {
    for (const [name, rows] of Object.entries(saved)) { data[name].length = 0; data[name].push(...rows); }
  }
});

test("survival trend: weighted by counts, damaged survive, early and partial excluded, gaps stay empty", async () => {
  const saved = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, [...rows]]));
  for (const rows of Object.values(data)) rows.length = 0;
  data.sites.push({ id: "s1", siteName: "S", barangay: "Bical", status: "active" });
  data.plantingReports.push({ id: "r1", siteId: "s1", barangay: "Bical", verificationStatus: "Approved", quantityPlanted: 100, plantingDate: "2026-01-05" },
    { id: "r2", siteId: "s1", barangay: "Bical", verificationStatus: "Approved", quantityPlanted: 10, plantingDate: "2026-01-05" });
  const approved = (monitoredDate, healthyCount, damagedCount, deadCount, extra = {}) => ({ monitoredDate, healthyCount, damagedCount, deadCount, reviewStatus: "Approved", ...extra });
  data.monitoringRecords.push(
    { id: "m1", plantingReportId: "r1", siteId: "s1", barangay: "Bical", quantityPlanted: 100, history: [
      approved("2026-07-10", 80, 10, 10), approved("2026-08-10", 70, 10, 20), approved("2026-08-12", 5, 0, 0, { observationType: "early" }),
      approved("2026-10-10", 60, 0, 10, { isFullCohortAssessment: false }), approved("2026-11-10", 70, 12, 18)] },
    { id: "m2", plantingReportId: "r2", siteId: "s1", barangay: "Bical", quantityPlanted: 10, history: [approved("2026-07-20", 2, 0, 8)] });
  try {
    const result = await getDashboard({ dateFrom: "2026-07-01", dateTo: "2026-11-30" });
    const rate = (period) => result.survivalTrend.find((item) => item.period === period);
    assert.deepEqual([rate("Jul 2026").rate, rate("Jul 2026").checked], [83.64, 110], "(90 + 2) / 110, not the average of 90 % and 20 %");
    assert.equal(rate("Aug 2026").rate, 80, "damaged trees survive; the early observation is not official");
    assert.equal(rate("Sep 2026").rate, null, "no observation is a gap, not 0 %");
    assert.equal(rate("Oct 2026").rate, null, "a partial observation is not an official survival rate");
    assert.equal(rate("Nov 2026").rate, 82);
    // Current KPI: the latest full observation of each lifecycle, weighted: (82 + 2) / (100 + 10).
    assert.equal(result.summary.overallSurvivalRate, 76.36);
    assert.deepEqual(result.monitoringConditions.map((item) => item.count), [72, 12, 26]);
    assert.deepEqual(result.barangaySurvival.map((item) => [item.barangay, item.monitored, item.rate]), [["Bical", 110, 76.36]]);
  } finally {
    for (const [name, rows] of Object.entries(saved)) { data[name].length = 0; data[name].push(...rows); }
  }
});
