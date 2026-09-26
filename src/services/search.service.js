const { db } = require("../config/firebase");

const FETCH_LIMIT = 75;
const clean = (value) => String(value ?? "").trim();
const searchable = (...values) => values.flat().filter(Boolean).join(" ").toLowerCase();
const matches = (query, ...values) => searchable(...values).includes(query);
const docs = (snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

async function limitedCollection(name) {
  return docs(await db.collection(name).limit(FETCH_LIMIT).get());
}

function result(type, record, title, subtitle, path) {
  return { type, id: record.id, title, subtitle, path };
}

async function globalSearch({ query, role, userId, limit = 10 }) {
  const normalizedQuery = clean(query).toLowerCase();
  if (normalizedQuery.length < 2) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 20);
  const isParticipant = role === "participant";

  const [events, sites, requests, reports, monitoring] = await Promise.all([
    limitedCollection("events"),
    limitedCollection("sites"),
    isParticipant
      ? docs(await db.collection("seedlingRequests").where("participantId", "==", userId).limit(FETCH_LIMIT).get())
      : limitedCollection("seedlingRequests"),
    isParticipant
      ? docs(await db.collection("plantingReports").where("participantId", "==", userId).limit(FETCH_LIMIT).get())
      : limitedCollection("plantingReports"),
    isParticipant
      ? docs(await db.collection("monitoringRecords").where("participantId", "==", userId).limit(FETCH_LIMIT).get())
      : limitedCollection("monitoringRecords"),
  ]);

  if (isParticipant) {
    const contributionSnapshot = await db.collection("plantingContributions")
      .where("contributorId", "==", userId).limit(FETCH_LIMIT).get();
    const ownedIds = new Set(reports.map((record) => record.id));
    const contributedIds = [...new Set(docs(contributionSnapshot).map((item) => item.reportId).filter(Boolean))]
      .filter((id) => !ownedIds.has(id));
    const contributedDocs = await Promise.all(
      contributedIds.slice(0, FETCH_LIMIT).map((id) => db.collection("plantingReports").doc(id).get())
    );
    contributedDocs.filter((doc) => doc.exists).forEach((doc) => reports.push({ id: doc.id, ...doc.data() }));
  }

  const results = [];
  events.filter((event) => event.archived !== true && matches(normalizedQuery,
    event.eventNumber, event.id, event.name, event.barangay, event.plantingSiteName, event.date
  )).forEach((event) => results.push(result(
    "Event", event, event.name || event.eventNumber || event.id,
    [event.eventNumber, event.date, event.barangay].filter(Boolean).join(" · "),
    `/${role}/event-calendar?event=${encodeURIComponent(event.id)}`
  )));

  sites.filter((site) => site.isDeleted !== true && matches(normalizedQuery,
    site.siteNumber, site.siteId, site.id, site.siteName, site.name, site.barangay
  )).forEach((site) => results.push(result(
    "Planting Site", site, [site.siteNumber || site.siteId, site.siteName || site.name].filter(Boolean).join(" — ") || site.id,
    [site.barangay, "Juban"].filter(Boolean).join(", "),
    `/${role}/planting-sites?site=${encodeURIComponent(site.id)}`
  )));

  requests.filter((request) => matches(normalizedQuery,
    request.requestNumber, request.id, request.participantName, request.status
  )).forEach((request) => results.push(result(
    "Sapling Request", request, request.requestNumber || request.id,
    [isParticipant ? "Sapling Request" : request.participantName, request.status].filter(Boolean).join(" · "),
    isParticipant
      ? `/participant/my-requests?request=${encodeURIComponent(request.id)}`
      : `/${role}/requests?request=${encodeURIComponent(request.id)}`
  )));

  reports.filter((report) => matches(normalizedQuery,
    report.reportNumber, report.id, report.eventName, report.siteName, report.barangay, report.verificationStatus
  )).forEach((report) => results.push(result(
    "Planting Report", report, report.reportNumber || report.id,
    [report.eventName, report.siteName, report.verificationStatus].filter(Boolean).join(" · "),
    isParticipant ? "/participant/my-planting-reports" : `/${role}/planting-reports`
  )));

  monitoring.filter((record) => matches(normalizedQuery,
    record.monitoringNumber, record.id, record.siteName, record.species, record.status
  )).forEach((record) => results.push(result(
    "Monitoring Record", record, record.monitoringNumber || record.id,
    [record.siteName, record.species, record.status].filter(Boolean).join(" · "),
    `/${role}/survival-monitoring`
  )));

  if (!isParticipant) {
    const [inventory, generatedReports] = await Promise.all([
      limitedCollection("seedlingInventory"),
      limitedCollection("generatedReports"),
    ]);
    inventory.filter((item) => item.isDeleted !== true && matches(normalizedQuery,
      item.inventoryNumber, item.id, item.species, item.scientificName, item.category
    )).forEach((item) => results.push(result(
      "Inventory Sapling", item, item.species || item.inventoryNumber || item.id,
      [item.inventoryNumber, item.scientificName, item.status].filter(Boolean).join(" · "),
      `/${role}/seedlings?inventory=${encodeURIComponent(item.id)}`
    )));
    generatedReports.filter((report) => matches(normalizedQuery,
      report.reportNumber, report.id, report.title, report.reportType, report.status
    )).forEach((report) => results.push(result(
      "Generated Report", report, report.title || report.reportNumber || report.id,
      [report.reportNumber, report.reportType, report.status].filter(Boolean).join(" · "),
      `/${role}/reports`
    )));
  }

  return results.slice(0, safeLimit);
}

module.exports = { globalSearch };
