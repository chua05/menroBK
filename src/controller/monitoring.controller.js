const {
  createMonitoringRecord, getAllMonitoringRecords, getMonitoringRecordById,
  getMonitoringRecordsByParticipantId, updateMonitoringRecord,
  reviewMonitoringRecord, archiveMonitoringRecord,
} = require("../services/monitoring.service");
const {
  generateImageHash, validateImageBuffer, extractImageMetadata, isClearlyScreenshot,
} = require("../utils/imageVerification.util");

async function addMonitoringRecord(req, res) {
  try {
    const { plantingReportId, healthyCount, damagedCount, deadCount, maturityStatus, remarks } = req.body || {};
    if (!plantingReportId || healthyCount === undefined || damagedCount === undefined || deadCount === undefined || !maturityStatus) {
      return res.status(400).json({ success: false, message: "All required monitoring fields must be provided." });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: "A monitoring photo is required." });
    }
    const counts = [healthyCount, damagedCount, deadCount].map(Number);
    if (counts.some((count) => !Number.isInteger(count) || count < 0)) {
      return res.status(400).json({ success: false, message: "Healthy, damaged, and dead counts must be non-negative integers." });
    }
    if (!["Immature", "Mature"].includes(maturityStatus)) {
      return res.status(400).json({ success: false, message: "Maturity status must be either Immature or Mature." });
    }

    const imageDetails = await validateImageBuffer(req.file.buffer);
    const metadata = await extractImageMetadata(req.file.buffer);
    if (isClearlyScreenshot({ fileName: req.file.originalname, metadata })) {
      throw new Error("Screenshot images are not accepted as planting evidence. Please upload the original geotagged photo.");
    }
    const latitude = metadata.latitude === null ? NaN : Number(metadata.latitude);
    const longitude = metadata.longitude === null ? NaN : Number(metadata.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error("This photo does not contain GPS location metadata. Please upload an original geotagged photo with location information.");
    }

    const record = await createMonitoringRecord({
      plantingReportId,
      healthyCount: counts[0], damagedCount: counts[1], deadCount: counts[2],
      maturityStatus, remarks: typeof remarks === "string" ? remarks.trim() : "",
      monitoredBy: req.user.uid, requesterRole: req.user.role,
      file: req.file, imageDetails, metadata,
      imageHash: generateImageHash(req.file.buffer),
    });
    return res.status(201).json({ success: true, message: "Monitoring record submitted successfully.", data: record });
  } catch (error) {
    const status = error.message === "Planting report not found." || error.message === "Planting site not found." ? 404 : 400;
    return res.status(status).json({ success: false, message: error.message });
  }
}

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
async function reviewMonitoring(req, res) {
  try {
    const data = await reviewMonitoringRecord(req.params.id, req.user.uid);
    return res.status(200).json({ success: true, message: "Monitoring lifecycle marked as reviewed.", data });
  } catch (error) {
    return res.status(error.message === "Monitoring record not found." ? 404 : 400).json({ success: false, message: error.message });
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

module.exports = { addMonitoringRecord, getMonitoringRecords, getMonitoringRecord, getMyMonitoringRecords, updateMonitoring, reviewMonitoring, archiveMonitoring };
