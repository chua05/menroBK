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
      { monitoredDate: "2026-06-15", healthyCount: 50, damagedCount: 20, deadCount: 10, totalMonitored: 80 },
      { monitoredDate: "2026-08-01", healthyCount: 60, damagedCount: 10, deadCount: 10, totalMonitored: 80 },
    ] }],
  sites: [{ id: "site-1", siteName: "Bical Site", barangay: "Bical", status: "Active" }],
};

const db = { collection: (name) => ({ get: async () => ({ docs: data[name].map((row) => ({ id: row.id, data: () => row })) }) }) };
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const { getDashboard } = require("../src/services/analytics.service");

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
  assert.deepEqual(empty.survivalTrend.map((item) => item.rate), [0, 0, 0]);
  assert.equal(empty.summary.overallSurvivalRate, 0);
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

test("empty analytics keeps zero chart periods and stable response sections", async () => {
  const saved = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, [...rows]]));
  for (const rows of Object.values(data)) rows.length = 0;
  try {
    const result = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-03-31" });
    assert.deepEqual(result.summary, {
      totalSaplingsDistributed: 0, totalTreesPlanted: 0, overallSurvivalRate: 0,
      verifiedPlantingReports: 0, barangaysCovered: 0, activePlantingSites: 0,
    });
    assert.deepEqual(result.plantingTrend.map((item) => item.count), [0, 0, 0]);
    assert.deepEqual(result.survivalTrend.map((item) => item.rate), [0, 0, 0]);
    assert.deepEqual(result.monitoringConditions.map((item) => item.count), [0, 0, 0]);
    assert.deepEqual(result.siteMap, []);
  } finally {
    for (const [name, rows] of Object.entries(saved)) data[name].push(...rows);
  }
});
