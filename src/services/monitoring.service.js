const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { UPLOAD_ROOT } = require("../config/uploadRoot");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { nextRecordNumber } = require("../utils/recordNumber.util");
const { calculateDistanceMeters, isPointInPolygon } = require("../utils/geo.util");
const { dateOnlyInManila, earlyScheduleStatus } = require("../utils/earlyMonitoring.util");
const { validateMonitoringEvidenceTimestamp } = require("../utils/monitoringEvidenceTimestamp.util");
const {
  createNotificationInTransaction,
  getRoleRecipientsInTransaction,
} = require("./notification.service");
const {
  isFullCohortObservation,
  isValidatedMonitoringObservation,
  officialNextMonitoringDate: sharedOfficialNextMonitoringDate,
  PHASE_TWO_STATUSES,
} = require("../utils/monitoringObservation.util");

const monitoringCollection = db.collection("monitoringRecords");
const reports = db.collection("plantingReports");
const sites = db.collection("sites");
const evidenceHashes = db.collection("monitoringEvidenceHashes");
const SITE_TOLERANCE_METERS = 20;
const MAX_WORKFLOW_TEXT_LENGTH = 1000;
const MAX_REVISIONS_PER_OBSERVATION = 25;
const MAX_AUDIT_ENTRIES_PER_OBSERVATION = 100;
let retainedRetrieval;
const OUTSTANDING_OBSERVATION_STATUSES = new Set([
  PHASE_TWO_STATUSES.PENDING,
  PHASE_TWO_STATUSES.RETURNED,
  PHASE_TWO_STATUSES.REVIEWED,
]);

function workflowError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function cleanWorkflowText(value, { required = false, label = "Remarks" } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw workflowError("INVALID_MONITORING_INPUT", `${label} is required.`, 400);
  if (text.length > MAX_WORKFLOW_TEXT_LENGTH) {
    throw workflowError("INVALID_MONITORING_INPUT", `${label} must be ${MAX_WORKFLOW_TEXT_LENGTH} characters or fewer.`, 400);
  }
  return text;
}

function uniqueObservationIndex(history, observationId) {
  const matches = history.map((entry, index) => entry?.id === observationId ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length === 0) throw workflowError("OBSERVATION_NOT_FOUND", "Monitoring observation not found.", 404);
  if (matches.length > 1) throw workflowError("DUPLICATE_OBSERVATION_ID", "Duplicate monitoring observation IDs were detected.");
  return matches[0];
}

function assertVersion(observation, expectedVersion) {
  const expected = Number(expectedVersion);
  if (!Number.isInteger(expected) || expected < 0) {
    throw workflowError("INVALID_MONITORING_INPUT", "A valid expected observation version is required.", 400);
  }
  if (Number(observation.reviewVersion || 0) !== expected) {
    throw workflowError("STALE_OBSERVATION_VERSION", "This observation changed while it was being reviewed. Please refresh and try again.");
  }
}

function workflowCounts(history) {
  const counts = { pendingReviewCount: 0, returnedCount: 0, reviewedCount: 0, approvedCount: 0, rejectedCount: 0 };
  const fieldByStatus = {
    [PHASE_TWO_STATUSES.PENDING]: "pendingReviewCount",
    [PHASE_TWO_STATUSES.RETURNED]: "returnedCount",
    [PHASE_TWO_STATUSES.REVIEWED]: "reviewedCount",
    [PHASE_TWO_STATUSES.APPROVED]: "approvedCount",
    [PHASE_TWO_STATUSES.REJECTED]: "rejectedCount",
  };
  for (const entry of history) {
    const field = fieldByStatus[entry.reviewStatus];
    if (field) counts[field] += 1;
  }
  return counts;
}

function appendAudit(observation, audit) {
  const existing = Array.isArray(observation.auditHistory) ? observation.auditHistory : [];
  if (existing.length >= MAX_AUDIT_ENTRIES_PER_OBSERVATION) {
    throw workflowError("OBSERVATION_HISTORY_LIMIT", "This observation has reached its workflow history limit.", 422);
  }
  return [...existing, audit];
}

function publicEvidence(entry = {}) {
  const clone = { ...entry, hasEvidence: Boolean(entry.photoUrl || entry.privateEvidence || entry.hasEvidence) };
  delete clone.privateEvidence;
  delete clone.photoUrl;
  delete clone.imageHash;
  if (Array.isArray(clone.revisionHistory)) {
    clone.revisionHistory = clone.revisionHistory.map((revision) => {
      const safe = { ...revision, hasEvidence: Boolean(revision.evidenceRef || revision.hasEvidence) };
      delete safe.evidenceRef;
      return safe;
    });
  }
  return clone;
}

