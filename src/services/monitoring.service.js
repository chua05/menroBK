const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { nextRecordNumber } = require("../utils/recordNumber.util");
const { calculateDistanceMeters, isPointInPolygon } = require("../utils/geo.util");

const monitoringCollection = db.collection("monitoringRecords");
const reports = db.collection("plantingReports");
const sites = db.collection("sites");
const evidenceHashes = db.collection("monitoringEvidenceHashes");
const SITE_TOLERANCE_METERS = 20;

const pad = (value) => String(value).padStart(2, "0");
function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) throw new Error("Planting report has no valid authoritative planting date.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) {
    throw new Error("Planting report has no valid authoritative planting date.");
  }
  return date;
}
function dateOnly(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function addDays(value, days) {
  const date = parseDateOnly(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}
function addYears(value, years) {
  const date = parseDateOnly(value);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + years, month, 1);
  const last = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0, 12)).getUTCDate();
  date.setUTCDate(Math.min(parseDateOnly(value).getUTCDate(), last));
  return dateOnly(date);
}
function addCalendarMonth(value) {
  const original = parseDateOnly(value);
  const targetYear = original.getUTCFullYear() + Math.floor(original.getUTCMonth() / 11);
  const targetMonth = (original.getUTCMonth() + 1) % 12;
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0, 12)).getUTCDate();
  return dateOnly(new Date(Date.UTC(targetYear, targetMonth, Math.min(original.getUTCDate(), last), 12)));
}
function todayInJuban() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function lifecycleId(participantId, plantingReportId, eventId, siteId) {
  return `MON-${crypto.createHash("sha256").update([participantId, plantingReportId, eventId, siteId].join("|")).digest("hex").slice(0, 20)}`;
}
function calculateSurvivalRate(healthy, damaged, quantity) {
  return quantity > 0 ? Number((((healthy + damaged) / quantity) * 100).toFixed(2)) : 0;
}
function deriveCondition(healthy, damaged, dead, total) {
  if (total > 0 && dead === total) return "Dead";
  if (damaged > 0 || dead > 0) return "Damaged";
  return "Healthy";
}
function lifecycleStatus(record, today = todayInJuban()) {
  if (today >= record.monitoringEndDate) return "Monitoring Completed";
  const history = Array.isArray(record.history) ? record.history : [];
  const due = history.length === 0 ? record.startMonitoringDate : record.nextMonitoringDate;
  if (history.length === 0 && today < due) return "Not Yet Available";
  if (history.length > 0 && (!due || today < due)) return "Next Monitoring Scheduled";
  return "Available for Monitoring";
}
function present(record) {
  const history = Array.isArray(record.history) ? [...record.history] : [];
  history.sort((a, b) => String(a.monitoredDate || "").localeCompare(String(b.monitoredDate || "")));
  const latest = history.at(-1) || {};
  const status = lifecycleStatus({ ...record, history });
  return {
    ...record,
    history,
    historyCount: history.length,
    status,
    condition: latest.condition || record.condition || "Not Yet Monitored",
    monitoringDate: latest.monitoredDate || "",
    monitoredAt: latest.monitoredAt || null,
    healthyCount: latest.healthyCount ?? 0,
    damagedCount: latest.damagedCount ?? 0,
    deadCount: latest.deadCount ?? 0,
    totalMonitored: latest.totalMonitored ?? record.quantityPlanted ?? 0,
    survivalRate: latest.survivalRate ?? 0,
    remarks: latest.remarks || "",
    photoUrl: latest.photoUrl || "",
    photoName: latest.photoName || "",
    photoSize: latest.photoSize || 0,
    latitude: latest.latitude ?? null,
    longitude: latest.longitude ?? null,
    locationCapturedAt: latest.photoTakenAt || null,
    nextMonitoringDate: status === "Monitoring Completed" ? null : record.nextMonitoringDate || null,
  };
}
function baseDateFor(report) {
  return report.plantingDate || report.eventDate || "";
}
function baseLifecycle(id, report) {
  const authoritativePlantingDate = baseDateFor(report);
  parseDateOnly(authoritativePlantingDate);
  return {
    id,
    recordType: "monitoringLifecycle",
    plantingReportId: report.id,
    plantingReportNumber: report.reportNumber || "",
    participantId: report.participantId || "",
    participantName: report.participantName || "",
    eventId: report.eventId || "",
    eventName: report.eventName || "",
    siteId: report.siteId || "",
    siteName: report.siteName || report.plantingLocation || "",
    barangay: report.barangay || "",
    species: report.species || "",
    quantityPlanted: Number(report.quantityPlanted || 0),
    authoritativePlantingDate,
    startMonitoringDate: addDays(authoritativePlantingDate, 14),
    nextMonitoringDate: null,
    monitoringEndDate: addYears(authoritativePlantingDate, 2),
    history: [],
    archived: false,
  };
}

