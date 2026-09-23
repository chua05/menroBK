const assert = require("node:assert/strict");
const test = require("node:test");

const data = {
  seedlingInventory: [], seedlingRequests: [],
  distributions: [{ id: "dist-1", status: "Released", plantingSiteId: "site-1", releasedAt: "2026-05-10", totalQuantityReleased: 80,
    items: [{ species: "Narra", releasedQuantity: 50 }, { species: "Molave", releasedQuantity: 30 }] }],
  events: [{ id: "event-1", plantingSiteId: "site-1", barangay: "Bacolod" }],
  plantingReports: [
    { id: "report-1", reportType: "parent", eventId: "event-1", siteId: "site-1", barangay: "Bacolod", quantityPlanted: 80,
      verificationStatus: "Approved", approvedAt: "2026-06-20", eventDate: "2026-06-01" },
    { id: "pending-1", reportType: "parent", eventId: "event-1", siteId: "site-1", barangay: "Bacolod",
      verificationStatus: "Pending Review", submittedAt: "2026-06-21", quantityPlanted: 5 },
  ],
  plantingContributions: [
    { id: "c1", reportId: "report-1", species: "Narra", quantity: 50, recordedAt: "2026-06-01" },
    { id: "c2", reportId: "report-1", species: "Molave", quantity: 20, recordedAt: "2026-06-01" },
    { id: "c3", reportId: "report-1", species: "Molave", quantity: 10, recordedAt: "2026-06-02" },
  ],
  monitoringRecords: [{ id: "monitor-1", plantingReportId: "report-1", siteId: "site-1", barangay: "Bacolod", species: "Narra",
    startMonitoringDate: "2026-06-15", nextMonitoringDate: "2026-09-01", monitoringEndDate: "2028-06-01",
    history: [
      { monitoredDate: "2026-06-15", healthyCount: 50, damagedCount: 20, deadCount: 10, totalMonitored: 80 },
      { monitoredDate: "2026-08-01", healthyCount: 60, damagedCount: 10, deadCount: 10, totalMonitored: 80 },
    ] }],
  sites: [{ id: "site-1", siteName: "Bacolod Site", barangay: "Bacolod", status: "Active" }],
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

test("analytics filters remain synchronized and valid empty periods retain zero buckets", async () => {
  const narra = await getDashboard({ dateFrom: "2026-01-01", dateTo: "2026-12-31", species: "Narra" });
  assert.equal(narra.summary.totalSaplingsDistributed, 50);
  assert.equal(narra.summary.totalTreesPlanted, 50);
  const empty = await getDashboard({ dateFrom: "2025-01-01", dateTo: "2025-03-31" });
  assert.equal(empty.summary.totalTreesPlanted, 0);
  assert.deepEqual(empty.plantingTrend.map((row) => row.count), [0, 0, 0]);
  assert.deepEqual(empty.survivalTrend.map((row) => row.rate), [0, 0, 0]);
});