const pad = (value) => String(value).padStart(2, "0");
function parseDateOnly(value, errorMessage = "Planting report has no valid authoritative planting date.") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) throw new Error(errorMessage);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) {
    throw new Error(errorMessage);
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
function todayInBulan() {
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
function nextMonitoringDateForObservation({
  currentNextMonitoringDate, fullHistoryCount, monitoredDate, isFullCohortAssessment,
}) {
  if (!isFullCohortAssessment) return currentNextMonitoringDate || null;
  return fullHistoryCount === 0
    ? addDays(monitoredDate, 35)
    : addCalendarMonth(monitoredDate);
}
function observationDate(entry = {}) {
  return String(entry.monitoredDate || entry.monitoringDate || "");
}
function officialFullHistory(history = [], record = {}) {
  return history.filter((entry) =>
    isValidatedMonitoringObservation(entry, record) &&
    isFullCohortObservation(entry, record) &&
    Boolean(observationDate(entry)));
}
function officialNextMonitoringDate(history = [], record = {}) {
  return sharedOfficialNextMonitoringDate({ ...record, history });
}
function hasOutstandingObservation(history = [], observationType = "official") {
  return history.some((entry) => Number(entry?.workflowVersion) >= 2 &&
    (entry.observationType || "official") === observationType &&
    OUTSTANDING_OBSERVATION_STATUSES.has(entry.reviewStatus));
}
function lifecycleStatus(record, today = todayInBulan()) {
  if (today >= record.monitoringEndDate) return "Monitoring Completed";
  const history = Array.isArray(record.history) ? record.history : [];
  const fullHistory = officialFullHistory(history, record);
  const due = fullHistory.length === 0
    ? record.startMonitoringDate
    : record.nextMonitoringDate || officialNextMonitoringDate(history, record);
  if (fullHistory.length === 0 && today < due) return "Not Yet Available";
  if (fullHistory.length > 0 && due && today < due) return "Next Monitoring Scheduled";
  return "Available for Monitoring";
}
function present(record) {
  const history = Array.isArray(record.history) ? [...record.history] : [];
  history.sort((a, b) => String(a.monitoredDate || "").localeCompare(String(b.monitoredDate || "")));
  const latest = history.at(-1) || {};
  const status = lifecycleStatus({ ...record, history });
  const output = {
    ...record,
    history: history.map(publicEvidence),
    historyCount: history.length,
    status,
    condition: latest.condition || record.condition || "Not Yet Monitored",
    monitoringDate: latest.monitoredDate || "",
    monitoredAt: latest.monitoredAt || null,
    healthyCount: latest.healthyCount ?? 0,
    damagedCount: latest.damagedCount ?? 0,
    deadCount: latest.deadCount ?? 0,
    totalMonitored: latest.totalMonitored ?? record.quantityPlanted ?? 0,
    cohortQuantityAtObservation: latest.cohortQuantityAtObservation ?? record.quantityPlanted ?? 0,
    isFullCohortAssessment: latest.isFullCohortAssessment ??
      isFullCohortObservation(latest, record),
    monitoredBy: latest.monitoredBy || "",
    survivalRate: latest.survivalRate ?? 0,
    mortalityRate: latest.mortalityRate ?? 0,
    remarks: latest.remarks || "",
    hasEvidence: Boolean(latest.photoUrl || latest.privateEvidence || latest.hasEvidence),
    photoName: latest.photoName || "",
    photoSize: latest.photoSize || 0,
    latitude: latest.latitude ?? null,
    longitude: latest.longitude ?? null,
    locationCapturedAt: latest.photoTakenAt || null,
    nextMonitoringDate: status === "Monitoring Completed" ? null : record.nextMonitoringDate || null,
  };
  delete output.photoUrl;
  delete output.privateEvidence;
  delete output.imageHash;
  return output;
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
    ...(report.earlyMonitoring ? { earlyMonitoring: report.earlyMonitoring } : {}),
    archived: false,
  };
}

async function savePhoto(file, participantId) {
  const directory = path.join(UPLOAD_ROOT, "monitoring", participantId);
  await fs.mkdir(directory, { recursive: true });
  const extension = path.extname(file.originalname || "").toLowerCase() || ".jpg";
  const name = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;
  const target = path.join(directory, name);
  await fs.writeFile(target, file.buffer);
  return { target, url: `/uploads/monitoring/${participantId}/${name}` };
}

async function createMonitoringRecord(data) {
  const { idempotencyKey, file, imageDetails, metadata, imageHash, captureEvidence, ...payload } = data;
  return require("./evidenceWorkflow.service").runWorkflow({ actor: { uid: data.monitoredBy },
    workflow: data.observationType === "early" ? "monitoring-early" : "monitoring-official",
    target: data.plantingReportId, key: idempotencyKey, payload, files: [file] },
  operation => createMonitoringRecordImpl({ ...data, workflowOperation: operation }),
  link => getMonitoringRecordById(link.recordId));
}
async function createMonitoringRecordImpl(data) {
  const observationType = data.observationType === "early" ? "early" : "official";
  const reportRef = reports.doc(data.plantingReportId);
  const reportDoc = await reportRef.get();
  if (!reportDoc.exists) throw new Error("Planting report not found.");
  const report = { id: reportDoc.id, ...reportDoc.data() };
  if (report.verificationStatus !== "Approved" && report.reportingProgress !== "Completed") throw new Error("Only completed planting reports can be monitored.");
  if (!report.siteId) throw new Error("Planting report has no associated planting site.");

  const quantity = Number(report.quantityPlanted);
  const totalMonitored = Number(data.totalMonitored);
  const healthy = Number(data.healthyCount);
  const damaged = Number(data.damagedCount);
  const dead = Number(data.deadCount);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Planting report has no valid verified planted quantity.");
  }
  if (!Number.isInteger(totalMonitored) || totalMonitored <= 0 || totalMonitored > quantity) {
    throw new Error(`Total trees checked must be between 1 and the verified planted quantity (${quantity}).`);
  }
  if (![healthy, damaged, dead].every((value) => Number.isInteger(value) && value >= 0) ||
      healthy + damaged + dead !== totalMonitored) {
    throw new Error("Healthy, damaged, and dead counts must equal the total trees checked.");
  }

  parseDateOnly(data.monitoredDate, "Date monitored must be a valid calendar date.");
  const today = todayInBulan();
  if (data.monitoredDate > today) throw new Error("Date monitored cannot be in the future.");

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
  const operation = data.workflowOperation;
  const observationId = operation?.observationId || `OBS-${crypto.randomUUID()}`;
  const privateEvidence = operation ? await require("./evidenceWorkflow.service").workflow().upload(
    operation, 0, data.file, { recordId: observationId, evidenceType: `monitoring-${observationType}`,
      verification: { capturedAt: data.metadata.capturedAt || null,
        latitude, longitude, gpsValid: true, timestampValid: data.metadata.captureTimestampValid === true,
        siteGpsValid: inside, suspiciousFlags: inside ? [] : ["OUTSIDE_REGISTERED_SITE"],
        evidenceSource: data.captureEvidence ? "browser-camera" : "original-exif",
        locationSource: data.captureEvidence ? "Browser Capture Session" : "Photo Metadata",
        locationAccuracyMeters: data.captureEvidence?.accuracyMeters ?? null, verificationPolicyVersion: 1 } }) : null;
  const saved = privateEvidence ? { target: null, url: "" } : await savePhoto(data.file, data.monitoredBy);
  try {
    await db.runTransaction(async (transaction) => {
      const complete = operation ? await require("./evidenceWorkflow.service").workflow().prepareLink(transaction, operation) : null;
      const consumeCapture = await require("./evidenceCaptureSession.service").prepareConsumption(
        transaction, data.captureEvidence ? [data.captureEvidence] : []);
      const staffRecipients = await getRoleRecipientsInTransaction(transaction, ["staff"]);
      const [currentDoc, duplicateDoc, currentReportDoc] = await Promise.all([
        transaction.get(lifecycleRef), transaction.get(hashRef), transaction.get(reportRef),
      ]);
      if (duplicateDoc.exists) throw new Error("Duplicate monitoring image detected.");
      if (!currentReportDoc.exists) throw new Error("Planting report not found.");
      const currentReport = { id: currentReportDoc.id, ...currentReportDoc.data() };
      if (currentReport.verificationStatus !== "Approved" && currentReport.reportingProgress !== "Completed") {
        throw new Error("Only completed planting reports can be monitored.");
      }
      const authoritativeQuantity = Number(currentReport.quantityPlanted);
      if (!Number.isInteger(authoritativeQuantity) || authoritativeQuantity <= 0) {
        throw new Error("Planting report has no valid verified planted quantity.");
      }
      if (totalMonitored > authoritativeQuantity) {
        throw new Error(`Total trees checked must not exceed the verified planted quantity (${authoritativeQuantity}).`);
      }
      if (currentReport.participantId !== report.participantId ||
          currentReport.eventId !== report.eventId || currentReport.siteId !== report.siteId) {
        throw new Error("Planting report relationships changed while the observation was being submitted. Please try again.");
      }
      const seed = baseLifecycle(id, report);
      const current = currentDoc.exists ? { id, ...currentDoc.data() } : seed;
      if (current.participantId !== report.participantId || current.plantingReportId !== report.id || current.siteId !== report.siteId) {
        throw new Error("Monitoring lifecycle relationship is inconsistent.");
      }

      if (today >= current.monitoringEndDate) {
        throw new Error("The two-year monitoring period for this planting record has been completed. No additional monitoring record can be submitted.");
      }
      const history = Array.isArray(current.history) ? current.history : [];
      if (hasOutstandingObservation(history, observationType)) {
        throw workflowError("OUTSTANDING_OBSERVATION_EXISTS",
          "An existing monitoring observation must be resolved before another can be submitted.");
      }
      const fullHistory = officialFullHistory(history, current);
      const dueDate = fullHistory.length === 0
        ? current.startMonitoringDate
        : current.nextMonitoringDate || current.monitoringEndDate;
      const earlyPolicy = currentReport.earlyMonitoring || current.earlyMonitoring;
      if (observationType === "early") {
        if (!earlyPolicy?.enabled || !earlyPolicy.applicable) {
          throw workflowError("EARLY_MONITORING_NOT_APPLICABLE", "Early Survival Monitoring is not available for this planting report.", 422);
        }
        const status = earlyScheduleStatus(earlyPolicy, today);
        if (["Scheduled", "Not Applicable"].includes(status)) {
          throw workflowError("EARLY_MONITORING_NOT_OPEN", `Early Survival Monitoring opens on ${earlyPolicy.openingDate}.`, 422);
        }
        if (status === "Closed") {
          throw workflowError("EARLY_MONITORING_CLOSED", "Early Survival Monitoring closed when official monitoring opened.", 422);
        }
        if (history.some((entry) => (entry.observationType || "official") === "early" && entry.reviewStatus !== PHASE_TWO_STATUSES.REJECTED)) {
          throw workflowError("EARLY_OBSERVATION_EXISTS", "An Early Survival Monitoring observation already exists for this planting report.");
        }
        if (data.monitoredDate < earlyPolicy.openingDate || data.monitoredDate >= earlyPolicy.officialOpeningDate) {
          throw workflowError("INVALID_MONITORING_INPUT", `Date monitored must be from ${earlyPolicy.openingDate} and before ${earlyPolicy.officialOpeningDate}.`, 400);
        }
      } else if (dueDate && today < dueDate) {
        throw new Error(fullHistory.length === 0
          ? `Monitoring is not available yet. You can submit the first monitoring record starting on ${dueDate}.`
          : `Monitoring is not due yet. You can submit the next monitoring record starting on ${dueDate}.`);
      }
      if (observationType === "official" && dueDate && data.monitoredDate < dueDate) {
        throw new Error(`Date monitored cannot be earlier than the current monitoring date (${dueDate}).`);
      }
      if (observationType === "official" && (data.monitoredDate < current.startMonitoringDate || data.monitoredDate >= current.monitoringEndDate)) {
        throw new Error(`Date monitored must be within the monitoring period from ${current.startMonitoringDate} to ${current.monitoringEndDate}.`);
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
      const entry = {
        id: observationId,
        ...(privateEvidence ? { privateEvidence, hasEvidence: true } : {}),
        workflowVersion: 2,
        observationType,
        observationPolicyVersion: 1,
        originalReporterId: data.monitoredBy,
        monitoredAt: now,
        monitoredDate: data.monitoredDate,
        monitoredBy: data.monitoredBy,
        healthyCount: healthy,
        damagedCount: damaged,
        deadCount: dead,
        totalMonitored,
        cohortQuantityAtObservation: authoritativeQuantity,
        isFullCohortAssessment: totalMonitored === authoritativeQuantity,
        survivingCount: healthy + damaged,
        survivalRate: calculateSurvivalRate(healthy, damaged, totalMonitored),
        mortalityRate: Number(((dead / totalMonitored) * 100).toFixed(2)),
        condition: deriveCondition(healthy, damaged, dead, totalMonitored),
        maturityStatus: data.maturityStatus,
        remarks: data.remarks || "",
        photoName: data.file.originalname,
        photoType: data.file.mimetype,
        photoSize: data.file.size,
        evidenceSource: data.captureEvidence ? "browser-camera" : "original-exif",
        locationSource: data.captureEvidence ? "Browser Capture Session" : "Photo Metadata",
        locationAccuracyMeters: data.captureEvidence?.accuracyMeters ?? null,
        captureSessionAuditId: data.captureEvidence?.id || null,
        verificationPolicyVersion: 1,
        photoUrl: saved.url,
        imageHash: data.imageHash,
        imageDetails: data.imageDetails,
        latitude,
        longitude,
        photoTakenAt: data.metadata.capturedAt && !Number.isNaN(new Date(data.metadata.capturedAt).getTime())
          ? Timestamp.fromDate(new Date(data.metadata.capturedAt))
          : null,
        captureTimestamp: data.metadata.captureTimestamp
          ? Timestamp.fromDate(new Date(data.metadata.captureTimestamp)) : null,
        captureTimestampRaw: data.metadata.captureTimestampRaw || "",
        captureDateManila: data.metadata.captureDateManila || "",
        captureTimezoneSource: data.metadata.captureTimezoneSource || "",
        captureTimestampValid: data.metadata.captureTimestampValid === true,
        uploadedAt: now,
        siteGpsDistanceMeters: distance,
        siteGpsValid: inside,
        automatedVerificationStatus: inside ? "Passed Automated Check" : "Flagged",
        suspiciousFlags: inside ? [] : ["OUTSIDE_REGISTERED_SITE"],
        reviewStatus: PHASE_TWO_STATUSES.PENDING,
        reviewVersion: 0,
        revisionNumber: 1,
        staffReviewedBy: null,
        staffReviewedAt: null,
        staffReviewRemarks: "",
        returnedBy: null,
        returnedAt: null,
        returnReason: "",
        adminDecision: null,
        adminDecidedBy: null,
        adminDecidedAt: null,
        adminRemarks: "",
        adminRejectionReason: "",
        createdAt: now,
      };
      entry.revisionHistory = [{
        revisionNumber: 1,
        action: "Submitted",
        submittedBy: data.monitoredBy,
        submittedAt: now,
        monitoredDate: entry.monitoredDate,
        healthyCount: healthy,
        damagedCount: damaged,
        deadCount: dead,
        totalMonitored,
        maturityStatus: entry.maturityStatus,
        remarks: entry.remarks,
        evidenceRevision: 1,
        evidenceRef: {
          ...(privateEvidence ? { privateEvidence } : {}),
          photoUrl: saved.url,
          imageHash: data.imageHash,
          photoName: entry.photoName,
          photoType: entry.photoType,
          photoSize: entry.photoSize,
          evidenceSource: entry.evidenceSource,
          locationSource: entry.locationSource,
          locationAccuracyMeters: entry.locationAccuracyMeters,
          captureSessionAuditId: entry.captureSessionAuditId,
          verificationPolicyVersion: 1,
          latitude,
          longitude,
          capturedAt: entry.photoTakenAt,
          captureTimestamp: entry.captureTimestamp,
          captureTimestampRaw: entry.captureTimestampRaw,
          captureDateManila: entry.captureDateManila,
          captureTimezoneSource: entry.captureTimezoneSource,
          captureTimestampValid: entry.captureTimestampValid,
          uploadedAt: now,
          siteGpsDistanceMeters: distance,
          siteGpsValid: inside,
          automatedVerificationStatus: entry.automatedVerificationStatus,
          suspiciousFlags: entry.suspiciousFlags,
        },
      }];
      entry.currentEvidenceRevision = 1;
      entry.auditHistory = [{
        action: "Submitted",
        actorId: data.monitoredBy,
        actorRole: data.requesterRole,
        fromStatus: null,
        toStatus: PHASE_TWO_STATUSES.PENDING,
        revisionNumber: 1,
        actedAt: now,
      }];
      const updatedHistory = [...history, entry];
      const nextMonitoringDate = officialNextMonitoringDate(updatedHistory, current);
      const payload = {
        ...seed,
        ...current,
        ...(earlyPolicy ? { earlyMonitoring: earlyPolicy } : {}),
        monitoringNumber,
        history: updatedHistory,
        nextMonitoringDate,
        condition: entry.condition,
        reviewStatus: PHASE_TWO_STATUSES.PENDING,
        latestObservationId: entry.id,
        latestObservationStatus: entry.reviewStatus,
        ...workflowCounts(updatedHistory),
        updatedAt: now,
        createdAt: current.createdAt || now,
      };
      if (complete) complete({ collection: "monitoringRecords", recordId: id, observationId });
      consumeCapture(`${id}:${observationId}`);
      if (currentDoc.exists) transaction.update(lifecycleRef, payload);
      else transaction.create(lifecycleRef, payload);
      transaction.create(hashRef, { lifecycleId: id, participantId: data.monitoredBy, createdAt: now });
      staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
        notificationId: `monitoring_submitted_staff_${id}_${entry.id}_${recipient.id}`,
        recipientUserId: recipient.id,
        type: "monitoring_submitted_staff",
        title: "New Monitoring Observation Submitted",
        message: `${entry.id} for ${current.siteName || current.plantingReportId} requires Staff review.`,
        relatedRecordType: "monitoring",
        relatedRecordId: id,
        relatedSubrecordId: entry.id,
        createdAt: now,
        details: { observationId: entry.id, reporterId: entry.originalReporterId, observationType, isFullCohortAssessment: entry.isFullCohortAssessment },
      }));
      createNotificationInTransaction(transaction, {
        notificationId: `monitoring_submitted_${id}_${entry.id}_${entry.originalReporterId}`,
        recipientUserId: entry.originalReporterId,
        type: "monitoring_submitted",
        title: "Monitoring Observation Submitted",
        message: `${entry.id} was submitted successfully and is pending MENRO Staff review.`,
        relatedRecordType: "monitoring",
        relatedRecordId: id,
        relatedSubrecordId: entry.id,
        createdAt: now,
        details: { observationId: entry.id, observationType, isFullCohortAssessment: entry.isFullCohortAssessment },
      });
    });
  } catch (error) {
    if (saved.target) await fs.unlink(saved.target).catch(() => {});
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
  const [allRecords, reportSnapshot] = await Promise.all([
    getAllMonitoringRecords(),
    reports.where("participantId", "==", participantId).get(),
  ]);
  const existing = allRecords.filter((record) => record.participantId === participantId ||
    (record.history || []).some((entry) =>
      entry.originalReporterId === participantId || entry.monitoredBy === participantId));
  const byReport = new Map(existing.map((record) => [record.plantingReportId, record]));
  for (const doc of reportSnapshot.docs) {
    const report = { id: doc.id, ...doc.data() };
    if ((report.verificationStatus !== "Approved" && report.reportingProgress !== "Completed") || byReport.has(doc.id)) continue;
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

async function getRawMonitoringRecordById(id) {
  const doc = await monitoringCollection.doc(id).get();
  if (!doc.exists) throw new Error("Monitoring record not found.");
  return { id: doc.id, ...doc.data() };
}

async function updateMonitoringRecord(id, data) {
  const ref = monitoringCollection.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Monitoring record not found.");
  await ref.update({ remarks: data.remarks ?? doc.data().remarks ?? "", updatedBy: data.updatedBy, updatedAt: Timestamp.now() });
  return getMonitoringRecordById(id);
}

async function transitionObservation({
  monitoringId, observationId, expectedVersion, actorId, actorRole, action, text,
}) {
  const ref = monitoringCollection.doc(monitoringId);
  await db.runTransaction(async (transaction) => {
    const roleRecipients = action === "review"
      ? await getRoleRecipientsInTransaction(transaction, ["admin"])
      : [];
    const doc = await transaction.get(ref);
    if (!doc.exists) throw workflowError("MONITORING_NOT_FOUND", "Monitoring record not found.", 404);
    const current = doc.data();
    const history = Array.isArray(current.history) ? [...current.history] : [];
    if (!history.length) throw workflowError("OBSERVATION_NOT_FOUND", "Monitoring record has no observations.", 404);
    const index = uniqueObservationIndex(history, observationId);
    const observation = history[index];
    if (Number(observation.workflowVersion) < 2) {
      throw workflowError("LEGACY_OBSERVATION_READ_ONLY", "Legacy monitoring observations are read-only.");
    }
    assertVersion(observation, expectedVersion);
    const now = Timestamp.now();
    let updated;
    if (action === "review") {
      if (actorRole !== "staff") throw workflowError("MONITORING_ACTION_FORBIDDEN", "Only MENRO Staff can review observations.", 403);
      if (observation.reviewStatus !== PHASE_TWO_STATUSES.PENDING) throw workflowError("INVALID_STATUS_TRANSITION", "Only pending observations can be reviewed.");
      const hasEvidence = Boolean(observation.photoUrl || observation.hasEvidence ||
        observation.revisionHistory?.some((revision) => revision.evidenceRef?.photoUrl || revision.evidenceRef?.privateEvidence));
      if (!hasEvidence) throw workflowError("OBSERVATION_EVIDENCE_MISSING", "Monitoring evidence is required before Staff review.", 422);
      const remarks = cleanWorkflowText(text);
      updated = { ...observation, reviewStatus: PHASE_TWO_STATUSES.REVIEWED,
        reviewVersion: Number(observation.reviewVersion || 0) + 1,
        staffReviewedBy: actorId, staffReviewedAt: now, staffReviewRemarks: remarks };
    } else if (action === "return") {
      if (actorRole !== "staff") throw workflowError("MONITORING_ACTION_FORBIDDEN", "Only MENRO Staff can return observations.", 403);
      if (observation.reviewStatus !== PHASE_TWO_STATUSES.PENDING) throw workflowError("INVALID_STATUS_TRANSITION", "Only pending observations can be returned for rechecking.");
      const reason = cleanWorkflowText(text, { required: true, label: "Return reason" });
      updated = { ...observation, reviewStatus: PHASE_TWO_STATUSES.RETURNED,
        reviewVersion: Number(observation.reviewVersion || 0) + 1,
        returnedBy: actorId, returnedAt: now, returnReason: reason };
    } else {
      if (actorRole !== "admin") throw workflowError("MONITORING_ACTION_FORBIDDEN", "Only MENRO Administrators can make final decisions.", 403);
      if (observation.reviewStatus !== PHASE_TWO_STATUSES.REVIEWED) throw workflowError("INVALID_STATUS_TRANSITION", "Only Staff-reviewed observations can receive a final decision.");
      if (!observation.staffReviewedBy || !observation.staffReviewedAt) throw workflowError("INVALID_STATUS_TRANSITION", "A Staff review is required before the Admin decision.");
      const isReject = action === "reject";
      const remarks = cleanWorkflowText(text, { required: isReject, label: isReject ? "Rejection reason" : "Remarks" });
      updated = { ...observation,
        reviewStatus: isReject ? PHASE_TWO_STATUSES.REJECTED : PHASE_TWO_STATUSES.APPROVED,
        reviewVersion: Number(observation.reviewVersion || 0) + 1,
        adminDecision: isReject ? "Reject" : "Approve",
        adminDecidedBy: actorId, adminDecidedAt: now,
        adminRemarks: isReject ? "" : remarks,
        adminRejectionReason: isReject ? remarks : "" };
    }
    updated.auditHistory = appendAudit(observation, {
      action: action === "review" ? "Reviewed" : action === "return" ? "Returned for Rechecking"
        : action === "approve" ? "Approved" : "Rejected",
      actorId, actorRole, fromStatus: observation.reviewStatus,
      toStatus: updated.reviewStatus, reason: action === "return" || action === "reject" ? text : "",
      remarks: action === "review" || action === "approve" ? text : "",
      revisionNumber: observation.revisionNumber || 1, actedAt: now,
    });
    history[index] = updated;
    const nextMonitoringDate = officialNextMonitoringDate(history, current);
    transaction.update(ref, { history, latestObservationId: updated.id,
      latestObservationStatus: updated.reviewStatus, nextMonitoringDate,
      ...workflowCounts(history), updatedAt: now });
    const reporterId = observation.originalReporterId || observation.monitoredBy;
    if (action === "return") {
      createNotificationInTransaction(transaction, {
        notificationId: `monitoring_returned_${monitoringId}_${observation.id}_${updated.reviewVersion}_${reporterId}`,
        recipientUserId: reporterId,
        type: "monitoring_returned",
        title: "Monitoring Observation Returned for Rechecking",
        message: `${observation.id} was returned for rechecking. Reason: ${updated.returnReason}`,
        relatedRecordType: "monitoring",
        relatedRecordId: monitoringId,
        relatedSubrecordId: observation.id,
        reason: updated.returnReason,
        createdAt: now,
        details: { observationId: observation.id, siteId: observation.siteId || current.siteId },
      });
    } else if (action === "review") {
      roleRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
        notificationId: `monitoring_reviewed_admin_${monitoringId}_${observation.id}_${updated.reviewVersion}_${recipient.id}`,
        recipientUserId: recipient.id,
        type: "monitoring_reviewed_admin",
        title: "Monitoring Observation Ready for Admin Decision",
        message: `${observation.id} was reviewed by MENRO Staff and requires an Admin decision.`,
        relatedRecordType: "monitoring",
        relatedRecordId: monitoringId,
        relatedSubrecordId: observation.id,
        createdAt: now,
        details: { observationId: observation.id, recommendation: "Reviewed", reviewerId: actorId, remarks: updated.staffReviewRemarks },
      }));
    } else {
      createNotificationInTransaction(transaction, {
        notificationId: `monitoring_${action === "approve" ? "approved" : "rejected"}_${monitoringId}_${observation.id}_${updated.reviewVersion}_${reporterId}`,
        recipientUserId: reporterId,
        type: action === "approve" ? "monitoring_approved" : "monitoring_rejected",
        title: action === "approve" ? "Monitoring Observation Approved" : "Monitoring Observation Rejected",
        message: action === "approve"
          ? `${observation.id} was approved by the MENRO Administrator.`
          : `${observation.id} was rejected. Reason: ${updated.adminRejectionReason}`,
        relatedRecordType: "monitoring",
        relatedRecordId: monitoringId,
        relatedSubrecordId: observation.id,
        ...(action === "reject" ? { reason: updated.adminRejectionReason } : {}),
        createdAt: now,
        details: { observationId: observation.id, finalStatus: updated.reviewStatus },
      });
    }
  });
  return getMonitoringRecordById(monitoringId);
}

