const { db } = require("../config/firebase");

const count = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const sum = (records, field) => records.reduce((total, record) => total + count(record[field]), 0);
const month = (timestamp) => {
  const date = timestamp?.toDate?.();
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 7) : null;
};

async function getDashboard() {
  const names = ["seedlingInventory", "seedlingRequests", "distributions", "events", "plantingReports", "monitoringRecords"];
  const snapshots = await Promise.all(names.map((name) => db.collection(name).get()));
  const records = Object.fromEntries(names.map((name, index) => [
    name, snapshots[index].docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  ]));
  const inventory = records.seedlingInventory.filter((item) => item.isDeleted !== true);
  const reports = records.plantingReports.filter((item) => item.verificationStatus === "Approved");
  const monitoring = records.monitoringRecords.filter((item) => item.archived !== true && item.reviewStatus === "Reviewed");
  // A report may have multiple monitoring rounds. Count only its latest reviewed round.
  const latest = new Map();
  for (const record of monitoring) {
    const previous = latest.get(record.plantingReportId);
    if (!previous || count(record.monitoringRound) > count(previous.monitoringRound)) {
      latest.set(record.plantingReportId, record);
    }
  }
  const latestMonitoring = [...latest.values()];
  const monitoredTotal = sum(latestMonitoring, "totalMonitored");
  const surviving = sum(latestMonitoring, "survivingCount");
  const requestStatuses = {};
  for (const request of records.seedlingRequests) {
    const status = request.status || "Unknown";
    requestStatuses[status] = (requestStatuses[status] || 0) + 1;
  }
  const events = records.events.filter((item) => item.archived !== true && ["Tree Planting", "Other MENRO Activity"].includes(item.type));
  const eventTypes = {};
  for (const event of events) eventTypes[event.type] = (eventTypes[event.type] || 0) + 1;
  const trends = {};
  for (const [key, source, field] of [
    ["requests", records.seedlingRequests, "createdAt"],
    ["distributions", records.distributions, "releasedAt"],
    ["verifiedPlantings", reports, "approvedAt"],
    ["monitoring", latestMonitoring, "createdAt"],
  ]) {
    trends[key] = {};
    for (const item of source) {
      const period = month(item[field]);
      if (period) trends[key][period] = (trends[key][period] || 0) + 1;
    }
  }
  const barangayVerifiedPlantings = {};
  for (const report of reports) {
    if (report.barangay) {
      barangayVerifiedPlantings[report.barangay] = (barangayVerifiedPlantings[report.barangay] || 0) + count(report.quantityPlanted);
    }
  }
  return {
    inventory: {
      records: inventory.length,
      totalQuantity: sum(inventory, "quantity"),
      availableQuantity: sum(inventory, "availableQuantity"),
      reservedQuantity: sum(inventory, "reservedQuantity"),
      distributedQuantity: sum(inventory, "distributedQuantity"),
      lowStockRecords: inventory.filter((item) => item.status === "Low Stock").length,
    },
    requests: { total: records.seedlingRequests.length, byStatus: requestStatuses },
    distributions: { total: records.distributions.length, quantityReleased: sum(records.distributions, "totalQuantityReleased") },
    events: { total: events.length, byType: eventTypes },
    planting: { verifiedReports: reports.length, verifiedQuantityPlanted: sum(reports, "quantityPlanted") },
    monitoring: {
      latestReviewedRecords: latestMonitoring.length,
      healthyCount: sum(latestMonitoring, "healthyCount"),
      damagedCount: sum(latestMonitoring, "damagedCount"),
      deadCount: sum(latestMonitoring, "deadCount"),
      survivingCount: surviving,
      survivalRate: monitoredTotal > 0 ? Number((surviving / monitoredTotal * 100).toFixed(2)) : null,
    },
    barangayVerifiedPlantings,
    trends,
  };
}

module.exports = { getDashboard };