async function savePhoto(file, participantId) {
  const directory = path.join(process.cwd(), "uploads", "monitoring", participantId);
  await fs.mkdir(directory, { recursive: true });
  const extension = path.extname(file.originalname || "").toLowerCase() || ".jpg";
  const name = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;
  const target = path.join(directory, name);
  await fs.writeFile(target, file.buffer);
  return { target, url: `/uploads/monitoring/${participantId}/${name}` };
}

async function createMonitoringRecord(data) {
  const reportRef = reports.doc(data.plantingReportId);
  const reportDoc = await reportRef.get();
  if (!reportDoc.exists) throw new Error("Planting report not found.");
  const report = { id: reportDoc.id, ...reportDoc.data() };
  if (report.verificationStatus !== "Approved") throw new Error("Only approved planting reports can be monitored.");
  if (data.requesterRole === "participant" && report.participantId !== data.monitoredBy) {
    throw new Error("You can only monitor your own approved planting reports.");
  }
  if (!report.siteId) throw new Error("Planting report has no associated planting site.");

  const quantity = Number(report.quantityPlanted);
  const healthy = Number(data.healthyCount);
  const damaged = Number(data.damagedCount);
  const dead = Number(data.deadCount);
  if (![healthy, damaged, dead].every((value) => Number.isInteger(value) && value >= 0) || healthy + damaged + dead !== quantity) {
    throw new Error("Healthy, damaged, and dead counts must equal the quantity planted.");
  }

  const latitude = Number(data.metadata.latitude);
  const longitude = Number(data.metadata.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("This photo does not contain GPS location metadata. Please upload an original geotagged photo with location information.");
  }
  const siteDoc = await sites.doc(report.siteId).get();
  if (!siteDoc.exists) throw new Error("Planting site not found.");
  const site = siteDoc.data();
  const siteLatitude = Number(site.latitude);
  const siteLongitude = Number(site.longitude);
  const distance = calculateDistanceMeters(latitude, longitude, siteLatitude, siteLongitude);
  const inside = Array.isArray(site.polygon) && site.polygon.length >= 3
    ? isPointInPolygon(latitude, longitude, site.polygon)
    : distance <= SITE_TOLERANCE_METERS;

  const id = lifecycleId(report.participantId, report.id, report.eventId || "", report.siteId);
  const lifecycleRef = monitoringCollection.doc(id);
  const hashRef = evidenceHashes.doc(data.imageHash);
  const saved = await savePhoto(data.file, report.participantId);
  try {
    await db.runTransaction(async (transaction) => {
      const [currentDoc, duplicateDoc] = await Promise.all([
        transaction.get(lifecycleRef), transaction.get(hashRef),
      ]);
      if (duplicateDoc.exists) throw new Error("Duplicate monitoring image detected.");
      const seed = baseLifecycle(id, report);
      const current = currentDoc.exists ? { id, ...currentDoc.data() } : seed;
      if (current.participantId !== report.participantId || current.plantingReportId !== report.id || current.siteId !== report.siteId) {
        throw new Error("Monitoring lifecycle relationship is inconsistent.");
      }

      const today = todayInJuban();
      if (today >= current.monitoringEndDate) {
        throw new Error("The two-year monitoring period for this planting record has been completed. No additional monitoring record can be submitted.");
      }
      const history = Array.isArray(current.history) ? current.history : [];
      const dueDate = history.length === 0
        ? current.startMonitoringDate
        : current.nextMonitoringDate || current.monitoringEndDate;
      if (dueDate && today < dueDate) {
        throw new Error(history.length === 0
          ? `Monitoring is not available yet. You can submit the first monitoring record starting on ${dueDate}.`
          : `Monitoring is not due yet. You can submit the next monitoring record starting on ${dueDate}.`);
      }

      const now = Timestamp.now();
      const monitoringNumber = current.monitoringNumber || await nextRecordNumber(
        transaction,
        {
          prefix: "MON",
          counterKey: "monitoringRecords",
          date: now.toDate(),
          timestamp: now,
        }
      );
      const condition = deriveCondition(healthy, damaged, dead, quantity);
      const entry = {
        id: `${id}-${now.toMillis()}`,
        monitoredAt: now,
        monitoredDate: today,
        healthyCount: healthy,
        damagedCount: damaged,
        deadCount: dead,
        totalMonitored: quantity,
        survivingCount: healthy + damaged,
        survivalRate: calculateSurvivalRate(healthy, damaged, quantity),
        mortalityRate: Number(((dead / quantity) * 100).toFixed(2)),
        condition,
        maturityStatus: data.maturityStatus,
        remarks: data.remarks || "",
        photoName: data.file.originalname,
        photoType: data.file.mimetype,
        photoSize: data.file.size,
        photoUrl: saved.url,
        imageHash: data.imageHash,
        imageDetails: data.imageDetails,
        latitude,
        longitude,
        photoTakenAt: data.metadata.capturedAt && !Number.isNaN(new Date(data.metadata.capturedAt).getTime())
          ? Timestamp.fromDate(new Date(data.metadata.capturedAt))
          : null,
        uploadedAt: now,
        siteGpsDistanceMeters: distance,
        siteGpsValid: inside,
        automatedVerificationStatus: inside ? "Passed Automated Check" : "Flagged",
        suspiciousFlags: inside ? [] : ["OUTSIDE_REGISTERED_SITE"],
        reviewStatus: "Pending",
        createdAt: now,
      };
      const updatedHistory = [...history, entry];
      const calculatedNext = updatedHistory.length === 1 ? addDays(today, 35) : addCalendarMonth(today);
      const nextMonitoringDate = calculatedNext;
      const payload = {
        ...seed,
        ...current,
        monitoringNumber,
        history: updatedHistory,
        nextMonitoringDate,
        condition,
        reviewStatus: "Pending",
        updatedAt: now,
        createdAt: current.createdAt || now,
      };
      if (currentDoc.exists) transaction.update(lifecycleRef, payload);
      else transaction.create(lifecycleRef, payload);
      transaction.create(hashRef, { lifecycleId: id, participantId: report.participantId, createdAt: now });
    });
  } catch (error) {
    await fs.unlink(saved.target).catch(() => {});
    throw error;
  }
  const result = await lifecycleRef.get();
  return present({ id: result.id, ...result.data() });
}

