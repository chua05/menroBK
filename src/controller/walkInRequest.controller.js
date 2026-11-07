const { createHash } = require("node:crypto");
const { submitSeedlingRequest, resubmitRequest } = require("./seedlingRequest.controller");
const { deriveSeedlingRequestDocumentId } = require("../services/seedlingRequest.service");
const letters = require("../services/requestLetterStorage.service");
const { db } = require("../config/firebase");
const { isValidPhilippineContactNumber } = require("../utils/philippineContact.util");
const clean = value => typeof value === "string" ? value.trim() : "";
async function submitWalkIn(req, res, resubmitting = false) {
  if (!req.user?.uid || req.user.role !== "staff") return res.status(req.user?.uid ? 403 : 401).json({ success: false, message: "Staff access is required." });
  try {
    const body = typeof req.body?.request === "string" ? JSON.parse(req.body.request) : req.body;
    const citizen = body?.citizen;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body?.clientSubmissionId || "")) throw Object.assign(new Error("Use a valid submission identifier."), { status: 400 });
    const errors = {};
    if (!clean(citizen?.fullName) || citizen.fullName.length > 160) errors.fullName = "Enter the actual citizen requester name.";
    if (!isValidPhilippineContactNumber(clean(citizen?.contactNumber))) errors.contactNumber = "Enter a valid Philippine mobile or landline number.";
    if (!clean(citizen?.receiptReference) || citizen.receiptReference.length > 120) errors.receiptReference = "Enter the acknowledgement receipt reference.";
    if (!req.files?.acknowledgement?.[0]) errors.acknowledgement = "Upload the citizen's signed acknowledgement (PDF, JPEG or PNG).";
    if (Object.keys(errors).length) return res.status(400).json({ success: false, message: "Complete the walk-in requester and acknowledgement fields.", fieldErrors: errors });
    let prior;
    if (resubmitting) {
      const snapshot = await db.collection("seedlingRequests").doc(req.params.id).get();
      prior = snapshot.data();
      if (!snapshot.exists || prior.walkIn?.encodedBy !== req.user.uid) return res.status(404).json({ success: false, message: "Editable walk-in request not found." });
      if (prior.status !== "Returned" || !Number.isSafeInteger(body.expectedVersion) || prior.requestVersion !== body.expectedVersion) return res.status(409).json({ success: false, message: "The returned walk-in request changed. Refresh before correction." });
    }
    const subjectId = prior?.participantId || `walkin_${createHash("sha256").update(`${req.user.uid}:${body.clientSubmissionId}`).digest("hex").slice(0, 32)}`;
    const requestId = resubmitting ? req.params.id : deriveSeedlingRequestDocumentId(subjectId, body.clientSubmissionId);
    const file = req.files.acknowledgement[0];
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)) throw Object.assign(new Error("Use a signed PDF, JPEG or PNG acknowledgement."), { status: 400 });
    // Reuse the accepted private document validator, immutable upload intent,
    // generation checks and authenticated streaming; this is not planting evidence.
    const acknowledgement = await letters.uploadRequestLetter({ requestId, participantId: subjectId, clientSubmissionId: resubmitting ? `replacement-${requestId}-${body.expectedVersion}-ack` : `${body.clientSubmissionId}-ack`, file });
    req.body = { ...body }; delete req.body.citizen;
    req.file = req.files.requestLetter?.[0];
    req.requesterContext = { uid: subjectId, fullName: clean(citizen.fullName), contactNumber: clean(citizen.contactNumber), organization: clean(body.workflow?.organizationName) };
    req.walkInContext = { requesterId: subjectId, encodedBy: req.user.uid, encodedByName: req.user.fullName || "MENRO Staff", receiptReference: clean(citizen.receiptReference), acknowledgement, acknowledgementStatus: "RECEIVED_PENDING_MANUAL_REVIEW", citizenHasAccount: false };
    return resubmitting ? resubmitRequest(req, res) : submitSeedlingRequest(req, res);
  } catch (error) { return res.status(error.status || 400).json({ success: false, message: error.status && error.status >= 500 ? "Secure acknowledgement storage is unavailable. Retry the same submission." : "The walk-in submission or acknowledgement is invalid." }); }
}
async function acknowledgement(req, res) {
  const snapshot = await db.collection("seedlingRequests").doc(req.params.id).get();
  if (!snapshot.exists || !snapshot.data().walkIn?.acknowledgement) return res.status(404).json({ success: false, message: "Acknowledgement not found." });
  const document = await db.collection("walkInAcknowledgements").doc(req.params.id).get();
  if (!document.exists || document.data().requestId !== req.params.id || document.data().encodedBy !== snapshot.data().walkIn.encodedBy) return res.status(404).json({ success: false, message: "Acknowledgement not found." });
  try { await letters.streamRequestLetter(document.data().descriptor, res); }
  catch (error) { if (!res.headersSent) res.status(error.status || 503).json({ success: false, message: "Acknowledgement is unavailable." }); }
}
async function recordSchedule(req, res) {
  try {
    const body = typeof req.body?.request === "string" ? JSON.parse(req.body.request) : req.body;
    const snapshot = await db.collection("seedlingRequests").doc(req.params.id).get(), request = snapshot.data();
    if (!snapshot.exists || request.walkIn?.encodedBy !== req.user.uid) return res.status(404).json({ success: false, message: "Editable walk-in request not found." });
    if (!Number.isSafeInteger(body.expectedVersion) || request.requestVersion !== body.expectedVersion) return res.status(409).json({ success: false, message: "The walk-in schedule changed. Refresh before recording an acknowledgement." });
    if (!["confirm", "late-proposal"].includes(body.action) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.clientSubmissionId || "") || !clean(body.receiptReference) || body.receiptReference.length > 120 || !req.files?.acknowledgement?.[0]) return res.status(400).json({ success: false, message: "A schedule action, receipt and signed acknowledgement are required." });
    if (!["application/pdf", "image/jpeg", "image/png"].includes(req.files.acknowledgement[0].mimetype)) return res.status(400).json({ success: false, message: "Use a signed PDF, JPEG or PNG acknowledgement." });
    const acknowledgement = await letters.uploadRequestLetter({ requestId: req.params.id, participantId: request.participantId, clientSubmissionId: `${body.clientSubmissionId}-schedule-${body.expectedVersion}`, file: req.files.acknowledgement[0] });
    const actor = { ...req.user, acknowledgement, receiptReference: clean(body.receiptReference) };
    const service = require("../services/seedlingRequest.service");
    const data = await (body.action === "confirm" ? service.confirmPreApprovalSchedule : service.proposeLateReleaseSchedule)(req.params.id, request.participantId, body, actor);
    return res.json({ success: true, data });
  } catch (error) { return res.status(error.status || (error.code === "STALE_REQUEST_VERSION" ? 409 : 400)).json({ success: false, message: error.status >= 500 ? "Secure acknowledgement storage is unavailable." : error.message || "The signed schedule acknowledgement could not be recorded." }); }
}
module.exports = { submitWalkIn: (req, res) => submitWalkIn(req, res), resubmitWalkIn: (req, res) => submitWalkIn(req, res, true), acknowledgement, recordSchedule };
