const { createHash, randomUUID } = require("node:crypto");
const { assessmentFingerprint } = require("./sampleMonitoringOriginalEvidence");
// Separate original-photo verification; never creates or impersonates camera sessions.
const exifr = require("exifr");
const images = require("../utils/imageVerification.util");
const { extractGpsCoordinates } = require("../utils/exifGps.util");
const { dateOnlyInManila } = require("../utils/earlyMonitoring.util");
const validation = require("./sampleMonitoringValidation");
const release = require("../config/permanentSampleRelease");
const { requireOriginalProposal } = require("../config/sampleMonitoringOriginalProposal");
const { resolveVerifiedPlantingCohortConfig } = require("../config/verifiedPlantingCohort");
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
function parseOriginalTimestamp(raw, offset, monitoredDate, now = new Date()) {
  if (raw == null || raw === "") throw fail(422, "ORIGINAL_TIMESTAMP_MISSING", "The original photo must contain DateTimeOriginal capture metadata.");
  const parts = typeof raw === "string" && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!parts) throw fail(422, "ORIGINAL_TIMESTAMP_INVALID", "The original capture timestamp cannot be interpreted reliably.");
  const [year,month,day,hour,minute,second] = parts.slice(1).map(Number);
  const local = new Date(Date.UTC(year,month-1,day,hour,minute,second));
  if (year < 1900 || [local.getUTCFullYear(),local.getUTCMonth()+1,local.getUTCDate(),local.getUTCHours(),local.getUTCMinutes(),local.getUTCSeconds()].some((v,i)=>v!==[year,month,day,hour,minute,second][i])) {
    throw fail(422,"ORIGINAL_TIMESTAMP_INVALID","The original capture timestamp is not a valid calendar time.");
  }
  const zone = typeof offset === "string" && /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
  if (!zone || Number(zone[2])>14 || Number(zone[3])>59 || Number(zone[2])===14 && Number(zone[3])!==0 || offset.trim()==="-00:00") {
    throw fail(422,"ORIGINAL_TIMEZONE_REQUIRED","An unambiguous original EXIF timezone offset is required; timezone-naive photo times are not accepted by this proposal.");
  }
  const minutes = (Number(zone[2])*60+Number(zone[3]))*(zone[1]==="-"?-1:1);
  const instant = new Date(local.getTime()-minutes*60000);
  if (instant > now) throw fail(422,"ORIGINAL_TIMESTAMP_FUTURE","The original photo capture timestamp cannot be in the future.");
  if (dateOnlyInManila(instant)!==monitoredDate) throw fail(422,"ORIGINAL_MONITORING_DATE_MISMATCH","The photo capture date in Asia/Manila must match the saved Date Monitored.");
  return instant;
}
function reportedAccuracy(metadata) {
  const value = metadata.GPSHPositioningError;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
async function inspectOriginal(file, context, now = new Date()) {
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length===0 || file.buffer.length>10*1024*1024) throw fail(400,"ORIGINAL_FILE_INVALID","Provide one original photo within the 10 MB limit.");
  let details;
  try { details=await images.validateImageBuffer(file.buffer); }
  catch { throw fail(422,"ORIGINAL_FORMAT_UNSUPPORTED","The original image bytes are invalid or unsupported."); }
  if (details.format!=="jpeg") throw fail(422,"ORIGINAL_FORMAT_UNSUPPORTED","Only original JPEG EXIF diagnostics are currently supported; renamed, converted and HEIC files are not assumed compatible.");
  let metadata;
  try { metadata=await exifr.parse(file.buffer,{gps:true,tiff:true,exif:true,reviveValues:false}); }
  catch { throw fail(422,"ORIGINAL_METADATA_UNREADABLE","The original embedded metadata could not be read."); }
  metadata=metadata||{};
  if (images.isClearlyScreenshot({fileName:file.originalname,metadata:{software:metadata.Software,deviceMake:metadata.Make,deviceModel:metadata.Model}})) throw fail(422,"ORIGINAL_METADATA_SUSPICIOUS","A detectable screenshot is not accepted as an original field photo.");
  const gps=extractGpsCoordinates(metadata);
  if (gps.status!=="valid" || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude)) throw fail(422,"ORIGINAL_GPS_INVALID","Valid embedded original-photo GPS latitude and longitude are required; device location cannot replace them.");
  const captured = parseOriginalTimestamp(metadata.DateTimeOriginal,metadata.OffsetTimeOriginal,context.dateMonitored,now);
  let location;
  try {
    location = require("./evidenceCaptureSession.service").validateSiteLocation(context.site,{latitude:gps.latitude,longitude:gps.longitude});
  } catch (error) {
    const codes={CAPTURE_LOCATION_OUTSIDE_SITE:"ORIGINAL_OUTSIDE_SITE",CAPTURE_LOCATION_OUTSIDE_BULAN:"ORIGINAL_OUTSIDE_BULAN",CAPTURE_SITE_GEOMETRY_UNAVAILABLE:"ORIGINAL_SITE_UNAVAILABLE"};
    throw fail(error.status||422,codes[error.code]||"ORIGINAL_LOCATION_INVALID",error.message.replaceAll("Camera evidence", "Original photo"));
  }
  // EXIF claims are editable: neither coordinates nor a claimed accuracy prove authenticity.
  return { source: "uploaded-original", capturedAt: captured.toISOString(), captureOffset: metadata.OffsetTimeOriginal,
    captureDateManila: context.dateMonitored, location: { ...location, accuracyMeters: null }, accuracyStatus: "UNKNOWN",
    reportedAccuracyMeters: reportedAccuracy(metadata), verificationStatus: "NEEDS_ADMIN_REVIEW", reviewRequired: true };
}
function integer(value, label) {
  if (!/^(0|[1-9]\d*)$/.test(String(value??""))) throw fail(400,"ORIGINAL_BINDING_INVALID",`${label} must be a nonnegative integer.`);
  const n=Number(value);validation.version(n);return n;
}
async function verifyOriginal({actorId,actorRole,visitId,sampleId,input={},files=[],idempotencyKey}) {
  requireOriginalProposal();
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw fail(409,"COHORT_WORKFLOW_DISABLED","Verified planting cohort workflow is disabled.");
  if (!actorId || actorRole!=="staff") throw fail(actorId?403:401,"ORIGINAL_FORBIDDEN","Authenticated MENRO Staff access is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(visitId||"") || !/^[A-Za-z0-9_-]{3,80}$/.test(sampleId||"")) throw fail(404,"ORIGINAL_TARGET_UNAVAILABLE","The monitoring target is unavailable.");
  if (input.reuseEvidence!==undefined || input.evidenceId!==undefined || input.evidenceIndex!==undefined) throw fail(409,"ORIGINAL_REUSE_UNSUPPORTED","Direct historical relinking is not supported. Unchanged relevant evidence remains attached to its original Tree ID.");
  if (input.source!=="uploaded-original") throw fail(400,"ORIGINAL_SOURCE_REQUIRED","This pathway is only for explicitly classified uploaded-original files.");
  if (Object.keys(input).some(key=>!["source","expectedVisitVersion","assessmentRevision"].includes(key))) throw fail(400,"ORIGINAL_CLIENT_METADATA_FORBIDDEN","Client-declared coordinates, dates, accuracy and evidence references cannot replace original embedded metadata.");
  const expectedVersion=integer(input.expectedVisitVersion,"expectedVisitVersion"),revision=integer(input.assessmentRevision,"assessmentRevision");
  release.assertUser(actorId);release.assertWrite();
  const db=require("../config/firebase").db,doc=await db.collection("sampleMonitoringVisits").doc(visitId).get(),visit=doc.data();
  if (!doc.exists || visit.createdBy!==actorId) throw fail(404,"ORIGINAL_TARGET_UNAVAILABLE","The monitoring target is unavailable.");
  release.writeScope(actorId,visit.cohortId);
  const row=visit.sampleAssessments?.find(a=>a.sampleId===sampleId);
  if (!row) throw fail(404,"ORIGINAL_TARGET_UNAVAILABLE","The permanent Tree ID is not part of this visit.");
  if (!["DRAFT","RETURNED"].includes(visit.status) || visit.version!==expectedVersion || Number(row.assessmentRevision||0)!==revision) throw fail(409,"ORIGINAL_BINDING_STALE","The visit status, version or tree revision changed. Refresh the authoritative visit.");
  const [cohortDoc,siteDoc]=await Promise.all([db.collection("verifiedPlantingCohorts").doc(visit.cohortId).get(),db.collection("sites").doc(visit.siteId).get()]);
  const cohort=cohortDoc.data();validation.cohortBinding(cohort,visit);
  if (!siteDoc.exists || !cohort?.baseline?.sampleUnits?.some(u=>u.permanentId===sampleId)) throw fail(409,"ORIGINAL_BINDING_STALE","The approved site or permanent sample registration changed.");
  if (String(siteDoc.data().status||"").toLowerCase()==="inactive") throw fail(422,"ORIGINAL_SITE_INACTIVE","The assigned planting site is inactive.");
  const date=visit.dateMonitored;
  if (typeof date!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || date>dateOnlyInManila()) throw fail(409,"ORIGINAL_MONITORING_DATE_REQUIRED","Save a valid actual Date Monitored before verifying an original photo.");
  if (!Array.isArray(files) || files.length!==1) throw fail(400,"ORIGINAL_FILE_INVALID","Select exactly one original photo for this Tree ID.");
  if (!Buffer.isBuffer(files[0]?.buffer) || files[0].buffer.length>10*1024*1024) throw fail(400,"ORIGINAL_FILE_INVALID","Provide one original photo within the 10 MB limit.");
  const sha256=images.generateImageHash(files[0].buffer);
  const duplicates=await Promise.all(["sampleMonitoringEvidenceHashes","baselineEvidenceHashes","plantingEvidenceHashes","monitoringEvidenceHashes"].map(name=>db.collection(name).doc(sha256).get()));
  if (duplicates.some(d=>d.exists)) throw fail(409,"ORIGINAL_DUPLICATE","This image is already registered as evidence. Duplicate files cannot be linked to another tree or revision.");
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey)) throw fail(400,"ORIGINAL_IDEMPOTENCY_REQUIRED","A stable original verification request key is required.");
  const metadata = await inspectOriginal(files[0],{site:siteDoc.data(),dateMonitored:date});
  const binding = { actorId, visitId, sampleId, cohortId: visit.cohortId, siteId: visit.siteId,
    samplingPlanVersion: visit.samplingPlanVersion, baselineVersion: visit.baselineVersion,
    visitVersion: expectedVersion, assessmentRevision: revision, dateMonitored: date,
    assessmentFingerprint: assessmentFingerprint(row, date) };
  const fingerprint = createHash("sha256").update(JSON.stringify([binding,sha256])).digest("hex");
  const proofRef = db.collection("sampleMonitoringOriginalVerifications").doc("VMOV-"+createHash("sha256").update(actorId+"\0"+idempotencyKey).digest("hex"));
  const proof = await db.runTransaction(async tx => {
    const [old, current, currentCohort, currentSite] = await Promise.all([tx.get(proofRef), tx.get(db.collection("sampleMonitoringVisits").doc(visitId)), tx.get(db.collection("verifiedPlantingCohorts").doc(visit.cohortId)), tx.get(db.collection("sites").doc(visit.siteId))]);
    const v=current.data(), a=v?.sampleAssessments?.find(item=>item.sampleId===sampleId);
    if (!v || v.createdBy!==actorId || v.cohortId!==visit.cohortId || v.siteId!==visit.siteId || !["DRAFT","RETURNED"].includes(v.status) || v.version!==expectedVersion || Number(a?.assessmentRevision||0)!==revision || !a || assessmentFingerprint(a,v.dateMonitored)!==binding.assessmentFingerprint || JSON.stringify(currentSite.data())!==JSON.stringify(siteDoc.data())) throw fail(409,"ORIGINAL_BINDING_STALE","The original-photo target changed. Refresh and verify again.");
    validation.cohortBinding(currentCohort.data(),v);
    if(old.exists) { const existing=old.data(); if(existing.fingerprint!==fingerprint || existing.state!=="VERIFIED" || existing.expiresAt<=Date.now()) throw fail(409,"ORIGINAL_VERIFICATION_CONFLICT","This verification request changed, expired or was already used."); return existing; }
    const value={...binding,...metadata,sha256,fingerprint,evidenceId:"VOE-"+randomUUID(),state:"VERIFIED",issuedAt:Date.now(),expiresAt:Date.now()+5*60*1000,policyStatus:"PROPOSED_PENDING_MENRO_APPROVAL"};
    release.writeScope(actorId,visit.cohortId);tx.create(proofRef,value);return value;
  });
  return { originalVerificationId: proofRef.id, evidenceId: proof.evidenceId, source: proof.source, location: proof.location,
    capturedAt: proof.capturedAt, accuracyStatus: proof.accuracyStatus, verificationStatus: proof.verificationStatus, reviewRequired: true,
    policyStatus: proof.policyStatus, linkingEnabled: true };
}
async function resolveOriginal({actorId,visit,sampleId,assessmentRevision,expectedVisitVersion,file,descriptor}) {
  requireOriginalProposal();
  if(descriptor?.source!=="uploaded-original" || !/^VMOV-[a-f0-9]{64}$/.test(descriptor.originalVerificationId||"")) throw fail(409,"ORIGINAL_VERIFICATION_REQUIRED","Verify this original photo before private upload.");
  const ref=require("../config/firebase").db.collection("sampleMonitoringOriginalVerifications").doc(descriptor.originalVerificationId),doc=await ref.get(),p=doc.data();
  const a=visit.sampleAssessments?.find(row=>row.sampleId===sampleId);
  if(!p || p.state!=="VERIFIED" || p.actorId!==actorId || p.visitId!==visit.id || p.sampleId!==sampleId || p.cohortId!==visit.cohortId || p.siteId!==visit.siteId || p.visitVersion!==expectedVisitVersion || p.assessmentRevision!==assessmentRevision || p.samplingPlanVersion!==visit.samplingPlanVersion || p.baselineVersion!==visit.baselineVersion || !a || p.assessmentFingerprint!==assessmentFingerprint(a,visit.dateMonitored) || p.sha256!==images.generateImageHash(file.buffer)) throw fail(409,"ORIGINAL_BINDING_STALE","The verified original no longer matches this file, visit or assessment. Refresh and verify again.");
  if(p.expiresAt<=Date.now()) throw fail(410,"ORIGINAL_VERIFICATION_EXPIRED","Original verification expired. Verify the unchanged photo again with a new request key.");
  return {id:doc.id,...p};
}
async function prepareOriginalConsumption(tx,proof) {
  const ref=require("../config/firebase").db.collection("sampleMonitoringOriginalVerifications").doc(proof.id),doc=await tx.get(ref),p=doc.data();
  if(!p || p.state!=="VERIFIED" || p.fingerprint!==proof.fingerprint || p.expiresAt<=Date.now()) throw fail(409,"ORIGINAL_VERIFICATION_CONFLICT","Original verification changed or was consumed.");
  return ()=>tx.update(ref,{state:"CONSUMED",consumedAt:Date.now()});
}
module.exports={verifyOriginal,resolveOriginal,prepareOriginalConsumption,_test:{parseOriginalTimestamp,reportedAccuracy,inspectOriginal}};
