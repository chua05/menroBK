const {
  createMonitoringRecord, getAllMonitoringRecords, getMonitoringRecordById,
  getMonitoringRecordsByParticipantId, updateMonitoringRecord,
  reviewMonitoringObservation, returnMonitoringObservation,
  approveMonitoringObservation, rejectMonitoringObservation,
  resubmitMonitoringObservation, archiveMonitoringRecord,
} = require("../services/monitoring.service");
const {
  generateImageHash, validateImageBuffer, extractImageMetadata, isClearlyScreenshot,
} = require("../utils/imageVerification.util");
const { validateMonitoringEvidenceTimestamp } = require("../utils/monitoringEvidenceTimestamp.util");

async function addMonitoringRecord(req, res, observationType = "official") {
  // Express supplies next as argument three on the official POST route.
  observationType = observationType === "early" ? "early" : "official";
  try {
    const {
      plantingReportId, totalMonitored, healthyCount, damagedCount, deadCount,
      maturityStatus, monitoredDate, remarks,
    } = req.body || {};
    if (!plantingReportId || totalMonitored === undefined || healthyCount === undefined ||
        damagedCount === undefined || deadCount === undefined || !maturityStatus || !monitoredDate) {
      return res.status(400).json({ success: false, message: "All required monitoring fields must be provided." });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: "A monitoring photo is required." });
    }
    const monitoredTotal = Number(totalMonitored);
    const counts = [healthyCount, damagedCount, deadCount].map(Number);
    if (!Number.isInteger(monitoredTotal) || monitoredTotal <= 0 ||
        counts.some((count) => !Number.isInteger(count) || count < 0)) {
      return res.status(400).json({ success: false,
        message: "Total trees checked must be a positive whole number, and tree condition counts must be non-negative whole numbers." });
    }
    if (counts.reduce((sum, count) => sum + count, 0) !== monitoredTotal) {
      return res.status(400).json({ success: false,
        message: "Healthy, damaged, and dead counts must equal the total trees checked." });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(monitoredDate))) {
      return res.status(400).json({ success: false, message: "Date monitored must be a valid date." });
    }
    if (!["Immature", "Mature"].includes(maturityStatus)) {
      return res.status(400).json({ success: false, message: "Maturity status must be either Immature or Mature." });
    }

    const imageDetails = await validateImageBuffer(req.file.buffer);
    const [captureEvidence] = await require("../services/evidenceCaptureSession.service").resolveSubmissionEvidence({
      actorId: req.user.uid,
      workflow: observationType === "early" ? "monitoring-early" : "monitoring-official",
      binding: { plantingReportId, siteId: req.body?.siteId },
      files: [req.file], manifest: req.body?.evidenceManifest,
    });
    const metadata = captureEvidence ? {
      latitude: captureEvidence.latitude, longitude: captureEvidence.longitude,
      capturedAt: captureEvidence.capturedAtClient.toDate().toISOString(),
      gpsStatus: "browser-session", evidenceSource: "browser-camera",
      locationSource: "Browser Capture Session", locationAccuracyMeters: captureEvidence.accuracyMeters,
    } : await extractImageMetadata(req.file.buffer);
    if (!captureEvidence && isClearlyScreenshot({ fileName: req.file.originalname, metadata })) {
      throw new Error("Screenshot images are not accepted as planting evidence. Please upload the original geotagged photo.");
    }
    const latitude = metadata.latitude === null ? NaN : Number(metadata.latitude);
    const longitude = metadata.longitude === null ? NaN : Number(metadata.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error("This photo does not contain GPS location metadata. Please upload an original geotagged photo with location information.");
    }
    const captureAudit = validateMonitoringEvidenceTimestamp(metadata, String(monitoredDate), new Date());

    const record = await createMonitoringRecord({
      idempotencyKey: req.headers?.["idempotency-key"],
      plantingReportId,
      totalMonitored: monitoredTotal,
      healthyCount: counts[0], damagedCount: counts[1], deadCount: counts[2],
      maturityStatus, monitoredDate: String(monitoredDate),
      remarks: typeof remarks === "string" ? remarks.trim() : "",
      monitoredBy: req.user.uid, requesterRole: req.user.role,
      file: req.file, imageDetails, metadata: { ...metadata, ...captureAudit }, observationType,
      imageHash: generateImageHash(req.file.buffer), captureEvidence,
    });
    return res.status(201).json({ success: true, message: "Monitoring record submitted successfully.", data: record });
  } catch (error) {
    if (require("../services/evidenceWorkflow.service").workflowErrorResponse(res, error)) return;
    const status = error.message === "Planting report not found." || error.message === "Planting site not found." ? 404 : 400;
    return res.status(status).json({ success: false, message: error.message });
  }
}

const addEarlyMonitoringRecord = (req, res) => addMonitoringRecord(req, res, "early");

