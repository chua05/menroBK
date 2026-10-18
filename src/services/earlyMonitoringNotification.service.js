const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { createNotificationInTransaction } = require("./notification.service");
const { dateOnlyInManila, earlyScheduleStatus, shiftCalendarDate } = require("../utils/earlyMonitoring.util");
const { DEFAULT_BUDGET, processBoundedCollection } = require("../utils/boundedWorker.util");

function milestone(policy, today) {
  const status = earlyScheduleStatus(policy, today);
  if (status === "Available" && today === policy.openingDate) return "available";
  if (today === shiftCalendarDate(policy.deadlineDate, -2)) return "deadline_reminder";
  if (status === "Overdue" && today === shiftCalendarDate(policy.deadlineDate, 1)) return "overdue";
  if (status === "Overdue") {
    const elapsed = Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${shiftCalendarDate(policy.deadlineDate, 1)}T12:00:00Z`)) / 86400000);
    if (elapsed > 0 && elapsed % 7 === 0) return `overdue_followup_${today}`;
  }
  return null;
}

const COPY = {
  available: ["Early Monitoring Available", "Early Survival Monitoring is now available."],
  deadline_reminder: ["Early Monitoring Deadline Reminder", "The on-time Early Survival Monitoring window ends in two days."],
  overdue: ["Early Monitoring Overdue", "Early Survival Monitoring is overdue but may still be submitted before official monitoring opens."],
};

async function processEarlyMonitoringNotifications(options = {}) {
  const today = options.today || dateOnlyInManila();
  const budget = options.budget ?? options.limit ?? DEFAULT_BUDGET;
  const pageSize = options.pageSize ?? 100;
  return processBoundedCollection({
    db,
    workerId: "early-monitoring-notifications",
    collectionName: "plantingReports",
    buildQuery: (collection) => collection.where("earlyMonitoring.enabled", "==", true),
    budget,
    pageSize,
    async processDocument(reportSnapshot) {
    try {
      await db.runTransaction(async (transaction) => {
        const reportRef = reportSnapshot.ref;
        const reportDoc = await transaction.get(reportRef);
        if (!reportDoc.exists) return;
        const report = reportDoc.data(), policy = report.earlyMonitoring;
        const key = milestone(policy, today);
        if (!key || today >= policy.officialOpeningDate) return;
        const lifecycleQuery = db.collection("monitoringRecords").where("plantingReportId", "==", reportDoc.id);
        const lifecycleSnapshot = await transaction.get(lifecycleQuery);
        const submitted = lifecycleSnapshot.docs.some((doc) =>
          (doc.data().history || []).some((entry) => entry.observationType === "early"));
        if (submitted) return;
        if (!report.participantId) return;
        const recipient = await transaction.get(db.collection("users").doc(report.participantId));
        if (!recipient.exists || recipient.data().status === "inactive") return;
        const copy = key.startsWith("overdue_followup_")
          ? ["Early Monitoring Overdue Follow-up", "Early Survival Monitoring remains overdue and is still available before official monitoring opens."]
          : COPY[key];
        const notificationId = `early_monitoring_${key}_${reportDoc.id}`;
        const existing = await transaction.get(db.collection("notifications").doc(notificationId));
        if (existing.exists) return;
        createNotificationInTransaction(transaction, {
          notificationId,
          recipientUserId: report.participantId, type: `early_monitoring_${key.split("_").slice(0, 2).join("_")}`,
          title: copy[0], message: copy[1], relatedRecordType: "monitoring",
          relatedRecordId: reportDoc.id, createdAt: Timestamp.now(),
          details: { openingDate: policy.openingDate, deadlineDate: policy.deadlineDate },
        });
      });
      return { reportId: reportSnapshot.id, processed: true };
    } catch (error) {
      if (error.code === 6 || error.code === "already-exists") {
        return { reportId: reportSnapshot.id, processed: false, duplicate: true };
      }
      throw error;
    }
    },
  });
}

module.exports = { milestone, processEarlyMonitoringNotifications };
