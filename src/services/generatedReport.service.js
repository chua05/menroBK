const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { pdfFromLines } = require("../utils/simplePdf.util");

const history = db.collection("generatedReports");
const TYPES = new Set([
  "seedling-distribution", "planting-activity", "tree-monitoring",
  "participant", "event-participation", "monthly", "annual",
]);

function isoDate(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = typeof value.toDate === "function" ? value.toDate()
    : value.seconds !== undefined || value._seconds !== undefined
      ? new Date((value.seconds ?? value._seconds) * 1000)
      : new Date(value);
  return Number.isNaN(date.getTime()) ? ""
    : new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validDate(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function cleanFilters(input = {}) {
  const type = String(input.type || "");
  const dateFrom = String(input.dateFrom || "");
  const dateTo = String(input.dateTo || "");
  const eventId = String(input.eventId || "");
  const participantType = String(input.participantType || "all").toLowerCase();
  if (!TYPES.has(type) || !validDate(dateFrom) || !validDate(dateTo) ||
      dateFrom && dateTo && dateFrom > dateTo || eventId.includes("/") ||
      !["all", "guest", "registered"].includes(participantType)) {
    throw new Error("Invalid report type or filters.");
  }
  return { type, dateFrom, dateTo, eventId, participantType };
}

function within(date, filters) {
  return (!filters.dateFrom || date >= filters.dateFrom) &&
    (!filters.dateTo || date <= filters.dateTo);
}

async function snapshotRows(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function buildRows(filters) {
  const { type } = filters;
  if (type === "participant" || type === "event-participation") {
    const [participants, events, requests, contributions] = await Promise.all([
      snapshotRows("eventParticipants"), snapshotRows("events"),
      snapshotRows("seedlingRequests"), snapshotRows("plantingContributions"),
    ]);
    const eventById = new Map(events.map((event) => [event.id, event]));
    const requestById = new Map(requests.map((request) => [request.id, request]));
    return participants.filter((entry) => {
      const event = eventById.get(entry.eventId);
      return event && (!filters.eventId || filters.eventId === entry.eventId) &&
        within(event.date || "", filters) &&
        (filters.participantType === "all" ||
          (filters.participantType === "guest") === (entry.participantType === "guest"));
    }).map((entry) => {
      const event = eventById.get(entry.eventId);
      const request = requestById.get(event.sourceRequestId);
      const own = contributions.filter((item) => item.participantId === entry.id && item.eventId === entry.eventId);
      return {
        eventId: entry.eventId,
        eventName: event.name || "",
        eventDate: event.date || "",
        requestId: event.sourceRequestId || "",
        requester: request?.participantName || "",
        site: event.plantingSiteName || "",
        participantName: entry.fullName || "",
        participantType: entry.participantType || "",
        joinedAt: isoDate(entry.joinedAt),
        quantityPlanted: own.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        species: [...new Set(own.map((item) => item.species).filter(Boolean))].join(", "),
        contributions: own.map((item) =>
          `${item.species || item.inventoryId}: ${Number(item.quantity || 0)} (${isoDate(item.recordedAt)})`
        ).join("; "),
      };
    });
  }

  const collection = {
    "seedling-distribution": "distributions",
    "planting-activity": "plantingReports",
    "tree-monitoring": "monitoringRecords",
  }[type];
  if (collection) {
    const records = await snapshotRows(collection);
    return records.filter((record) => within(isoDate(
      type === "tree-monitoring" ? record.monitoringDate || record.createdAt
        : record.releasedAt || record.submittedAt || record.createdAt
    ), filters)).map((record) => {
      if (type === "seedling-distribution") return {
        distributionId: record.id, requestId: record.requestId || "",
        participant: record.participantName || "", date: isoDate(record.releasedAt),
        quantityReleased: Number(record.totalQuantityReleased ?? record.quantityReleased ?? 0),
        status: record.status || "",
      };
      if (type === "planting-activity") return {
        reportId: record.id, requestId: record.requestId || "", eventId: record.eventId || "",
        requester: record.participantName || "", date: isoDate(record.submittedAt || record.createdAt),
        quantityPlanted: Number(record.quantityPlanted || 0), status: record.verificationStatus || "",
      };
      return {
        monitoringId: record.id, reportId: record.plantingReportId || "",
        date: isoDate(record.monitoringDate || record.createdAt),
        healthyCount: record.healthyCount ?? null,
        damagedCount: record.damagedCount ?? null,
        deadCount: record.deadCount ?? null,
        survivingCount: record.survivingCount ?? null,
        survivalRate: record.survivalRate ?? null,
      };
    });
  }

  const [requests, distributions, reports, monitoring, participants] = await Promise.all([
    snapshotRows("seedlingRequests"), snapshotRows("distributions"),
    snapshotRows("plantingReports"), snapshotRows("monitoringRecords"),
    snapshotRows("eventParticipants"),
  ]);
  if (!filters.dateFrom) throw new Error("A date range is required for monthly and annual reports.");
  const periodLength = type === "monthly" ? 7 : 4;
  const sources = [
    [requests, "createdAt"], [distributions, "releasedAt"],
    [reports, "approvedAt"], [monitoring, "monitoringDate"], [participants, "joinedAt"],
  ];
  const periods = new Set();
  for (const [items, field] of sources) {
    for (const item of items) {
      const date = isoDate(item[field]);
      if (date && within(date, filters)) periods.add(date.slice(0, periodLength));
    }
  }
  const pick = (items, field, period) => items.filter((item) =>
    isoDate(item[field]).startsWith(period) && within(isoDate(item[field]), filters));
  return [...periods].sort().map((period) => ({
    period,
    requests: pick(requests, "createdAt", period).length,
    quantityReleased: pick(distributions, "releasedAt", period)
      .reduce((sum, item) => sum + Number(item.totalQuantityReleased ?? item.quantityReleased ?? 0), 0),
    approvedPlantingReports: pick(reports, "approvedAt", period)
      .filter((item) => item.verificationStatus === "Approved").length,
    monitoringRecords: pick(monitoring, "monitoringDate", period).length,
    participantsJoined: pick(participants, "joinedAt", period).length,
  }));
}

async function generateReport(input, user) {
  const filters = cleanFilters(input);
  const rows = await buildRows(filters);
  const ref = history.doc();
  const generatedAt = Timestamp.now();
  const chunkSize = 25;
  for (let index = 0; index < rows.length; index += chunkSize) {
    await ref.collection("chunks").doc(String(index / chunkSize).padStart(6, "0"))
      .create({ rows: rows.slice(index, index + chunkSize) });
  }
  const record = {
    type: filters.type,
    filters,
    generatedBy: user.uid,
    generatedByName: user.fullName || "",
    generatedAt,
    rowCount: rows.length,
    chunkCount: Math.ceil(rows.length / chunkSize),
    status: "Generated",
    fileName: `${filters.type}-${ref.id}.pdf`,
  };
  await ref.create(record);
  return { id: ref.id, ...record, downloadPath: `/api/reports/${ref.id}/download` };
}

async function listGeneratedReports() {
  const snapshot = await history.get();
  return snapshot.docs.map((doc) => ({
    id: doc.id, ...doc.data(), downloadPath: `/api/reports/${doc.id}/download`,
  })).sort((a, b) => (b.generatedAt?.seconds || 0) - (a.generatedAt?.seconds || 0));
}

async function generatedPdf(id) {
  if (!id || id.includes("/")) throw new Error("Generated report not found.");
  const ref = history.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Generated report not found.");
  const chunks = await ref.collection("chunks").orderBy("__name__").get();
  const rows = chunks.docs.flatMap((chunk) => chunk.data().rows || []);
  const metadata = doc.data();
  const lines = [
    `MENRO - ${metadata.type} report`,
    `Generated: ${isoDate(metadata.generatedAt)}   By: ${metadata.generatedByName || metadata.generatedBy}`,
    `Records: ${metadata.rowCount}`,
    "",
    ...rows.flatMap((row, index) => [
      `${index + 1}.`,
      ...Object.entries(row).map(([key, value]) => `  ${key}: ${value ?? ""}`),
      "",
    ]),
  ];
  return { fileName: metadata.fileName, bytes: pdfFromLines(lines) };
}

module.exports = { cleanFilters, buildRows, generateReport, listGeneratedReports, generatedPdf };
