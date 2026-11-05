const { createHash } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("../config/firebase");
const { availableForReporting, progressFor, wholeQuantity } = require("../utils/plantingBalance.util");
const { reportDetails, normalizeSubmission } = require("./parentPlantingReport.service");
const { activationState, buildEarlyMonitoringPolicy, shiftCalendarDate } = require("../utils/earlyMonitoring.util");
const fail = (status, message, fieldErrors) => Object.assign(new Error(message), { status, ...(fieldErrors ? { fieldErrors } : {}) });
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = value => createHash("sha256").update(value).digest("hex");
function staff(user) {
  if (!user?.uid || String(user.role).toLowerCase() !== "staff") throw fail(user?.uid ? 403 : 401, "MENRO Staff access is required.");
}
function assertReleased(request, event, distribution, requestId, eventId) {
  if (request.status !== "Released" || distribution.status !== "Released" || distribution.requestId !== requestId ||
      distribution.eventId !== eventId || request.eventId !== eventId || event.sourceRequestId !== requestId ||
      distribution.participantId !== request.participantId || !event.allocationReleasedAt ||
      ["Cancelled", "Rejected", "Archived"].includes(event.status) || event.isDeleted === true || event.isArchived === true) {
    throw fail(409, "The linked request, event and released distribution must agree before reporting.");
  }
}
function optionsFor(requestId, request, eventId, event, distribution) {
  assertReleased(request, event, distribution, requestId, eventId);
  const distributionItems = distribution.items || [];
  const items = (event.seedlingItems || []).map(item => {
    const distributed = distributionItems.find(row => row.inventoryId === item.inventoryId);
    const released = Number(distributed?.releasedQuantity ?? distributed?.quantity);
    if (!Number.isSafeInteger(released) || released !== Number(item.quantity)) throw fail(409, "The release quantities require reconciliation before reporting.");
    return { inventoryId: item.inventoryId, species: item.species || distributed.species || "", quantityReleased: released, availableQuantity: availableForReporting(event, item) };
  });
  return { requestId, eventId, distributionId: requestId, requesterName: request.participantName || "", participantSector: request.workflow?.sector || request.organization || "",
    requestType: request.requestType || request.workflow?.effectiveRequestType || "", expectedVersion: Number(event.officialReportingVersion || 0), siteId: event.plantingSiteId, siteName: event.plantingSiteName || "", eventName: event.name || "", plantingDate: event.date || "", items };
}
async function listReleasedOptions(user, { cursor, requestId } = {}) {
  staff(user);
  if (requestId !== undefined && (!safeId(requestId) || cursor !== undefined)) throw fail(400, "Invalid released-request selection.");
  let query = db.collection("seedlingRequests").where("status", "==", "Released").orderBy("__name__");
  if (cursor !== undefined) {
    if (!safeId(cursor)) throw fail(400, "Invalid released-request cursor.");
    const boundary = await db.collection("seedlingRequests").doc(cursor).get();
    if (!boundary.exists || boundary.data().status !== "Released") throw fail(400, "Invalid released-request cursor.");
    query = query.startAfter(boundary);
  }
  const selected = requestId ? await db.collection("seedlingRequests").doc(requestId).get() : null;
  if (selected && (!selected.exists || selected.data().status !== "Released")) throw fail(404, "Released request not found.");
  const snapshot = selected ? { docs: [selected] } : await query.limit(51).get(), page = snapshot.docs.slice(0, 50);
  const options = [];
  for (const doc of page) {
    const request = doc.data();
    if (!safeId(request.eventId)) continue;
    const [event, distribution] = await Promise.all([db.collection("events").doc(request.eventId).get(), db.collection("distributions").doc(doc.id).get()]);
    if (!event.exists || !distribution.exists) continue;
    try {
      const option = optionsFor(doc.id, request, event.id, event.data(), distribution.data());
      const siteDoc = option.siteId ? await db.collection("sites").doc(option.siteId).get() : null;
      const site = siteDoc?.exists ? siteDoc.data() : {};
      options.push({ ...option, requestNumber: request.requestNumber || doc.id, distributionNumber: distribution.data().distributionNumber || distribution.id,
        siteName: site.siteName || option.siteName, barangay: site.barangay || event.data().barangay || "",
        latitude: Number.isFinite(site.latitude) ? site.latitude : null, longitude: Number.isFinite(site.longitude) ? site.longitude : null,
        coverageRadiusMeters: Number.isFinite(site.coverageRadiusMeters) && site.coverageRadiusMeters > 0 ? site.coverageRadiusMeters : null,
        startTime: event.data().startTime || event.data().time || "", endTime: event.data().endTime || "" });
    }
    catch (error) { if (error.status !== 409) throw error; /* Reconciliation is fail-closed; never invent an allocation. */ }
  }
  return { options, nextCursor: snapshot.docs.length > 50 ? page.at(-1).id : null };
}
async function submitOfficialReport(user, input) {
  staff(user);
  const allowed = new Set(["requestId", "items", "confirmationBasis", "remarks", "clientSubmissionId", "expectedVersion", "correctionOf"]);
  if (!input || Object.keys(input).some(key => !allowed.has(key))) throw fail(400, "Unsupported official report fields.");
  if (!safeId(input.requestId) || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.clientSubmissionId || "")) throw fail(400, "Select an authorized release and use a valid submission identifier.");
  if (!["menro-field-report", "release-based"].includes(input.confirmationBasis)) throw fail(400, "Select a confirmation basis.", { confirmationBasis: "Select a confirmation basis." });
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 10 || new Set(input.items.map(row => row.inventoryId)).size !== input.items.length) throw fail(400, "Select each released species once.", { items: "Select each released species once." });
  for (const row of input.items) if (!safeId(row.inventoryId) || !wholeQuantity(row.leftoverQuantity) ||
      input.confirmationBasis === "menro-field-report" && !wholeQuantity(row.quantityPlanted)) throw fail(400, "Quantities must be nonnegative whole numbers.", { items: "Quantities must be nonnegative whole numbers." });
  if (typeof input.remarks !== "string" || input.remarks.length > 2000) throw fail(400, "Remarks must be at most 2000 characters.", { remarks: "Remarks must be at most 2000 characters." });
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw fail(400, "Refresh the release before reporting.");
  const operationId = digest(`${user.uid}:${input.clientSubmissionId}`);
  const operationRef = db.collection("officialPlantingOperations").doc(operationId);
  const requestRef = db.collection("seedlingRequests").doc(input.requestId);
  const fingerprint = digest(JSON.stringify({ requestId: input.requestId, items: input.items, confirmationBasis: input.confirmationBasis, remarks: input.remarks, expectedVersion: input.expectedVersion, correctionOf: input.correctionOf || "" }));
  let parentId, submissionIds = [];
  await db.runTransaction(async transaction => {
    const [operation, requestDoc, distributionDoc] = await Promise.all([transaction.get(operationRef), transaction.get(requestRef), transaction.get(db.collection("distributions").doc(input.requestId))]);
    if (operation.exists) {
      if (operation.data().fingerprint !== fingerprint || operation.data().staffId !== user.uid) throw fail(409, "This submission key has already been used with different report data.");
      parentId = operation.data().reportId; submissionIds = operation.data().submissionIds; return;
    }
    if (!requestDoc.exists || !distributionDoc.exists) throw fail(404, "Released request not found.");
    const request = requestDoc.data();
    if (!safeId(request.eventId)) throw fail(409, "The request has no linked planting event.");
    const eventRef = db.collection("events").doc(request.eventId);
    const eventDoc = await transaction.get(eventRef);
    if (!eventDoc.exists) throw fail(404, "Planting event not found.");
    const event = eventDoc.data();
    const option = optionsFor(requestDoc.id, request, eventDoc.id, event, distributionDoc.data());
    if (input.confirmationBasis === "release-based" && option.requestType !== "individual") throw fail(400, "Release-based confirmation is available only for an individual requester.", { confirmationBasis: "Organizations require MENRO field reporting." });
    const eventDate = new Date(`${String(event.date).slice(0, 10)}T${event.time || event.startTime || "00:00"}:00+08:00`);
    if (!Number.isFinite(eventDate.getTime()) || eventDate > new Date()) throw fail(409, "Official planting reports cannot be submitted before the linked planting event.");
    if (Number(event.officialReportingVersion || 0) !== input.expectedVersion) throw fail(409, "The reportable balance changed. Refresh before submitting.");
    parentId = `event_${eventDoc.id}`;
    const parentRef = db.collection("plantingReports").doc(parentId);
    const parentDoc = await transaction.get(parentRef);
    if (!parentDoc.exists || parentDoc.data().reportType !== "parent" || parentDoc.data().requestId !== requestDoc.id || parentDoc.data().reportingProgress === "Completed") throw fail(409, "This release requires reconciliation or is already fully verified.");
    const parent = parentDoc.data();
    let correctionRef, correction;
    if (input.correctionOf) {
      if (!safeId(input.correctionOf)) throw fail(400, "Invalid correction reference.");
      correctionRef = db.collection("plantingContributions").doc(input.correctionOf);
      const prior = await transaction.get(correctionRef); correction = prior.data();
      if (!prior.exists || correction.reportId !== parentId || correction.authenticatedSubmitterUid !== user.uid || correction.staffReviewStatus !== "Rejected" || correction.correctedBySubmission || input.items.length !== 1 || input.items[0].inventoryId !== correction.inventoryId) throw fail(409, "This submission cannot be corrected.");
    }
    const recorded = { ...(event.recordedSeedlingsByInventory || {}) }, leftovers = { ...(event.leftoverSeedlingsByInventory || {}) };
    const rows = input.items.map((row, index) => {
      const item = option.items.find(item => item.inventoryId === row.inventoryId);
      if (!item) throw fail(400, "Select only species from the authoritative release.", { items: "Select only species from the authoritative release." });
      const leftoverQuantity = Number(row.leftoverQuantity);
      const quantity = input.confirmationBasis === "release-based" ? item.availableQuantity - leftoverQuantity : Number(row.quantityPlanted);
      if (quantity < 0 || quantity + leftoverQuantity > item.availableQuantity) throw fail(409, "Planted and leftover quantities exceed the available reportable balance.", { items: "Refresh the release and enter quantities within its available balance." });
      recorded[row.inventoryId] = Number(recorded[row.inventoryId] || 0) + quantity;
      leftovers[row.inventoryId] = Number(leftovers[row.inventoryId] || 0) + leftoverQuantity;
      return { id: `${operationId}_${index}`, inventoryId: row.inventoryId, species: item.species, quantity, leftoverQuantity, releasedQuantity: item.quantityReleased };
    }).filter(row => row.quantity + row.leftoverQuantity > 0);
    const planted = rows.reduce((sum, row) => sum + row.quantity, 0), leftover = rows.reduce((sum, row) => sum + row.leftoverQuantity, 0);
    submissionIds = rows.map(row => row.id);
    if (planted + leftover <= 0) throw fail(400, "Report a planted or leftover quantity.", { items: "Report a planted or leftover quantity." });
    const now = Timestamp.now();
    const active = Number(parent.activeSubmittedQuantity || 0) + planted, declaredLeftovers = Number(parent.declaredLeftoverQuantity || 0) + leftover;
    const pending = Number(parent.pendingReviewQuantity || 0) + planted, pendingLeftovers = Number(parent.pendingReviewLeftoverQuantity || 0) + leftover;
    const progress = progressFor({ released: parent.quantityReleased, active, accepted: Number(parent.acceptedQuantity || 0), pending, leftovers: declaredLeftovers, acceptedLeftovers: Number(parent.acceptedLeftoverQuantity || 0), pendingLeftovers });
    for (const row of rows) {
      const { id, ...values } = row;
      transaction.create(db.collection("plantingContributions").doc(id), { ...values, reportId: parentId, eventId: eventDoc.id, requestId: requestDoc.id,
        officialStaffReport: true, officialOperationId: operationId, adminApprovalRequired: true, staffApprovalRequired: true, submissionWorkflowVersion: 3,
        confirmationBasis: input.confirmationBasis, participantId: request.participantId, contributorId: user.uid,
        contributorName: user.fullName || user.name || "MENRO Staff", authenticatedSubmitterUid: user.uid, submittedByName: user.fullName || user.name || "MENRO Staff", submittedByType: "MENRO Staff",
        requesterName: option.requesterName, participantSector: option.participantSector, siteId: event.plantingSiteId,
        plantingDate: event.date, verificationStatus: "Needs Review", staffReviewStatus: "Pending Review", photos: [], remarks: input.remarks.trim(),
        ...(correction ? { correctionOf: correctionRef.id, revision: Number(correction.revision || 0) + 1 } : { revision: 0 }), createdAt: now, updatedAt: now });
    }
    if (correctionRef) transaction.update(correctionRef, { correctedBySubmission: rows[0].id });
    transaction.update(eventRef, { recordedSeedlingsByInventory: recorded, leftoverSeedlingsByInventory: leftovers,
      recordedSeedlingQuantity: Number(event.recordedSeedlingQuantity || 0) + planted, leftoverSeedlingQuantity: Number(event.leftoverSeedlingQuantity || 0) + leftover,
      remainingSeedlingQuantity: Math.max(0, event.seedlingItems.reduce((sum, item) => sum + availableForReporting(event, item), 0) - planted - leftover),
      officialReportingVersion: input.expectedVersion + 1, updatedAt: now });
    transaction.update(parentRef, { officialPlantingWorkflow: true, quantityPlanted: active, activeSubmittedQuantity: active, pendingReviewQuantity: pending, declaredLeftoverQuantity: declaredLeftovers,
      pendingReviewLeftoverQuantity: pendingLeftovers, remainingAvailableQuantity: Math.max(0, Number(parent.quantityReleased) - active - declaredLeftovers), reportingProgress: progress, verificationStatus: progress, submittedAt: now, updatedAt: now,
      ...(!parent.earlyMonitoringOriginalSubmittedAt && activationState().enabled ? { earlyMonitoringOriginalSubmittedAt: now } : {}) });
    transaction.create(operationRef, { staffId: user.uid, requestId: requestDoc.id, eventId: eventDoc.id, reportId: parentId, fingerprint, submissionIds: rows.map(row => row.id), createdAt: now });
  });
  const parent = await db.collection("plantingReports").doc(parentId).get();
  return { ...await reportDetails(parentId, parent.data()), officialSubmissionIds: submissionIds };
}
async function reviewOfficialSubmission(user, id, approve, reason = "") {
  if (!user?.uid || String(user.role).toLowerCase() !== "admin") throw fail(user?.uid ? 403 : 401, "Only MENRO Admin may verify an official Staff planting report.");
  if (!approve && !String(reason).trim()) throw fail(400, "A correction reason is required.");
  const ref = db.collection("plantingContributions").doc(id);
  let parentId;
  await db.runTransaction(async transaction => {
    const doc = await transaction.get(ref);
    if (!doc.exists || doc.data().officialStaffReport !== true) throw fail(404, "Official submission not found.");
    const current = doc.data(); parentId = current.reportId;
    if (current.staffReviewStatus !== "Pending Review") throw fail(409, "Only pending official submissions can be decided.");
    if (approve && current.confirmationBasis === "menro-field-report") {
      const operation = await transaction.get(db.collection("officialPlantingOperations").doc(current.officialOperationId));
      const evidenceId = operation.data()?.evidenceSubmissionId;
      const evidence = evidenceId ? await transaction.get(db.collection("plantingContributions").doc(evidenceId)) : null;
      const photos = evidence?.data()?.photos;
      if (!operation.exists || operation.data().evidenceVerified !== true || Number(operation.data().evidenceRevision) !== Number(current.revision || 0) ||
          !evidence?.exists || evidence.data().officialOperationId !== current.officialOperationId || evidence.data().authenticatedSubmitterUid !== current.authenticatedSubmitterUid ||
          !photos?.length || photos.some(photo => !photo.privateEvidence || !photo.gpsValid || !photo.siteGpsValid || !photo.timestampValid)) {
        throw fail(409, "Verified private planting photos are required before approving a MENRO Field Report.");
      }
    }
    const parentRef = db.collection("plantingReports").doc(parentId), eventRef = db.collection("events").doc(current.eventId);
    const [parentDoc, eventDoc] = await Promise.all([transaction.get(parentRef), transaction.get(eventRef)]);
    if (!parentDoc.exists || !eventDoc.exists || parentDoc.data().requestId !== current.requestId || eventDoc.data().sourceRequestId !== current.requestId) throw fail(409, "Official report relationships require reconciliation.");
    const parent = parentDoc.data(), event = eventDoc.data(), quantity = Number(current.quantity), leftover = Number(current.leftoverQuantity || 0);
    if (!wholeQuantity(quantity) || !wholeQuantity(leftover) || Number(parent.pendingReviewQuantity || 0) < quantity || Number(parent.pendingReviewLeftoverQuantity || 0) < leftover) throw fail(409, "Official report balances require reconciliation.");
    const active = Number(parent.activeSubmittedQuantity || 0) - (approve ? 0 : quantity), declaredLeftovers = Number(parent.declaredLeftoverQuantity || 0) - (approve ? 0 : leftover);
    const accepted = Number(parent.acceptedQuantity || 0) + (approve ? quantity : 0), acceptedLeftovers = Number(parent.acceptedLeftoverQuantity || 0) + (approve ? leftover : 0);
    const pending = Number(parent.pendingReviewQuantity || 0) - quantity, pendingLeftovers = Number(parent.pendingReviewLeftoverQuantity || 0) - leftover;
    const progress = progressFor({ released: Number(parent.quantityReleased), active, accepted, pending, leftovers: declaredLeftovers, acceptedLeftovers, pendingLeftovers });
    const submissionSnapshot = await transaction.get(db.collection("plantingContributions").where("reportId", "==", parentId));
    const acceptedByInventory = {}, confirmationBases = new Set();
    for (const row of submissionSnapshot.docs) {
      const data = normalizeSubmission(row.data());
      if ((data.officialStaffReport === true || data.photos?.length) && data.verificationStatus !== "Invalid" &&
          (approve && row.id === id || data.staffReviewStatus === "Accepted" || data.staffApprovalRequired !== true && data.verificationStatus === "Verified" && data.staffReviewStatus === "Not Required")) {
        acceptedByInventory[data.inventoryId] = Number(acceptedByInventory[data.inventoryId] || 0) + Number(data.quantity || 0);
        confirmationBases.add(data.confirmationBasis || "documented-participant-report");
      }
    }
    if (Object.values(acceptedByInventory).reduce((sum, value) => sum + value, 0) !== accepted) throw fail(409, "Confirmed planted quantities require reconciliation before monitoring.");
    const now = Timestamp.now();
    const earlyMonitoring = progress === "Completed" && accepted > 0 && !parent.earlyMonitoring ? buildEarlyMonitoringPolicy({ originalSubmittedAt: parent.earlyMonitoringOriginalSubmittedAt || parent.createdAt || now,
      verifiedAt: now, officialOpeningDate: shiftCalendarDate(String(parent.plantingDate || parent.eventDate || event.date || ""), 14) }) : null;
    const nextParent = { ...parent, quantityPlanted: active, activeSubmittedQuantity: active, acceptedQuantity: accepted,
      acceptedSeedlingsByInventory: acceptedByInventory, confirmationBases: [...confirmationBases].sort(), pendingReviewQuantity: pending, declaredLeftoverQuantity: declaredLeftovers, acceptedLeftoverQuantity: acceptedLeftovers,
      pendingReviewLeftoverQuantity: pendingLeftovers, remainingAvailableQuantity: Math.max(0, Number(parent.quantityReleased) - active - declaredLeftovers), reportingProgress: progress, verificationStatus: progress, updatedAt: now,
      ...(earlyMonitoring ? { earlyMonitoring, earlyMonitoringVerifiedAt: now } : {}) };
    // Cohort reads must finish before any writes; immutable cohorts are never rewritten.
    if (approve) await require("./verifiedPlantingCohort.service").ensureCohortForAuthoritativeReportInTransaction(transaction, { reportId: parentId, report: nextParent, now });
    if (!approve) {
      const recorded = { ...(event.recordedSeedlingsByInventory || {}) }, leftovers = { ...(event.leftoverSeedlingsByInventory || {}) };
      if (Number(recorded[current.inventoryId] || 0) < quantity || Number(leftovers[current.inventoryId] || 0) < leftover) throw fail(409, "Official report ledger requires reconciliation.");
      recorded[current.inventoryId] -= quantity; leftovers[current.inventoryId] -= leftover;
      transaction.update(eventRef, { recordedSeedlingsByInventory: recorded, leftoverSeedlingsByInventory: leftovers,
        recordedSeedlingQuantity: Number(event.recordedSeedlingQuantity || 0) - quantity, leftoverSeedlingQuantity: Number(event.leftoverSeedlingQuantity || 0) - leftover,
        remainingSeedlingQuantity: event.seedlingItems.reduce((sum, item) => sum + availableForReporting(event, item), 0) + quantity + leftover,
        officialReportingVersion: Number(event.officialReportingVersion || 0) + 1, updatedAt: now });
    }
    transaction.update(parentRef, nextParent);
    transaction.update(ref, { staffReviewStatus: approve ? "Accepted" : "Rejected", reviewedBy: user.uid, reviewedByName: user.fullName || user.name || "MENRO Admin", reviewedAt: now,
      reviewRemarks: String(reason).trim(), ...(approve ? {} : { rejectionReason: String(reason).trim() }), updatedAt: now });
    require("./verificationLog.service").createVerificationLogInTransaction(transaction, { plantingReportId: parentId, submissionId: id, action: approve ? "Admin Official Planting Verification" : "Admin Official Planting Correction Required",
      previousStatus: "Pending Review", newStatus: approve ? "Accepted" : "Rejected", performedBy: user.uid, performedByRole: "admin", remarks: String(reason).trim(), createdAt: now });
    require("./notification.service").createNotificationInTransaction(transaction, { notificationId: `official_planting_${id}_${approve ? "accepted" : "correction"}`, recipientUserId: current.authenticatedSubmitterUid,
      type: approve ? "planting_report_accepted" : "planting_report_rejected", title: approve ? "Official Planting Report Verified" : "Official Planting Report Needs Correction",
      message: approve ? "MENRO Admin verified the official planting submission." : "MENRO Admin returned the official planting submission for correction. Review the decision reason.",
      relatedRecordType: "plantingReport", relatedRecordId: parentId, relatedSubrecordId: id, createdAt: now });
  });
  const parent = await db.collection("plantingReports").doc(parentId).get();
  return reportDetails(parentId, parent.data());
}
module.exports = { listReleasedOptions, submitOfficialReport, reviewOfficialSubmission };
