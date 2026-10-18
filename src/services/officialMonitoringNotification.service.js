const crypto = require("node:crypto");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { dateOnlyInManila, shiftCalendarDate } = require("../utils/earlyMonitoring.util");
const {
  isValidatedMonitoringObservation,
  isFullCohortObservation,
  officialNextMonitoringDate,
  PHASE_TWO_STATUSES,
} = require("../utils/monitoringObservation.util");
const {
  createNotificationInTransaction,
  getRoleRecipientsInTransaction,
} = require("./notification.service");
const { DEFAULT_BUDGET, processBoundedCollection } = require("../utils/boundedWorker.util");

const DEFAULT_LIMIT = 100;
const OUTSTANDING = new Set([
  PHASE_TWO_STATUSES.PENDING,
  PHASE_TWO_STATUSES.RETURNED,
  PHASE_TWO_STATUSES.REVIEWED,
]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lifecycleIdForReport(reportId, report = {}) {
  return `MON-${crypto.createHash("sha256").update([
    clean(report.participantId), reportId, clean(report.eventId), clean(report.siteId),
  ].join("|")).digest("hex").slice(0, 20)}`;
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}

function addCalendarYears(value, years) {
  const [year, month, day] = value.split("-").map(Number);
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0, 12)).getUTCDate();
  return `${targetYear}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function observationsFrom(records = []) {
  const observations = [];
  records.forEach((record) => {
    const history = Array.isArray(record.history)
      ? record.history
      : (record.monitoredDate || record.monitoringDate || record.createdAt) ? [record] : [];
    history.forEach((entry) => observations.push({ entry, record }));
  });
  return observations;
}

function officialSchedule(report = {}, records = []) {
  const plantingDate = clean(report.plantingDate || report.eventDate);
  const quantityPlanted = Number(report.quantityPlanted);
  if (!validDate(plantingDate) || !Number.isInteger(quantityPlanted) || quantityPlanted <= 0) return null;
  const startMonitoringDate = shiftCalendarDate(plantingDate, 14);
  const monitoringEndDate = addCalendarYears(plantingDate, 2);
  const observations = observationsFrom(records);
  const outstanding = observations.some(({ entry }) =>
    (entry.observationType || "official") !== "early" &&
    Number(entry.workflowVersion) >= 2 && OUTSTANDING.has(entry.reviewStatus));
  const approvedFull = observations
    .filter(({ entry, record }) => (entry.observationType || "official") !== "early" &&
      isValidatedMonitoringObservation(entry, record) && isFullCohortObservation(entry, {
        ...record, quantityPlanted,
      }))
    .map(({ entry }) => ({ ...entry, reviewStatus: entry.reviewStatus || "Validated" }));
  const next = approvedFull.length
    ? officialNextMonitoringDate({ quantityPlanted, history: approvedFull })
    : startMonitoringDate;
  return {
    openingDate: next,
    startMonitoringDate,
    monitoringEndDate,
    cycleNumber: approvedFull.length + 1,
    outstanding,
    approvedFullCount: approvedFull.length,
  };
}

async function processOfficialMonitoringNotifications(options = {}) {
  const today = options.today || dateOnlyInManila();
  const budget = options.budget ?? options.limit ?? DEFAULT_BUDGET;
  const pageSize = options.pageSize ?? DEFAULT_LIMIT;
  return processBoundedCollection({
    db,
    workerId: "official-monitoring-notifications",
    collectionName: "plantingReports",
    budget,
    pageSize,
    async processDocument(reportSnapshot) {
    let outcome = "skipped";
    try {
      await db.runTransaction(async (transaction) => {
        const reportDoc = await transaction.get(reportSnapshot.ref);
        if (!reportDoc.exists) return;
        const report = reportDoc.data();
        if (report.archived === true ||
            (report.verificationStatus !== "Approved" && report.reportingProgress !== "Completed")) return;
        const recordsSnapshot = await transaction.get(
          db.collection("monitoringRecords").where("plantingReportId", "==", reportDoc.id)
        );
        const records = recordsSnapshot.docs
          .filter((doc) => doc.data().archived !== true)
          .map((doc) => ({ id: doc.id, ...doc.data() }));
        const schedule = officialSchedule(report, records);
        if (!schedule || schedule.outstanding || schedule.openingDate !== today || today >= schedule.monitoringEndDate) return;

        const staff = await getRoleRecipientsInTransaction(transaction, ["staff"]);
        const participantId = clean(report.participantId);
        const participantDoc = participantId
          ? await transaction.get(db.collection("users").doc(participantId)) : null;
        const recipientIds = new Set(staff.map((recipient) => recipient.id));
        if (participantDoc?.exists && participantDoc.data().status !== "inactive") recipientIds.add(participantId);
        if (recipientIds.size === 0) return;

        const monitoringId = records.find((record) => record.recordType === "monitoringLifecycle" ||
          Array.isArray(record.history))?.id || lifecycleIdForReport(reportDoc.id, report);
        const notificationId = (recipientId) =>
          `official_monitoring_available_${reportDoc.id}_${schedule.openingDate}_${recipientId}`;
        const existing = await Promise.all([...recipientIds].map((recipientId) =>
          transaction.get(db.collection("notifications").doc(notificationId(recipientId)))));
        [...recipientIds].forEach((recipientId, index) => {
          if (existing[index].exists) return;
          createNotificationInTransaction(transaction, {
            notificationId: notificationId(recipientId),
            recipientUserId: recipientId,
            type: "official_monitoring_available",
            title: "Official Monitoring Available",
            message: `Official Tree Survival Monitoring is now available for ${report.siteName || report.plantingLocation || report.reportNumber || reportDoc.id}.`,
            relatedRecordType: "monitoring",
            relatedRecordId: monitoringId,
            createdAt: Timestamp.now(),
            details: {
              plantingReportId: reportDoc.id,
              openingDate: schedule.openingDate,
              cycleNumber: schedule.cycleNumber,
            },
          });
        });
        outcome = existing.every((doc) => doc.exists) ? "duplicate" : "notified";
      });
      return { plantingReportId: reportSnapshot.id, outcome };
    } catch (error) {
      if (error.code === 6 || error.code === "already-exists") {
        return { plantingReportId: reportSnapshot.id, outcome: "duplicate" };
      }
      throw error;
    }
    },
  });
}

module.exports = {
  lifecycleIdForReport,
  officialSchedule,
  processOfficialMonitoringNotifications,
};