function consolidateLegacy(raw) {
  const lifecycle = [];
  const legacyGroups = new Map();
  for (const record of raw) {
    if (record.recordType === "monitoringLifecycle" || Array.isArray(record.history)) lifecycle.push(present(record));
    else {
      const key = [record.participantId, record.plantingReportId, record.eventId, record.siteId].join("|");
      const group = legacyGroups.get(key) || { ...record, id: `legacy-${record.plantingReportId || record.id}`, recordType: "legacyLifecycle", history: [] };
      group.history.push({ ...record, id: record.id, monitoredDate: record.monitoringDate, monitoredAt: record.createdAt });
      legacyGroups.set(key, group);
    }
  }
  return [...lifecycle, ...[...legacyGroups.values()].map(present)];
}

async function getAllMonitoringRecords({ plantingReportId, participantId, status, maturityStatus, includeArchived = false } = {}) {
  const snapshot = await monitoringCollection.get();
  let records = consolidateLegacy(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  if (!includeArchived) records = records.filter((record) => record.archived !== true);
  if (plantingReportId) records = records.filter((record) => record.plantingReportId === plantingReportId);
  if (participantId) records = records.filter((record) => record.participantId === participantId);
  if (status) records = records.filter((record) => record.status === status);
  if (maturityStatus) records = records.filter((record) => record.history.at(-1)?.maturityStatus === maturityStatus);
  return records.sort((a, b) => String(b.updatedAt?.toMillis?.() || b.authoritativePlantingDate || "").localeCompare(String(a.updatedAt?.toMillis?.() || a.authoritativePlantingDate || "")));
}

async function getMonitoringRecordsByParticipantId(participantId) {
  const [existing, reportSnapshot] = await Promise.all([
    getAllMonitoringRecords({ participantId }),
    reports.where("participantId", "==", participantId).get(),
  ]);
  const byReport = new Map(existing.map((record) => [record.plantingReportId, record]));
  for (const doc of reportSnapshot.docs) {
    const report = { id: doc.id, ...doc.data() };
    if (report.verificationStatus !== "Approved" || byReport.has(doc.id)) continue;
    try {
      const id = lifecycleId(participantId, doc.id, report.eventId || "", report.siteId || "");
      byReport.set(doc.id, present(baseLifecycle(id, report)));
    } catch {
      // Legacy approved reports without an authoritative planting date stay readable elsewhere.
    }
  }
  return [...byReport.values()];
}

async function getMonitoringRecordById(id) {
  const doc = await monitoringCollection.doc(id).get();
  if (!doc.exists) throw new Error("Monitoring record not found.");
  return present({ id: doc.id, ...doc.data() });
}

async function updateMonitoringRecord(id, data) {
  const ref = monitoringCollection.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Monitoring record not found.");
  await ref.update({ remarks: data.remarks ?? doc.data().remarks ?? "", updatedBy: data.updatedBy, updatedAt: Timestamp.now() });
  return getMonitoringRecordById(id);
}

async function reviewMonitoringRecord(id, reviewedBy) {
  const ref = monitoringCollection.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Monitoring record not found.");
  await ref.update({ reviewStatus: "Reviewed", reviewedBy, reviewedAt: Timestamp.now(), updatedAt: Timestamp.now() });
  return getMonitoringRecordById(id);
}

async function archiveMonitoringRecord(id, archivedBy) {
  const ref = monitoringCollection.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Monitoring record not found.");
  await ref.update({ archived: true, archivedAt: Timestamp.now(), archivedBy, updatedAt: Timestamp.now() });
  return getMonitoringRecordById(id);
}

module.exports = {
  createMonitoringRecord, getAllMonitoringRecords, getMonitoringRecordById,
  getMonitoringRecordsByParticipantId, updateMonitoringRecord,
  reviewMonitoringRecord, archiveMonitoringRecord,
  addDays, addCalendarMonth, addYears, lifecycleStatus,
};
