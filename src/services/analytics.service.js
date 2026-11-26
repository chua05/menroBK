const { db } = require("../config/firebase");
const {
  validatedMonitoringHistory,
  monitoringObservationTotal,
  isFullCohortObservation,
  officialNextMonitoringDate,
} = require("../utils/monitoringObservation.util");
const { WORKFLOW_STATUS, deriveWorkflowStatus } = require("../utils/plantingReviewWorkflow.util");
const { summarize: summarizePermanentSamples } = require("./permanentSampleAnalytics.service");
const SAMPLE_CONDITIONS = ["Healthy", "Damaged", "Dead", "Needs Rechecking"];

const COLLECTIONS = [
  "seedlingInventory", "distributions", "events", "plantingReports", "plantingContributions",
  "monitoringRecords", "sites", "sampleMonitoringVisits", "verifiedPlantingCohorts",
];
const CONDITION_NAMES = ["Healthy", "Damaged", "Dead"];
const LOW_SURVIVAL_THRESHOLD = 70;
const text = (value) => String(value || "").trim();
const key = (value) => text(value).toLocaleLowerCase();
// One barangay or species however it was typed: "Zone VIII Poblacion", "ZoneVIIIPoblacion" and "zone viii poblacion" are one place.
const canonical = (value) => key(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
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

function dateValue(value) {
  if (!value) return null;
  const date = typeof value?.toDate === "function"
    ? value.toDate()
    : Number.isFinite(value?._seconds ?? value?.seconds)
      ? new Date(Number(value._seconds ?? value.seconds) * 1000)
      : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function observationOrder(entry) {
  return {
    businessDate: dateOnly(entry.monitoredDate || entry.monitoringDate || entry.date),
    submittedAt: dateValue(entry.monitoredAt || entry.createdAt)?.getTime() || 0,
  };
}

function compareObservations(a, b) {
  const left = observationOrder(a);
  const right = observationOrder(b);
  return left.businessDate.localeCompare(right.businessDate) ||
    left.submittedAt - right.submittedAt ||
    Number(a.__historyIndex || 0) - Number(b.__historyIndex || 0);
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
  if (filters.barangay && filters.barangay !== "All" && canonical(context.barangay) !== canonical(filters.barangay)) return false;
  if (filters.species && filters.species !== "All" && canonical(context.species) !== canonical(filters.species)) return false;
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
// Without a From date the charts start at the earliest month with data (at least the last six months), so earlier official history
// stays visible. At most 120 months are shown.
function monthBuckets(filters, earliestDataMonth = "") {
  const endValue = filters.dateTo || todayInManila();
  const end = new Date(`${endValue}T12:00:00Z`);
  const recent = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1, 12));
  const earliest = /^\d{4}-\d{2}$/.test(earliestDataMonth) ? new Date(`${earliestDataMonth}-01T12:00:00Z`) : null;
  const start = filters.dateFrom ? new Date(`${filters.dateFrom}T12:00:00Z`)
    : earliest && earliest < recent ? new Date(Math.max(earliest.getTime(), Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 119, 1, 12))) : recent;
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
  if (record.scheduleStatus === "AWAITING_MONITORING_POLICY") return "Awaiting Monitoring Setup";
  if (record.monitoringEndDate && today >= record.monitoringEndDate) return "Monitoring Completed";
  const fullHistory = validatedMonitoringHistory(record)
    .filter((entry) => isFullCohortObservation(entry, record));
  const due = fullHistory.length
    ? record.nextMonitoringDate || officialNextMonitoringDate(record)
    : record.startMonitoringDate;
  if (!fullHistory.length && due && today < due) return "Not Yet Available";
  if (fullHistory.length && due && today < due) return "Next Monitoring Scheduled";
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
      for (const contribution of contributions.filter((entry) => entry.staffReviewStatus !== "Rejected" && entry.verificationStatus !== "Invalid" &&
        !entry.reservationReleasedAt && entry.reservationStatus !== "Released")) plantingActivities.push({
        reportId: report.id, quantity: number(contribution.quantity),
        // The planting day, not the day the report was typed.
        date: contribution.plantingDate || report.plantingDate || report.eventDate || eventById.get(report.eventId)?.date || contribution.recordedAt,
        ...context, species: contribution.species || context.species,
        verificationStatus: contribution.verificationStatus || report.verificationStatus,
        staffReviewStatus: contribution.staffReviewStatus || "",
        reportingProgress: report.reportingProgress,
        // A stored workflow stage decides; older rows keep their recorded review state.
        accounted: contribution.workflowStatus ? deriveWorkflowStatus(contribution) === WORKFLOW_STATUS.COMPLETED : contribution.staffReviewStatus === "Accepted" ||
          (contribution.staffApprovalRequired !== true && contribution.verificationStatus === "Verified" &&
            ["", "Not Required", "Accepted"].includes(contribution.staffReviewStatus || "")) ||
          (!contribution.verificationStatus && !contribution.staffReviewStatus &&
            (report.verificationStatus === "Approved" || report.reportingProgress === "Completed")),
      });
    } else if (report.reportType !== "parent") {
      plantingActivities.push({ reportId: report.id, quantity: number(report.quantityPlanted),
        date: report.plantingDate || report.eventDate || report.submittedAt || report.createdAt,
        ...context, verificationStatus: report.verificationStatus, reportingProgress: report.reportingProgress,
        accounted: report.verificationStatus === "Approved" ||
          (report.staffApprovalRequired !== true && report.reportingProgress === "Completed") });
    }
  }
  const filteredRecordedPlanting = plantingActivities.filter((item) => matches(item, filters));
  const filteredPlanting = filteredRecordedPlanting.filter((item) => item.accounted === true);

  const distributionActivities = [];
  for (const distribution of records.distributions.filter((item) => item.archived !== true && key(item.status || "Released") === "released")) {
    // Where the seedlings were planted: the release's site, or its event's site. The requester's home barangay is not a planting
    // location, so a release without a site (e.g. household use) counts in totals but not under any barangay or site.
    const event = eventById.get(distribution.eventId) || {};
    const siteId = distribution.plantingSiteId || event.plantingSiteId || "";
    const site = siteById.get(siteId) || {};
    const base = { date: distribution.releasedAt || distribution.createdAt, siteId,
      siteName: site.siteName || site.name || "",
      barangay: site.barangay || event.barangay || "" };
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
    return {
      ...record,
      ...context,
      quantityPlanted: number(record.quantityPlanted ?? report.quantityPlanted),
      history,
      validatedHistory: validatedMonitoringHistory({
        ...record,
        quantityPlanted: number(record.quantityPlanted ?? report.quantityPlanted),
        history,
      }),
    };
  });
  const lifecycleReportIds = new Set(monitoringLifecycles.map((record) => record.plantingReportId).filter(Boolean));
  for (const report of records.plantingReports) {
    if (report.archived === true || (report.verificationStatus !== "Approved" && report.reportingProgress !== "Completed") || lifecycleReportIds.has(report.id)) continue;
    const baseDate = dateOnly(report.plantingDate || report.eventDate);
    // Purpose-policy reports have no approved lifecycle schedule: never invent the legacy +14-day dates.
    if (report.reportingPolicy) {
      if (report.reportingPolicy.monitoring === "NONE") continue;
      monitoringLifecycles.push({
        id: `eligible-${report.id}`, plantingReportId: report.id, ...reportContext(report),
        authoritativePlantingDate: baseDate || null, startMonitoringDate: null, nextMonitoringDate: null,
        monitoringEndDate: null, scheduleStatus: "AWAITING_MONITORING_POLICY", history: [],
      });
      continue;
    }
    if (!baseDate) continue;
    monitoringLifecycles.push({
      id: `eligible-${report.id}`, plantingReportId: report.id, ...reportContext(report),
      authoritativePlantingDate: baseDate, startMonitoringDate: addDays(baseDate, 14),
      nextMonitoringDate: null, monitoringEndDate: addYears(baseDate, 2), history: [],
    });
  }
  const monitoringEntries = monitoringLifecycles.flatMap((lifecycle) =>
    (lifecycle.validatedHistory || []).map((entry, historyIndex) => ({
    ...entry, lifecycleId: lifecycle.id, plantingReportId: lifecycle.plantingReportId,
    date: entry.monitoredDate || entry.monitoringDate || entry.monitoredAt || entry.createdAt,
    __historyIndex: historyIndex,
    barangay: lifecycle.barangay, species: lifecycle.species, siteId: lifecycle.siteId, siteName: lifecycle.siteName,
    healthy: number(entry.healthyCount ?? entry.healthy), damaged: number(entry.damagedCount ?? entry.damaged),
    dead: number(entry.deadCount ?? entry.dead),
    total: monitoringObservationTotal(entry),
    isFullCohortAssessment: isFullCohortObservation(entry, lifecycle),
  })));
  const filteredMonitoringEntries = monitoringEntries.filter((entry) => matches(entry, filters));
  const latestByLifecycle = new Map();
  for (const entry of [...filteredMonitoringEntries].sort(compareObservations)) {
    latestByLifecycle.set(entry.lifecycleId, entry);
  }
  const latestMonitoring = [...latestByLifecycle.values()]
    .filter((entry) => entry.isFullCohortAssessment);
  const fullMonitoringEntries = filteredMonitoringEntries
    .filter((entry) => entry.isFullCohortAssessment);
  const monitoredTotal = sum(latestMonitoring, (entry) => entry.total);
  const survivingTotal = sum(latestMonitoring, (entry) => entry.healthy + entry.damaged);

  const accountedReportIds = new Set(filteredPlanting.map((item) => item.reportId));
  // A report counts once, by the same rows and planting dates as Verified Trees Planted; resubmissions stay inside their report.
  const approvedReports = records.plantingReports.filter((report) => accountedReportIds.has(report.id));
  const activityScopedSiteIds = new Set(filteredPlanting.map((item) => item.siteId).filter(Boolean));
  const activityScopeRequired = Boolean(filters.species && filters.species !== "All");
  const activeSites = records.sites.filter((site) => site.archived !== true &&
    !["inactive", "archived", "closed"].includes(key(site.status || "active")) &&
    // A site has no species of its own: a species filter keeps the sites where that species was planted (below).
    matches({ barangay: site.barangay, siteId: site.id, siteName: site.siteName || site.name }, { ...filters, species: "" }, { useDate: false }) &&
    (!activityScopeRequired || activityScopedSiteIds.has(site.id)));

  const plantingByMonth = new Map();
  for (const item of filteredPlanting) {
    const period = monthKey(item.date);
    if (period) plantingByMonth.set(period, (plantingByMonth.get(period) || 0) + item.quantity);
  }
  const latestByLifecycleMonth = new Map();
  for (const entry of [...filteredMonitoringEntries].sort(compareObservations)) {
    const period = monthKey(entry.date);
    if (period) latestByLifecycleMonth.set(`${entry.lifecycleId}|${period}`, entry);
  }
  const survivalByMonth = new Map();
  for (const entry of latestByLifecycleMonth.values()) {
    if (!entry.isFullCohortAssessment) continue;
    const period = monthKey(entry.date);
    if (!period) continue;
    const bucket = survivalByMonth.get(period) || { surviving: 0, total: 0 };
    bucket.surviving += entry.healthy + entry.damaged;
    bucket.total += entry.total;
    survivalByMonth.set(period, bucket);
  }
  const conditions = {
    Healthy: sum(latestMonitoring, (entry) => entry.healthy),
    Damaged: sum(latestMonitoring, (entry) => entry.damaged),
    Dead: sum(latestMonitoring, (entry) => entry.dead),
  };
  // Inventory batches of one species share one row; the first spelling seen is shown.
  const species = new Map();
  const speciesRow = (name) => {
    const id = canonical(name);
    if (!species.has(id)) species.set(id, { name: text(name), planted: 0, monitored: 0, survived: 0 });
    return species.get(id);
  };
  for (const item of records.seedlingInventory) {
    const name = text(item.species || item.commonName || item.seedlingName || item.name);
    if (name && (!filters.species || filters.species === "All" || canonical(name) === canonical(filters.species))) speciesRow(name);
  }
  for (const item of filteredPlanting) if (text(item.species)) speciesRow(item.species).planted += item.quantity;
  for (const entry of latestMonitoring) if (text(entry.species)) {
    const row = speciesRow(entry.species);
    row.monitored += entry.total;
    row.survived += entry.healthy + entry.damaged;
  }
  const barangayRows = new Map();
  const barangayRow = (name) => {
    const id = canonical(name);
    if (!barangayRows.has(id)) barangayRows.set(id, { name: text(name), planted: 0, healthy: 0, damaged: 0, dead: 0, surviving: 0, total: 0 });
    return barangayRows.get(id);
  };
  for (const site of activeSites) if (text(site.barangay)) barangayRow(site.barangay);
  for (const item of filteredPlanting) if (text(item.barangay)) barangayRow(item.barangay).planted += item.quantity;
  for (const entry of latestMonitoring) {
    if (!text(entry.barangay)) continue;
    const row = barangayRow(entry.barangay);
    row.healthy += entry.healthy;
    row.damaged += entry.damaged;
    row.dead += entry.dead;
    row.surviving += entry.healthy + entry.damaged;
    row.total += entry.total;
  }

  const today = todayInManila();
  const filteredLifecycles = monitoringLifecycles.filter((lifecycle) => matches({
    ...lifecycle, date: lifecycle.authoritativePlantingDate || lifecycle.plantingDate || lifecycle.eventDate,
  }, filters));
  const lifecycleCounts = { monitoringEligible: 0, monitoringNotYetEligible: 0, monitoringCompleted: 0, monitoringAwaitingSetup: 0 };
  for (const lifecycle of filteredLifecycles) {
    const status = lifecycleStatus(lifecycle, today);
    if (status === "Awaiting Monitoring Setup") lifecycleCounts.monitoringAwaitingSetup += 1;
    else if (status === "Monitoring Completed") lifecycleCounts.monitoringCompleted += 1;
    else if (status === "Not Yet Available" || status === "Next Monitoring Scheduled") lifecycleCounts.monitoringNotYetEligible += 1;
    else lifecycleCounts.monitoringEligible += 1;
  }
  const reviewableContributions = records.plantingContributions.filter((contribution) => {
    const report = reportById.get(contribution.reportId);
    if (!report || report.archived === true) return false;
    return matches({
      ...reportContext(report),
      species: contribution.species || report.species || "",
      date: contribution.recordedAt || contribution.submittedAt || report.submittedAt || report.createdAt,
    }, filters);
  });
  const pendingPlantingReports = reviewableContributions.filter((contribution) =>
    contribution.verificationStatus === "Needs Review" &&
    contribution.staffReviewStatus === "Pending Review").length +
    records.plantingReports.filter((report) => report.archived !== true &&
      (report.reportType !== "parent" || !(contributionsByReport.get(report.id) || []).length) &&
      ["Pending Review", "Reviewed", "Flagged", "Passed Automated Check", "Needs Review"].includes(report.verificationStatus) &&
      matches({ ...reportContext(report), date: report.submittedAt || report.updatedAt || report.createdAt }, filters)).length;
  const totalReleased = sum(filteredDistributions, (item) => item.quantity);
  const totalPlanted = sum(filteredPlanting, (item) => item.quantity);
  const totalRecordedPlanted = sum(filteredRecordedPlanting, (item) => item.quantity);
  // Corrections returned to the submitter are not final rejections (stored field only, so history is unchanged).
  const rejectedReports = reviewableContributions.filter((contribution) =>
    contribution.staffReviewStatus === "Rejected" && contribution.workflowStatus !== "Returned for Correction").length +
    records.plantingReports.filter((report) => report.archived !== true &&
      (report.reportType !== "parent" || !(contributionsByReport.get(report.id) || []).length) &&
    report.verificationStatus === "Rejected" && report.workflowStatus !== "Returned for Correction" &&
    matches({ ...reportContext(report), date: report.rejectedAt || report.reviewedAt || report.updatedAt }, filters)).length;
  const reviewedContributions = reviewableContributions.filter((contribution) =>
    contribution.staffReviewStatus === "Accepted");
  const approvalDurations = [...reviewedContributions.map((contribution) => {
    const started = dateValue(contribution.recordedAt || contribution.submittedAt || contribution.createdAt);
    const ended = dateValue(contribution.reviewedAt || contribution.acceptedAt);
    return !started || !ended || ended < started ? null : (ended - started) / 3_600_000;
  }), ...approvedReports.filter((report) => !(contributionsByReport.get(report.id) || []).length).map((report) => {
    const started = dateValue(report.submittedAt || report.createdAt);
    const ended = dateValue(report.approvedAt || report.reviewedAt);
    return !started || !ended || ended < started
      ? null : (ended - started) / 3_600_000;
  })].filter((value) => value !== null);

  const siteMap = activeSites.map((site) => {
    const sitePlanting = filteredPlanting.filter((item) => item.siteId === site.id);
    const siteMonitoring = latestMonitoring.filter((entry) => entry.siteId === site.id);
    const planted = sum(sitePlanting, (item) => item.quantity);
    const monitored = sum(siteMonitoring, (entry) => entry.total);
    const surviving = sum(siteMonitoring, (entry) => entry.healthy + entry.damaged);
    const damaged = sum(siteMonitoring, (entry) => entry.damaged);
    const dead = sum(siteMonitoring, (entry) => entry.dead);
    const treeCondition = monitored <= 0 ? "Not Yet Monitored"
      : dead === monitored ? "Critical"
        : damaged > 0 || dead > 0 ? "Needs Attention" : "Healthy";
    return ({
    id: site.id,
    siteId: site.siteId || site.id,
    siteName: site.siteName || site.name || site.id,
    barangay: site.barangay || "",
    latitude: site.latitude,
    longitude: site.longitude,
    polygon: Array.isArray(site.polygon) ? site.polygon : [],
    coverageRadiusMeters: number(site.coverageRadiusMeters),
    maximumCapacity: number(site.maximumCapacity),
    planted,
    treeCondition,
    survivalRate: monitored > 0 ? Number(((surviving / monitored) * 100).toFixed(2)) : null,
    status: site.status || "active",
  }); });
  const barangayOptions = new Set();
  const speciesOptions = new Set();
  const optionOf = (options, value) => { if (text(value) && ![...options.values()].some((known) => canonical(known) === canonical(value))) options.add(text(value)); };
  for (const site of records.sites) optionOf(barangayOptions, site.barangay);
  for (const activity of plantingActivities) {
    optionOf(barangayOptions, activity.barangay);
    optionOf(speciesOptions, activity.species);
  }
  for (const item of records.seedlingInventory) optionOf(speciesOptions, item.species || item.commonName || item.seedlingName || item.name);

  const lowSurvivalBarangays = [...barangayRows.values()].filter((row) => row.total > 0 &&
    (row.surviving / row.total) * 100 < LOW_SURVIVAL_THRESHOLD).map((row) => ({
      barangay: row.name,
      rate: Number(((row.surviving / row.total) * 100).toFixed(2)),
    })).sort((a, b) => a.rate - b.rate);
  const distributionByMonth = new Map();
  for (const item of filteredDistributions) {
    const period = monthKey(item.date);
    if (period) distributionByMonth.set(period, (distributionByMonth.get(period) || 0) + item.quantity);
  }
  let earliestDataMonth = [...distributionByMonth.keys(), ...plantingByMonth.keys(), ...survivalByMonth.keys()].sort()[0] || "";
  const permanentSample = permanentSampleAnalytics(records, filters, { siteById, reportById });
  for (const row of permanentSample.trend) if (!earliestDataMonth || row.month < earliestDataMonth) earliestDataMonth = row.month;
  const periods = monthBuckets(filters, earliestDataMonth);

  return {
    summary: {
      totalSaplingsDistributed: totalReleased, totalTreesPlanted: totalPlanted,
      overallSurvivalRate: monitoredTotal > 0
        ? Number(((survivingTotal / monitoredTotal) * 100).toFixed(2))
        : null,
      verifiedPlantingReports: approvedReports.length,
      barangaysCovered: new Set(filteredPlanting.map((item) => canonical(item.barangay)).filter(Boolean)).size,
      activePlantingSites: activeSites.length,
    },
    distributionTrend: periods.map((period) => ({ period: period.period, count: distributionByMonth.get(period.key) || 0 })),
    plantingTrend: periods.map((period) => ({ period: period.period, count: plantingByMonth.get(period.key) || 0 })),
    // A month without official observations is null (a gap), never 0 %.
    survivalTrend: periods.map((period) => {
      const row = survivalByMonth.get(period.key);
      return { period: period.period, rate: row?.total > 0 ? Number(((row.surviving / row.total) * 100).toFixed(2)) : null,
        checked: row?.total || 0, surviving: row?.surviving || 0 };
    }),
    monitoringConditions: CONDITION_NAMES.map((condition) => ({ condition, count: conditions[condition] || 0 })),
    speciesDistribution: [...species.values()].map((row) => ({
      species: row.name, planted: row.planted, monitored: row.monitored, survived: row.survived,
      survivalRate: row.monitored > 0 ? Number(((row.survived / row.monitored) * 100).toFixed(2)) : null,
    })).sort((a, b) => b.planted - a.planted || a.species.localeCompare(b.species)),
    barangaySurvival: [...barangayRows.values()].map((row) => ({
      barangay: row.name, planted: row.planted, monitored: row.total,
      rate: row.total > 0 ? Number(((row.surviving / row.total) * 100).toFixed(2)) : null,
      status: row.total <= 0 ? null
        : row.dead === row.total ? "Critical"
          : row.damaged > 0 || row.dead > 0 ? "Needs Attention" : "Healthy",
    })).sort((a, b) => b.planted - a.planted || (b.rate ?? -1) - (a.rate ?? -1) || a.barangay.localeCompare(b.barangay)),
    siteMap,
    // Approved Monitor Planted Trees visits: sampled trees, kept apart from the whole-cohort official observations above.
    permanentSample: {
      summary: permanentSample.summary,
      conditions: SAMPLE_CONDITIONS.map((condition) => ({ condition, count: permanentSample.conditions[condition] })),
      trend: periods.map((period) => {
        const row = permanentSample.trend.find((item) => item.month === period.key);
        return { period: period.period, rate: row?.rate ?? null, checked: row?.checked || 0, surviving: row?.surviving || 0, visits: row?.visits || 0 };
      }),
      cohorts: permanentSample.cohorts,
      exclusions: permanentSample.exclusions,
    },
    verificationAnalytics: {
      approved: approvedReports.length,
      pending: pendingPlantingReports,
      rejected: rejectedReports,
      averageApprovalHours: approvalDurations.length
        ? Number((approvalDurations.reduce((total, value) => total + value, 0) / approvalDurations.length).toFixed(1))
        : null,
    },
    accountability: {
      released: totalReleased,
      verifiedPlanted: totalPlanted,
      difference: Math.max(0, totalReleased - totalPlanted),
    },
    decisionSupport: {
      pendingPlantingReports, ...lifecycleCounts,
      eligibleWithoutSubmission: filteredLifecycles.filter((lifecycle) => lifecycleStatus(lifecycle, today) === "Available for Monitoring" && lifecycle.history.length === 0).length,
      damagedTrees: conditions.Damaged || 0, deadTrees: conditions.Dead || 0,
      releasedQuantity: totalReleased, recordedPlantedQuantity: totalRecordedPlanted,
      verifiedPlantedQuantity: totalPlanted,
      distributionPlantingDifference: Math.max(0, totalReleased - totalPlanted),
      lowSurvivalThreshold: LOW_SURVIVAL_THRESHOLD,
      lowSurvivalBarangays,
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
      monitoringEntryCount: fullMonitoringEntries.length,
      partialMonitoringEntryCount: filteredMonitoringEntries.length - fullMonitoringEntries.length,
      latestMonitoringCount: latestMonitoring.length,
      monitoringDenominator: "Latest actual monitoring entry per lifecycle",
    },
  };
}

