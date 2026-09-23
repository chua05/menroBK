const { db } = require("../config/firebase");

const COLLECTIONS = [
  "distributions", "events", "plantingReports", "plantingContributions",
  "monitoringRecords", "sites",
];
const CONDITION_NAMES = ["Healthy", "Damaged", "Dead"];
const text = (value) => String(value || "").trim();
const key = (value) => text(value).toLocaleLowerCase();
const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};
const sum = (rows, getter) => rows.reduce((total, row) => total + number(getter(row)), 0);

function dateOnly(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const date = typeof value?.toDate === "function"
    ? value.toDate()
    : Number.isFinite(value?._seconds ?? value?.seconds)
      ? new Date(Number(value._seconds ?? value.seconds) * 1000)
      : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return /^(\d{4}-\d{2}-\d{2})/.exec(String(value))?.[1] || "";
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function todayInManila() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function cleanFilters(input = {}) {
  const filters = {
    dateFrom: text(input.dateFrom), dateTo: text(input.dateTo), barangay: text(input.barangay),
    species: text(input.species), site: text(input.site),
  };
  for (const field of ["dateFrom", "dateTo"]) {
    if (filters[field] && !/^\d{4}-\d{2}-\d{2}$/.test(filters[field])) throw new Error("Invalid analytics date filter.");
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) throw new Error("Date From cannot be later than Date To.");
  return filters;
}

function matches(context, filters, { useDate = true } = {}) {
  const date = dateOnly(context.date);
  if (useDate && filters.dateFrom && (!date || date < filters.dateFrom)) return false;
  if (useDate && filters.dateTo && (!date || date > filters.dateTo)) return false;
  if (filters.barangay && filters.barangay !== "All" && key(context.barangay) !== key(filters.barangay)) return false;
  if (filters.species && filters.species !== "All" && key(context.species) !== key(filters.species)) return false;
  if (filters.site && filters.site !== "All" && ![context.siteId, context.siteName].some((value) => key(value) === key(filters.site))) return false;
  return true;
}

function monthKey(value) { return dateOnly(value).slice(0, 7); }
function addDays(value, days) {
  const date = new Date(`${dateOnly(value)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}
function addYears(value, years) {
  const source = new Date(`${dateOnly(value)}T12:00:00Z`);
  if (Number.isNaN(source.getTime())) return "";
  const day = source.getUTCDate();
  const month = source.getUTCMonth();
  const year = source.getUTCFullYear() + years;
  const last = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
  return dateOnly(new Date(Date.UTC(year, month, Math.min(day, last), 12)));
}
function monthLabel(value) {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-PH", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}
function monthBuckets(filters) {
  const endValue = filters.dateTo || todayInManila();
  const end = new Date(`${endValue}T12:00:00Z`);
  const start = filters.dateFrom ? new Date(`${filters.dateFrom}T12:00:00Z`)
    : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1, 12));
  start.setUTCDate(1);
  const result = [];
  const cursor = new Date(start);
  while (cursor <= end && result.length < 120) {
    const value = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`;
    result.push({ key: value, period: monthLabel(value) });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result.length ? result : [{ key: endValue.slice(0, 7), period: monthLabel(endValue.slice(0, 7)) }];
}

function lifecycleStatus(record, today) {
  if (record.monitoringEndDate && today >= record.monitoringEndDate) return "Monitoring Completed";
  const history = Array.isArray(record.history) ? record.history : [];
  const due = history.length ? record.nextMonitoringDate : record.startMonitoringDate;
  if (!history.length && due && today < due) return "Not Yet Available";
  if (history.length && (!due || today < due)) return "Next Monitoring Scheduled";
  return "Available for Monitoring";
}

async function loadCollections() {
  const snapshots = await Promise.all(COLLECTIONS.map((name) => db.collection(name).get()));
  return Object.fromEntries(COLLECTIONS.map((name, index) => [name,
    snapshots[index].docs.map((doc) => ({ id: doc.id, ...doc.data() }))]));
}

async function getDashboard(rawFilters = {}) {
  const filters = cleanFilters(rawFilters);
  const records = await loadCollections();
  const siteById = new Map(records.sites.map((site) => [site.id, site]));
  const eventById = new Map(records.events.map((event) => [event.id, event]));
  const reportById = new Map(records.plantingReports.map((report) => [report.id, report]));
  const contributionsByReport = new Map();
  for (const contribution of records.plantingContributions) {
    const list = contributionsByReport.get(contribution.reportId) || [];
    list.push(contribution);
    contributionsByReport.set(contribution.reportId, list);
  }
  const reportContext = (report) => {
    const event = eventById.get(report.eventId) || {};
    const siteId = report.siteId || report.plantingSiteId || event.plantingSiteId || "";
    const site = siteById.get(siteId) || {};
    return {
      siteId, siteName: report.siteName || event.plantingSiteName || site.siteName || site.name || "",
      barangay: report.barangay || event.barangay || site.barangay || "", species: report.species || "",
    };
  };

  const plantingActivities = [];
  for (const report of records.plantingReports.filter((item) => item.archived !== true)) {
    const context = reportContext(report);
    const contributions = contributionsByReport.get(report.id) || [];
    if (contributions.length) {
      for (const contribution of contributions) plantingActivities.push({
        reportId: report.id, quantity: number(contribution.quantity),
        date: contribution.recordedAt || contribution.plantingDate || report.plantingDate || report.eventDate,
        ...context, species: contribution.species || context.species,
      });
    } else if (report.reportType !== "parent") {
      plantingActivities.push({ reportId: report.id, quantity: number(report.quantityPlanted),
        date: report.plantingDate || report.eventDate || report.submittedAt || report.createdAt, ...context });
    }
  }
  const filteredPlanting = plantingActivities.filter((item) => matches(item, filters));

  const distributionActivities = [];
  for (const distribution of records.distributions.filter((item) => item.archived !== true && key(item.status || "Released") === "released")) {
    const siteId = distribution.plantingSiteId || "";
    const site = siteById.get(siteId) || {};
    const base = { date: distribution.releasedAt || distribution.createdAt, siteId,
      siteName: site.siteName || site.name || distribution.plantingLocation || "",
      barangay: site.barangay || distribution.barangay || "" };
    const items = Array.isArray(distribution.items) ? distribution.items : [];
    if (items.length) {
      for (const item of items) distributionActivities.push({ ...base,
        quantity: number(item.releasedQuantity ?? item.quantity), species: item.species || "" });
    } else distributionActivities.push({ ...base, quantity: number(distribution.totalQuantityReleased), species: distribution.species || "" });
  }
  const filteredDistributions = distributionActivities.filter((item) => matches(item, filters));

  const monitoringLifecycles = records.monitoringRecords.filter((record) => record.archived !== true).map((record) => {
    const report = reportById.get(record.plantingReportId) || {};
    const context = reportContext({ ...report, ...record });
    const history = Array.isArray(record.history) ? record.history
      : (record.monitoredDate || record.monitoringDate || record.createdAt) ? [{ ...record }] : [];
    return { ...record, ...context, history };
  });
  const lifecycleReportIds = new Set(monitoringLifecycles.map((record) => record.plantingReportId).filter(Boolean));
  for (const report of records.plantingReports) {
    if (report.archived === true || report.verificationStatus !== "Approved" || lifecycleReportIds.has(report.id)) continue;
    const baseDate = dateOnly(report.plantingDate || report.eventDate);
    if (!baseDate) continue;
    monitoringLifecycles.push({
      id: `eligible-${report.id}`, plantingReportId: report.id, ...reportContext(report),
      authoritativePlantingDate: baseDate, startMonitoringDate: addDays(baseDate, 14),
      nextMonitoringDate: null, monitoringEndDate: addYears(baseDate, 2), history: [],
    });
  }
  const monitoringEntries = monitoringLifecycles.flatMap((lifecycle) => lifecycle.history.map((entry) => ({
    ...entry, lifecycleId: lifecycle.id, plantingReportId: lifecycle.plantingReportId,
    date: entry.monitoredAt || entry.monitoredDate || entry.monitoringDate || entry.createdAt,
    barangay: lifecycle.barangay, species: lifecycle.species, siteId: lifecycle.siteId, siteName: lifecycle.siteName,
    healthy: number(entry.healthyCount ?? entry.healthy), damaged: number(entry.damagedCount ?? entry.damaged),
    dead: number(entry.deadCount ?? entry.dead),
    total: number(entry.totalMonitored ?? entry.totalChecked) || number(entry.healthyCount ?? entry.healthy) +
      number(entry.damagedCount ?? entry.damaged) + number(entry.deadCount ?? entry.dead),
  })));
  const filteredMonitoringEntries = monitoringEntries.filter((entry) => matches(entry, filters));
  const latestByLifecycle = new Map();
  for (const entry of filteredMonitoringEntries.sort((a, b) => dateOnly(a.date).localeCompare(dateOnly(b.date)))) latestByLifecycle.set(entry.lifecycleId, entry);
  const latestMonitoring = [...latestByLifecycle.values()];
  const monitoredTotal = sum(latestMonitoring, (entry) => entry.total);
  const survivingTotal = sum(latestMonitoring, (entry) => entry.healthy + entry.damaged);

  const approvedReports = records.plantingReports.filter((report) => report.archived !== true && report.verificationStatus === "Approved" &&
    matches({ ...reportContext(report), date: report.approvedAt || report.reviewedAt || report.updatedAt }, filters));
  const activityScopedSiteIds = new Set(filteredPlanting.map((item) => item.siteId).filter(Boolean));
  const activityScopeRequired = Boolean(filters.dateFrom || filters.dateTo || (filters.species && filters.species !== "All"));
  const activeSites = records.sites.filter((site) => site.archived !== true &&
    !["inactive", "archived", "closed"].includes(key(site.status || "active")) &&
    matches({ barangay: site.barangay, siteId: site.id, siteName: site.siteName || site.name }, filters, { useDate: false }) &&
    (!activityScopeRequired || activityScopedSiteIds.has(site.id)));

  const buckets = monthBuckets(filters);
  const plantingByMonth = new Map(buckets.map((bucket) => [bucket.key, 0]));
  for (const item of filteredPlanting) {
    const period = monthKey(item.date);
    if (plantingByMonth.has(period)) plantingByMonth.set(period, plantingByMonth.get(period) + item.quantity);
  }
  const survivalByMonth = new Map(buckets.map((bucket) => [bucket.key, { surviving: 0, total: 0 }]));
  for (const entry of filteredMonitoringEntries) {
    const period = monthKey(entry.date);
    if (!survivalByMonth.has(period)) continue;
    const bucket = survivalByMonth.get(period);
    bucket.surviving += entry.healthy + entry.damaged;
    bucket.total += entry.total;
  }
  const conditions = {
    Healthy: sum(latestMonitoring, (entry) => entry.healthy),
    Damaged: sum(latestMonitoring, (entry) => entry.damaged),
    Dead: sum(latestMonitoring, (entry) => entry.dead),
  };
  const species = new Map();
  for (const item of filteredPlanting) if (text(item.species)) species.set(item.species, (species.get(item.species) || 0) + item.quantity);
  const barangayRows = new Map();
  for (const barangay of new Set(filteredPlanting.map((item) => text(item.barangay)).filter(Boolean))) barangayRows.set(barangay, { surviving: 0, total: 0 });
  for (const entry of latestMonitoring) {
    if (!text(entry.barangay)) continue;
    const row = barangayRows.get(entry.barangay) || { surviving: 0, total: 0 };
    row.surviving += entry.healthy + entry.damaged;
    row.total += entry.total;
    barangayRows.set(entry.barangay, row);
  }

  const today = todayInManila();
  const filteredLifecycles = monitoringLifecycles.filter((lifecycle) => matches({
    ...lifecycle, date: lifecycle.authoritativePlantingDate || lifecycle.plantingDate || lifecycle.eventDate,
  }, filters));
  const lifecycleCounts = { monitoringEligible: 0, monitoringNotYetEligible: 0, monitoringCompleted: 0 };
  for (const lifecycle of filteredLifecycles) {
    const status = lifecycleStatus(lifecycle, today);
    if (status === "Monitoring Completed") lifecycleCounts.monitoringCompleted += 1;
    else if (status === "Not Yet Available" || status === "Next Monitoring Scheduled") lifecycleCounts.monitoringNotYetEligible += 1;
    else lifecycleCounts.monitoringEligible += 1;
  }
  const pendingPlantingReports = records.plantingReports.filter((report) => report.archived !== true &&
    ["Pending Review", "Reviewed", "Flagged", "Passed Automated Check"].includes(report.verificationStatus) &&
    matches({ ...reportContext(report), date: report.submittedAt || report.updatedAt || report.createdAt }, filters)).length;
  const totalReleased = sum(filteredDistributions, (item) => item.quantity);
  const totalPlanted = sum(filteredPlanting, (item) => item.quantity);
  const barangayOptions = new Set();
  const speciesOptions = new Set();
  for (const site of records.sites) if (text(site.barangay)) barangayOptions.add(site.barangay);
  for (const activity of plantingActivities) {
    if (text(activity.barangay)) barangayOptions.add(activity.barangay);
    if (text(activity.species)) speciesOptions.add(activity.species);
  }

  return {
    summary: {
      totalSaplingsDistributed: totalReleased, totalTreesPlanted: totalPlanted,
      overallSurvivalRate: monitoredTotal > 0 ? Number(((survivingTotal / monitoredTotal) * 100).toFixed(2)) : 0,
      verifiedPlantingReports: approvedReports.length,
      barangaysCovered: new Set(approvedReports.map((report) => text(reportContext(report).barangay)).filter(Boolean)).size,
      activePlantingSites: activeSites.length,
    },
    plantingTrend: buckets.map((bucket) => ({ period: bucket.period, count: plantingByMonth.get(bucket.key) || 0 })),
    survivalTrend: buckets.map((bucket) => {
      const row = survivalByMonth.get(bucket.key);
      return { period: bucket.period, rate: row.total > 0 ? Number(((row.surviving / row.total) * 100).toFixed(2)) : 0 };
    }),
    monitoringConditions: CONDITION_NAMES.map((condition) => ({ condition, count: conditions[condition] || 0 })),
    speciesDistribution: [...species.entries()].map(([name, count]) => ({ species: name, count })).sort((a, b) => b.count - a.count),
    barangaySurvival: [...barangayRows.entries()].map(([barangay, row]) => ({
      barangay, rate: row.total > 0 ? Number(((row.surviving / row.total) * 100).toFixed(2)) : 0,
    })).sort((a, b) => b.rate - a.rate),
    decisionSupport: {
      pendingPlantingReports, ...lifecycleCounts,
      eligibleWithoutSubmission: filteredLifecycles.filter((lifecycle) => lifecycleStatus(lifecycle, today) === "Available for Monitoring" && lifecycle.history.length === 0).length,
      damagedTrees: conditions.Damaged || 0, deadTrees: conditions.Dead || 0,
      releasedQuantity: totalReleased, recordedPlantedQuantity: totalPlanted,
      distributionPlantingDifference: totalReleased - totalPlanted,
    },
    options: {
      barangays: [...barangayOptions].sort((a, b) => a.localeCompare(b)),
      species: [...speciesOptions].sort((a, b) => a.localeCompare(b)),
      sites: records.sites.filter((site) => site.archived !== true).map((site) => ({ value: site.id, label: site.siteName || site.name || site.id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
    meta: {
      generatedAt: new Date().toISOString(), filters,
      plantingActivityCount: filteredPlanting.length,
      monitoringEntryCount: filteredMonitoringEntries.length,
      monitoringDenominator: "Latest actual monitoring entry per lifecycle",
    },
  };
}

module.exports = { getDashboard, cleanFilters, dateOnly, lifecycleStatus };