const reviewMonitoringObservation = (args) => transitionObservation({ ...args, action: "review", text: args.remarks || "" });
const returnMonitoringObservation = (args) => transitionObservation({ ...args, action: "return", text: args.reason || "" });
const approveMonitoringObservation = (args) => transitionObservation({ ...args, action: "approve", text: args.remarks || "" });
const rejectMonitoringObservation = (args) => transitionObservation({ ...args, action: "reject", text: args.reason || "" });

async function resubmitMonitoringObservation(data) {
  const { idempotencyKey, file, imageDetails, metadata, imageHash, savedEvidence, captureEvidence, ...payload } = data;
  return require("./evidenceWorkflow.service").runWorkflow({ actor: { uid: data.actorId },
    workflow: "monitoring-resubmit", target: `${data.monitoringId}:${data.observationId}`,
    key: idempotencyKey, payload, files: file ? [file] : [] },
  operation => resubmitMonitoringObservationImpl({ ...data, workflowOperation: operation }),
  link => getMonitoringRecordById(link.recordId));
}
async function resubmitMonitoringObservationImpl(data) {
  const ref = monitoringCollection.doc(data.monitoringId);
  const operation = data.workflowOperation;
  let privateEvidence = null;
  let retainedCloudFingerprint = null;
  if (operation) {
    // Authorize BEFORE cloud admission/I/O; the transaction below repeats every guard.
    const doc = await ref.get();
    const history = doc.data()?.history || [];
    const observation = history[uniqueObservationIndex(history, data.observationId)];
    if (observation.originalReporterId !== data.actorId) throw workflowError("MONITORING_ACTION_FORBIDDEN", "Only the original reporter can resubmit this observation.", 403);
    assertVersion(observation, data.expectedVersion);
    if (observation.reviewStatus !== PHASE_TWO_STATUSES.RETURNED) throw workflowError("INVALID_STATUS_TRANSITION", "Only observations returned for rechecking can be resubmitted.");
    if (data.file) privateEvidence = await require("./evidenceWorkflow.service").workflow().upload(
      operation, 0, data.file, { recordId: data.observationId,
        evidenceType: observation.observationType === "early" ? "monitoring-early" : "monitoring-official",
        verification: { capturedAt: data.metadata?.capturedAt || null,
          latitude: Number(data.metadata?.latitude), longitude: Number(data.metadata?.longitude), gpsValid: true,
          timestampValid: data.metadata?.captureTimestampValid === true,
          evidenceSource: data.captureEvidence ? "browser-camera" : "original-exif",
          locationSource: data.captureEvidence ? "Browser Capture Session" : "Photo Metadata",
          locationAccuracyMeters: data.captureEvidence?.accuracyMeters ?? null, verificationPolicyVersion: 1 } });
    else {
      const retained = (observation.revisionHistory || []).find(revision =>
        Number(revision.evidenceRevision) === Number(data.retainEvidenceRevision));
      if (retained?.evidenceRef?.privateEvidence) {
        // Validate actual retained bytes OUTSIDE the transaction. Reuse is not a
        // new upload and consumes no upload intent or quota reservation.
        try {
          retainedRetrieval ||= require("./firebaseEvidenceRetrieval.service").createFirebaseEvidenceRetrieval();
          const token = retainedRetrieval.serverResolvedEvidence({ reference: retained.evidenceRef.privateEvidence,
            recordId: data.observationId, evidenceType: observation.observationType === "early" ? "monitoring-early" : "monitoring-official" });
          const sink = new (require("node:stream").Writable)({ write(chunk, encoding, callback) { callback(); } });
          sink.setHeader = () => {};
          await retainedRetrieval.streamTo(token, sink);
          retainedCloudFingerprint = require("./evidenceWorkflow.service").canonical(retained.evidenceRef.privateEvidence);
        } catch (error) {
          if (!["INVALID_EVIDENCE_REFERENCE", "EVIDENCE_NOT_FOUND", "EVIDENCE_GENERATION_MISMATCH",
            "EVIDENCE_SIZE_MISMATCH", "EVIDENCE_CONTENT_TYPE_MISMATCH", "EVIDENCE_METADATA_MISMATCH",
            "EVIDENCE_CHECKSUM_MISMATCH"].includes(error.code)) {
            const { EvidenceWorkflowError } = require("./evidenceWorkflow.service");
            throw new EvidenceWorkflowError("EVIDENCE_RECONCILIATION_REQUIRED", 503,
              "Existing evidence is temporarily unavailable. Please retry with the same Idempotency-Key.");
          }
          throw workflowError("OBSERVATION_EVIDENCE_INVALID", "Existing evidence could not be verified. Please provide a valid replacement photo.", 422);
        }
      }
    }
  }
  if (data.file) {
    const saved = privateEvidence ? { target: null, url: "" } : await savePhoto(data.file, data.actorId);
    data.savedEvidence = {
      target: saved.target,
      imageHash: data.imageHash,
      evidenceRef: {
        ...(privateEvidence ? { privateEvidence } : {}),
        photoUrl: saved.url, imageHash: data.imageHash,
        photoName: data.file.originalname, photoType: data.file.mimetype,
        photoSize: data.file.size, latitude: Number(data.metadata.latitude),
        longitude: Number(data.metadata.longitude), capturedAt: data.metadata.capturedAt || null,
        evidenceSource: data.captureEvidence ? "browser-camera" : "original-exif",
        locationSource: data.captureEvidence ? "Browser Capture Session" : "Photo Metadata",
        locationAccuracyMeters: data.captureEvidence?.accuracyMeters ?? null,
        captureSessionAuditId: data.captureEvidence?.id || null,
        verificationPolicyVersion: 1,
        captureTimestamp: data.metadata.captureTimestamp || null,
        captureTimestampRaw: data.metadata.captureTimestampRaw || "",
        captureDateManila: data.metadata.captureDateManila || "",
        captureTimezoneSource: data.metadata.captureTimezoneSource || "",
        captureTimestampValid: data.metadata.captureTimestampValid === true,
        imageDetails: data.imageDetails || null,
        uploadedAt: Timestamp.now(),
      },
    };
  }
  let newFile = data.savedEvidence?.target || null;
  try {
    await db.runTransaction(async (transaction) => {
      const complete = operation ? await require("./evidenceWorkflow.service").workflow().prepareLink(transaction, operation) : null;
      const consumeCapture = await require("./evidenceCaptureSession.service").prepareConsumption(
        transaction, data.captureEvidence ? [data.captureEvidence] : []);
      const staffRecipients = await getRoleRecipientsInTransaction(transaction, ["staff"]);
      const doc = await transaction.get(ref);
      if (!doc.exists) throw workflowError("MONITORING_NOT_FOUND", "Monitoring record not found.", 404);
      const current = doc.data();
      const history = Array.isArray(current.history) ? [...current.history] : [];
      const index = uniqueObservationIndex(history, data.observationId);
      const observation = history[index];
      assertVersion(observation, data.expectedVersion);
      if (observation.reviewStatus !== PHASE_TWO_STATUSES.RETURNED) {
        throw workflowError("INVALID_STATUS_TRANSITION", "Only observations returned for rechecking can be resubmitted.");
      }
      if (observation.originalReporterId !== data.actorId) {
        throw workflowError("MONITORING_ACTION_FORBIDDEN", "Only the original reporter can resubmit this observation.", 403);
      }
      const reportRef = reports.doc(observation.plantingReportId || current.plantingReportId);
      const siteRef = sites.doc(observation.siteId || current.siteId);
      const [reportDoc, siteDoc] = await Promise.all([transaction.get(reportRef), transaction.get(siteRef)]);
      if (!reportDoc.exists || !siteDoc.exists) throw workflowError("MONITORING_RELATIONSHIP_MISSING", "The planting report or site is unavailable.", 422);
      const report = reportDoc.data();
      const quantity = Number(observation.cohortQuantityAtObservation);
      if (report.participantId !== current.participantId || report.siteId !== current.siteId || Number(report.quantityPlanted) !== quantity) {
        throw workflowError("MONITORING_RELATIONSHIP_CHANGED", "The planting report relationships changed. A new observation is required.");
      }
      const total = Number(data.totalMonitored), healthy = Number(data.healthyCount), damaged = Number(data.damagedCount), dead = Number(data.deadCount);
      if (!Number.isInteger(total) || total <= 0 || total > quantity ||
          ![healthy, damaged, dead].every((value) => Number.isInteger(value) && value >= 0) || healthy + damaged + dead !== total) {
        throw workflowError("INVALID_MONITORING_INPUT", "Monitoring counts are invalid.", 400);
      }
      parseDateOnly(data.monitoredDate, "Date monitored must be a valid calendar date.");
      const isEarly = observation.observationType === "early";
      const earliestDate = isEarly ? current.earlyMonitoring?.openingDate : current.startMonitoringDate;
      const latestExclusive = isEarly ? current.earlyMonitoring?.officialOpeningDate : current.monitoringEndDate;
      if (data.monitoredDate > todayInBulan() || !earliestDate || !latestExclusive ||
          data.monitoredDate < earliestDate || data.monitoredDate >= latestExclusive) {
        throw workflowError("INVALID_MONITORING_INPUT", "Date monitored is outside the allowed monitoring period.", 400);
      }
      if (!["Immature", "Mature"].includes(data.maturityStatus)) {
        throw workflowError("INVALID_MONITORING_INPUT", "Maturity status must be either Immature or Mature.", 400);
      }
      const revisions = Array.isArray(observation.revisionHistory) ? [...observation.revisionHistory] : [];
      if (revisions.length >= MAX_REVISIONS_PER_OBSERVATION) throw workflowError("OBSERVATION_HISTORY_LIMIT", "This observation has reached its revision limit.", 422);
      const requestedEvidenceRevision = Number(data.retainEvidenceRevision);
      let evidenceRef;
      let reusedEvidence = false;
      if (data.savedEvidence) {
        const duplicateRef = evidenceHashes.doc(data.savedEvidence.imageHash);
        const duplicate = await transaction.get(duplicateRef);
        if (duplicate.exists) throw workflowError("DUPLICATE_EVIDENCE", "Duplicate monitoring image detected.");
        evidenceRef = data.savedEvidence.evidenceRef;
        transaction.create(duplicateRef, { lifecycleId: data.monitoringId, observationId: data.observationId, createdAt: Timestamp.now() });
      } else {
        const retained = revisions.find((revision) => Number(revision.evidenceRevision) === requestedEvidenceRevision);
        if (!retained?.evidenceRef) throw workflowError("OBSERVATION_EVIDENCE_MISSING", "Valid existing evidence was not found.", 422);
        evidenceRef = retained.evidenceRef;
        if (operation && evidenceRef.privateEvidence && require("./evidenceWorkflow.service").canonical(evidenceRef.privateEvidence) !== retainedCloudFingerprint) {
          throw workflowError("STALE_OBSERVATION_VERSION", "The evidence changed while the correction was being submitted. Please refresh and try again.");
        }
        reusedEvidence = true;
      }
      const retainedCapture = evidenceRef.captureTimestamp || evidenceRef.capturedAt;
      if (!reusedEvidence || retainedCapture) {
        const timestampAudit = validateMonitoringEvidenceTimestamp({
          capturedAt: retainedCapture,
          captureOffset: evidenceRef.captureTimezoneSource === "EXIF offset" ? "stored-offset" : "",
        }, data.monitoredDate, new Date());
        evidenceRef = { ...evidenceRef, ...timestampAudit };
      }
      const site = siteDoc.data();
      const latitude = Number(evidenceRef.latitude), longitude = Number(evidenceRef.longitude);
      const distance = calculateDistanceMeters(latitude, longitude, Number(site.latitude), Number(site.longitude));
      const inside = Array.isArray(site.polygon) && site.polygon.length >= 3
        ? isPointInPolygon(latitude, longitude, site.polygon) : distance <= SITE_TOLERANCE_METERS;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !inside) {
        throw workflowError("OBSERVATION_EVIDENCE_INVALID", "Existing evidence is not valid for the registered planting site.", 422);
      }
      evidenceRef = {
        ...evidenceRef,
        siteGpsDistanceMeters: distance,
        siteGpsValid: inside,
        automatedVerificationStatus: inside ? "Passed Automated Check" : "Flagged",
        suspiciousFlags: inside ? [] : ["OUTSIDE_REGISTERED_SITE"],
      };
      const now = Timestamp.now();
      const revisionNumber = Number(observation.revisionNumber || revisions.length || 1) + 1;
      const revision = { revisionNumber, action: "Resubmitted", submittedBy: data.actorId,
        submittedAt: now, monitoredDate: data.monitoredDate, healthyCount: healthy,
        damagedCount: damaged, deadCount: dead, totalMonitored: total,
        maturityStatus: data.maturityStatus, remarks: data.remarks || "",
        evidenceRevision: reusedEvidence ? requestedEvidenceRevision : revisionNumber,
        reusedEvidence, evidenceRef };
      const updated = { ...observation, monitoredDate: data.monitoredDate,
        ...(evidenceRef.privateEvidence ? { privateEvidence: evidenceRef.privateEvidence, hasEvidence: true }
          : observation.privateEvidence ? { privateEvidence: null } : {}),
        healthyCount: healthy, damagedCount: damaged, deadCount: dead, totalMonitored: total,
        isFullCohortAssessment: total === quantity, survivingCount: healthy + damaged,
        survivalRate: calculateSurvivalRate(healthy, damaged, total),
        mortalityRate: Number(((dead / total) * 100).toFixed(2)),
        condition: deriveCondition(healthy, damaged, dead, total), maturityStatus: data.maturityStatus,
        remarks: data.remarks || "", latitude, longitude, siteGpsDistanceMeters: distance,
        siteGpsValid: inside, currentEvidenceRevision: revision.evidenceRevision,
        photoUrl: evidenceRef.photoUrl, imageHash: evidenceRef.imageHash,
        photoName: evidenceRef.photoName || observation.photoName || "Monitoring evidence",
        photoType: evidenceRef.photoType || observation.photoType || "",
        photoSize: Number(evidenceRef.photoSize || observation.photoSize || 0),
        photoTakenAt: evidenceRef.capturedAt || observation.photoTakenAt || null,
        captureTimestamp: evidenceRef.captureTimestamp || observation.captureTimestamp || null,
        captureTimestampRaw: evidenceRef.captureTimestampRaw || observation.captureTimestampRaw || "",
        captureDateManila: evidenceRef.captureDateManila || observation.captureDateManila || "",
        captureTimezoneSource: evidenceRef.captureTimezoneSource || observation.captureTimezoneSource || "",
        captureTimestampValid: evidenceRef.captureTimestampValid === true,
        imageDetails: evidenceRef.imageDetails || observation.imageDetails || null,
        automatedVerificationStatus: inside ? "Passed Automated Check" : "Flagged",
        suspiciousFlags: inside ? [] : ["Evidence GPS is outside the registered planting site."],
        reviewStatus: PHASE_TWO_STATUSES.PENDING,
        reviewVersion: Number(observation.reviewVersion || 0) + 1,
        revisionNumber, revisionHistory: [...revisions, revision], updatedAt: now };
      updated.auditHistory = appendAudit(observation, { action: "Resubmitted", actorId: data.actorId,
        actorRole: "participant", fromStatus: observation.reviewStatus,
        toStatus: PHASE_TWO_STATUSES.PENDING, revisionNumber, actedAt: now });
      history[index] = updated;
      const nextMonitoringDate = officialNextMonitoringDate(history, current);
      if (complete) complete({ collection: "monitoringRecords", recordId: data.monitoringId, observationId: data.observationId, revisionNumber });
      consumeCapture(`${data.monitoringId}:${data.observationId}:${revisionNumber}`);
      transaction.update(ref, { history, latestObservationId: updated.id,
        latestObservationStatus: updated.reviewStatus, nextMonitoringDate,
        ...workflowCounts(history), updatedAt: now });
      staffRecipients.forEach((recipient) => createNotificationInTransaction(transaction, {
        notificationId: `monitoring_resubmitted_staff_${data.monitoringId}_${updated.id}_${revisionNumber}_${recipient.id}`,
        recipientUserId: recipient.id,
        type: "monitoring_resubmitted_staff",
        title: "Monitoring Observation Resubmitted",
        message: `${updated.id} revision ${revisionNumber} was resubmitted for Staff review.`,
        relatedRecordType: "monitoring",
        relatedRecordId: data.monitoringId,
        relatedSubrecordId: updated.id,
        createdAt: now,
        details: { observationId: updated.id, revisionNumber, reviewVersion: updated.reviewVersion },
      }));
    });
    newFile = null;
    return getMonitoringRecordById(data.monitoringId);
  } catch (error) {
    if (newFile) await fs.unlink(newFile).catch(() => {});
    throw error;
  }
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
  getRawMonitoringRecordById,
  getMonitoringRecordsByParticipantId, updateMonitoringRecord,
  reviewMonitoringObservation, returnMonitoringObservation,
  approveMonitoringObservation, rejectMonitoringObservation,
  resubmitMonitoringObservation, archiveMonitoringRecord,
  addDays, addCalendarMonth, addYears, lifecycleStatus, nextMonitoringDateForObservation,
  officialNextMonitoringDate, hasOutstandingObservation,
};