async function getMonitoringRecords(req, res) {
  try {
    const data = await getAllMonitoringRecords(req.query);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to retrieve monitoring records." });
  }
}
async function getMyMonitoringRecords(req, res) {
  try {
    const data = await getMonitoringRecordsByParticipantId(req.user.uid);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to retrieve your monitoring records." });
  }
}
async function getMonitoringRecord(req, res) {
  try {
    return res.status(200).json({ success: true, data: await getMonitoringRecordById(req.params.id) });
  } catch (error) {
    return res.status(404).json({ success: false, message: error.message });
  }
}
async function updateMonitoring(req, res) {
  try {
    const data = await updateMonitoringRecord(req.params.id, { ...req.body, updatedBy: req.user.uid });
    return res.status(200).json({ success: true, message: "Monitoring lifecycle updated.", data });
  } catch (error) {
    return res.status(error.message === "Monitoring record not found." ? 404 : 400).json({ success: false, message: error.message });
  }
}
function workflowStatus(error) {
  return Number(error?.status) || (error?.code === "OBSERVATION_NOT_FOUND" ? 404 : 400);
}
function requestError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function reviewMonitoring(req, res) {
  try {
    const data = await reviewMonitoringObservation({ monitoringId: req.params.monitoringId,
      observationId: req.params.observationId, expectedVersion: req.body?.expectedVersion,
      remarks: req.body?.remarks, actorId: req.user.uid, actorRole: req.user.role });
    return res.status(200).json({ success: true, message: "Monitoring observation reviewed.", data });
  } catch (error) {
    return res.status(workflowStatus(error)).json({ success: false, code: error.code, message: error.message });
  }
}
async function returnMonitoring(req, res) {
  try {
    const data = await returnMonitoringObservation({ monitoringId: req.params.monitoringId,
      observationId: req.params.observationId, expectedVersion: req.body?.expectedVersion,
      reason: req.body?.reason, actorId: req.user.uid, actorRole: req.user.role });
    return res.status(200).json({ success: true, message: "Monitoring observation returned for rechecking.", data });
  } catch (error) {
    return res.status(workflowStatus(error)).json({ success: false, code: error.code, message: error.message });
  }
}
async function decideMonitoring(action, req, res) {
  try {
    const operation = action === "approve" ? approveMonitoringObservation : rejectMonitoringObservation;
    const data = await operation({ monitoringId: req.params.monitoringId,
      observationId: req.params.observationId, expectedVersion: req.body?.expectedVersion,
      remarks: req.body?.remarks, reason: req.body?.reason,
      actorId: req.user.uid, actorRole: req.user.role });
    return res.status(200).json({ success: true,
      message: `Monitoring observation ${action === "approve" ? "approved" : "rejected"}.`, data });
  } catch (error) {
    return res.status(workflowStatus(error)).json({ success: false, code: error.code, message: error.message });
  }
}
const approveMonitoring = (req, res) => decideMonitoring("approve", req, res);
const rejectMonitoring = (req, res) => decideMonitoring("reject", req, res);

async function resubmitMonitoring(req, res) {
  try {
    let imageDetails = null;
    let metadata = null;
    let imageHash = null;
    if (req.file?.buffer) {
      imageDetails = await validateImageBuffer(req.file.buffer);
      const [captureEvidence] = await require("../services/evidenceCaptureSession.service").resolveSubmissionEvidence({
        actorId: req.user.uid, workflow: "monitoring-resubmit",
        binding: { plantingReportId: req.body?.plantingReportId, siteId: req.body?.siteId,
          monitoringId: req.params.monitoringId, observationId: req.params.observationId,
          expectedVersion: req.body?.expectedVersion },
        files: [req.file], manifest: req.body?.evidenceManifest,
      });
      metadata = captureEvidence ? {
        latitude: captureEvidence.latitude, longitude: captureEvidence.longitude,
        capturedAt: captureEvidence.capturedAtClient.toDate().toISOString(),
        gpsStatus: "browser-session", evidenceSource: "browser-camera",
        locationSource: "Browser Capture Session", locationAccuracyMeters: captureEvidence.accuracyMeters,
      } : await extractImageMetadata(req.file.buffer);
      if (!captureEvidence && isClearlyScreenshot({ fileName: req.file.originalname, metadata })) {
        throw requestError("INVALID_MONITORING_INPUT", "Screenshot images are not accepted as monitoring evidence.");
      }
      if (!Number.isFinite(Number(metadata.latitude)) || !Number.isFinite(Number(metadata.longitude))) {
        throw requestError("INVALID_MONITORING_INPUT", "The replacement photo must contain valid GPS metadata.");
      }
      imageHash = generateImageHash(req.file.buffer);
      metadata = { ...metadata,
        ...validateMonitoringEvidenceTimestamp(metadata, String(req.body?.monitoredDate), new Date()) };
      req.captureEvidence = captureEvidence;
    }
    const data = await resubmitMonitoringObservation({
      idempotencyKey: req.headers?.["idempotency-key"],
      monitoringId: req.params.monitoringId, observationId: req.params.observationId,
      expectedVersion: req.body?.expectedVersion, retainEvidenceRevision: req.body?.retainEvidenceRevision,
      totalMonitored: req.body?.totalMonitored, healthyCount: req.body?.healthyCount,
      damagedCount: req.body?.damagedCount, deadCount: req.body?.deadCount,
      monitoredDate: req.body?.monitoredDate, maturityStatus: req.body?.maturityStatus,
      remarks: typeof req.body?.remarks === "string" ? req.body.remarks.trim() : "",
      actorId: req.user.uid, file: req.file, imageDetails, metadata, imageHash,
      captureEvidence: req.captureEvidence || null,
    });
    return res.status(200).json({ success: true, message: "Monitoring observation resubmitted for review.", data });
  } catch (error) {
    if (require("../services/evidenceWorkflow.service").workflowErrorResponse(res, error)) return;
    return res.status(workflowStatus(error)).json({ success: false, code: error.code, message: error.message });
  }
}
async function archiveMonitoring(req, res) {
  try {
    const data = await archiveMonitoringRecord(req.params.id, req.user.uid);
    return res.status(200).json({ success: true, message: "Monitoring lifecycle archived.", data });
  } catch (error) {
    return res.status(error.message === "Monitoring record not found." ? 404 : 400).json({ success: false, message: error.message });
  }
}

module.exports = { addMonitoringRecord, getMonitoringRecords, getMonitoringRecord, getMyMonitoringRecords,
  addEarlyMonitoringRecord,
  updateMonitoring, reviewMonitoring, returnMonitoring, resubmitMonitoring,
  approveMonitoring, rejectMonitoring, archiveMonitoring };