// Permanent-sample results of Admin-approved Monitor Planted Trees visits (the same rules as the Permanent Sample analytics page).
// One latest approved visit per cohort gives the current figures, so a Tree ID assessed in Visit 1 and Visit 2 counts once. A
// survival rate is given only for a visit with every sample tree assessed and none awaiting rechecking.
function permanentSampleAnalytics(records, filters, { siteById, reportById }) {
  const release = require("../config/permanentSampleRelease");
  const policy = release.resolve();
  const cohorts = records.verifiedPlantingCohorts.filter((cohort) => release.allowsCohort(cohort.id, policy));
  const visits = records.sampleMonitoringVisits.filter((visit) => visit.status === "APPROVED");
  const { cohorts: summarized, exclusions } = summarizePermanentSamples(cohorts, visits);
  const visitById = new Map(visits.map((visit) => [visit.id, visit]));
  const cohortById = new Map(cohorts.map((cohort) => [cohort.id, cohort]));
  const speciesFilter = filters.species && filters.species !== "All" ? canonical(filters.species) : "";
  const tally = (samples) => {
    const counts = Object.fromEntries(SAMPLE_CONDITIONS.map((condition) => [condition, 0]));
    for (const sample of samples) if (sample.condition) counts[sample.condition] += 1;
    const assessed = SAMPLE_CONDITIONS.reduce((total, condition) => total + counts[condition], 0);
    const complete = samples.length > 0 && assessed === samples.length && counts["Needs Rechecking"] === 0;
    return { counts, total: samples.length, complete, surviving: counts.Healthy + counts.Damaged };
  };
  const rows = [];
  for (const entry of summarized) {
    const cohort = cohortById.get(entry.cohortId) || {};
    const site = siteById.get(entry.siteId) || {};
    const report = reportById.get(cohort.source?.plantingReportId) || {};
    const context = { siteId: entry.siteId, siteName: site.siteName || site.name || "", barangay: site.barangay || report.barangay || "" };
    if (!matches({ ...context, species: "" }, { ...filters, species: "" }, { useDate: false })) continue;
    // Species is known per sample tree; a cohort whose trees carry no species cannot be split by species.
    const speciesOf = new Map((cohort.baseline?.sampleUnits || []).map((unit) => [unit.permanentId, canonical(unit.species)]));
    const keep = (sample) => !speciesFilter || speciesOf.get(sample.sampleId) === speciesFilter;
    const history = entry.history.map((item) => {
      const visit = visitById.get(item.visitId) || {};
      return { ...item, date: dateOnly(visit.dateMonitored || item.visitDate), visitNumber: Number(visit.visitNumber) || null, ...tally(item.samples.filter(keep)) };
    }).filter((item) => item.total > 0 && item.date && (!filters.dateFrom || item.date >= filters.dateFrom) && (!filters.dateTo || item.date <= filters.dateTo));
    if (history.length) rows.push({ entry, context, report, history });
  }
  const latest = rows.map((row) => ({ ...row, last: row.history.at(-1) }));
  const conditions = Object.fromEntries(SAMPLE_CONDITIONS.map((condition) => [condition, latest.reduce((total, row) => total + row.last.counts[condition], 0)]));
  const complete = latest.filter((row) => row.last.complete);
  const checked = complete.reduce((total, row) => total + row.last.total, 0);
  const surviving = complete.reduce((total, row) => total + row.last.surviving, 0);
  const byMonth = new Map();
  for (const row of rows) {
    const inMonth = new Map();
    for (const item of row.history) inMonth.set(monthKey(item.date), item);
    for (const [month, item] of inMonth) {
      const bucket = byMonth.get(month) || { month, checked: 0, surviving: 0, visits: 0 };
      bucket.visits += 1;
      if (item.complete) { bucket.checked += item.total; bucket.surviving += item.surviving; }
      byMonth.set(month, bucket);
    }
  }
  return {
    summary: {
      survivalRate: checked > 0 ? Number(((surviving / checked) * 100).toFixed(2)) : null,
      totalSampleTrees: latest.reduce((total, row) => total + row.last.total, 0),
      monitoredCohorts: latest.length,
      cohortsAwaitingRechecking: latest.length - complete.length,
      approvedVisits: rows.reduce((total, row) => total + row.history.length, 0),
      latestApprovedMonitoringDate: latest.map((row) => row.last.date).sort().at(-1) || null,
    },
    conditions,
    trend: [...byMonth.values()].map((row) => ({ ...row, rate: row.checked > 0 ? Number(((row.surviving / row.checked) * 100).toFixed(2)) : null })),
    cohorts: latest.map((row) => ({
      cohortId: row.entry.cohortId, reportNumber: row.report.reportNumber || "", siteName: row.context.siteName, barangay: row.context.barangay,
      visitNumber: row.last.visitNumber, date: row.last.date, total: row.last.total, ...Object.fromEntries(SAMPLE_CONDITIONS.map((condition) => [condition, row.last.counts[condition]])),
      survivalRate: row.last.complete ? Number(((row.last.surviving / row.last.total) * 100).toFixed(2)) : null,
    })).sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.reportNumber.localeCompare(b.reportNumber)),
    exclusions,
  };
}

module.exports = { getDashboard, cleanFilters, dateOnly, lifecycleStatus };
