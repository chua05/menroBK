// Historical permanent-sample cohort recovery: finds Admin-verified planting reports that were eligible but never got
// their cohort (for example, verified while the workflow was off). Firestore is injected and this module never loads
// src/config/firebase.js, so a credential-free dry run and the emulator execution apply the same rules.
//
// - planRecovery: one Firestore read-only transaction over an explicit 1-20 report list. Output is limited to report
//   number, decision, reasons, quantity and expected cohort ID. The digest covers the decisions and every stored field
//   that a decision or the future cohort document depends on.
// - executeRecovery: only for the digest the operator reviewed. One transaction per report re-reads and re-decides;
//   only ELIGIBLE_MISSING_COHORT proceeds, through the existing provisioning function (its flag, pause and pilot gates
//   stay in force). Nothing but that one cohort document can be written, and no report policy is ever converted.
const crypto = require("node:crypto");
const { authoritativeQuantity, cohortIdFor, documentReference, isAuthoritativelyVerified, normalizedSpecies, permanentSamplePolicy } = require("./verifiedPlantingCohortEligibility");
const { sanitizeError } = require("./monitoringLifecycleTargetedRegistration.service");

const COHORTS = "verifiedPlantingCohorts";
const REPORT_ID = /^(?!__.*__$)[A-Za-z0-9_-]{1,200}$/; // Firestore reserves __*__ document IDs
const MAX_REPORTS = 20;
const ELIGIBLE = "ELIGIBLE_MISSING_COHORT";
// Everything the decision or ensureCohortForAuthoritativeReportInTransaction reads; no names, photos or coordinates.
const REPORT_FIELDS = Object.freeze(["reportNumber", "reportType", "reportingProgress", "verificationStatus", "acceptedQuantity", "quantityPlanted", "archived",
  "eventId", "siteId", "requestId", "distributionId", "species", "inventoryId", "plantingDate", "eventDate", "officialPlantingWorkflow", "acceptedSeedlingsByInventory",
  "confirmationBases", "reportingPolicy.monitoring", "reportingPolicy.definition.monitoring", "reportingPolicy.policyStatus", "reportingPolicy.sampling",
  "reportingPolicy.policyVersion", "reportingPolicy.approvedBy"]);
const EVENT_FIELDS = Object.freeze(["plantingSiteId", "sourceRequestId", "seedlingItems", "date"]);
const SITE_FIELDS = Object.freeze(["status"]);

class RecoveryStop extends Error {
  constructor(step, message, details = {}) { super(`[${step}] ${message}`); this.step = step; this.details = details; }
}

function assertReportIds(reportIds) {
  if (!Array.isArray(reportIds) || reportIds.length < 1 || reportIds.length > MAX_REPORTS ||
      reportIds.some(id => typeof id !== "string" || !REPORT_ID.test(id)) || new Set(reportIds).size !== reportIds.length) {
    throw new RecoveryStop("reports", `An explicit list of 1-${MAX_REPORTS} distinct planting report IDs is required.`);
  }
}

const text = value => String(value || "").trim();
const pick = (data, fields) => (data ? fields.map(field => [field, field.split(".").reduce((node, key) => node?.[key], data)]) : null);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.keys(value).sort().map(key => [key, canonical(value[key])]);
  return value === undefined ? null : value;
}
const hash = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

// All reads for one report. With projected:true only the listed fields are requested (the dry run).
async function gather(tx, db, reportId, { projected }) {
  const read = async (collection, id, fieldMask) => {
    const ref = db.collection(collection).doc(id);
    const snap = projected ? (await tx.getAll(ref, { fieldMask: [...fieldMask] }))[0] : await tx.get(ref);
    return snap.exists ? snap.data() || {} : null;
  };
  const expectedCohortId = cohortIdFor(reportId);
  const report = await read("plantingReports", reportId, REPORT_FIELDS);
  const eventId = documentReference(report?.eventId), event = eventId ? await read("events", eventId, EVENT_FIELDS) : null;
  const reportSite = documentReference(report?.siteId), eventSite = documentReference(event?.plantingSiteId), siteId = reportSite || eventSite || "";
  const site = siteId ? await read("sites", siteId, SITE_FIELDS) : null;
  const cohort = await read(COHORTS, expectedCohortId, ["source.plantingReportId"]);
  const claims = await tx.get(db.collection(COHORTS).where("source.plantingReportId", "==", reportId).select("source.plantingReportId").limit(3));
  return { reportId, expectedCohortId, report, event, site, siteId, reportSite, eventSite, invalidReference: [eventId, reportSite, eventSite].includes(null),
    cohort, claimedElsewhere: claims.docs.some(doc => doc.id !== expectedCohortId) };
}

function policyDecision(report) {
  const rule = permanentSamplePolicy(report);
  if (rule.code === "POLICY_CONFLICT") return "CONFLICTING_POLICY";
  // Stricter than automatic provisioning: a report without a stored, resolved policy is never recovered without MENRO.
  if (!report.reportingPolicy) return "REQUIRES_MENRO_APPROVAL";
  if (rule.allowed) return null;
  return ["STAFF_SPOT_CHECK", "NONE"].includes(rule.method) ? "INCOMPATIBLE_POLICY" : "REQUIRES_MENRO_APPROVAL";
}

function decide(facts) {
  const { report, event, site, cohort } = facts;
  const reasons = [], notes = [];
  if (!report) return { decision: "REPORT_NOT_FOUND", reasons: ["REPORT_NOT_FOUND"], notes, quantity: 0 };
  const quantity = authoritativeQuantity(report);
  const ownCohort = cohort?.source?.plantingReportId === facts.reportId;
  if (facts.claimedElsewhere || (cohort && !ownCohort)) reasons.push("COHORT_IDENTITY_CONFLICT");
  else if (ownCohort) reasons.push("ALREADY_PROVISIONED");
  if (report.archived === true) reasons.push("REPORT_ARCHIVED");
  if (!isAuthoritativelyVerified(report)) reasons.push("UNVERIFIED_REPORT");
  else if (!quantity) reasons.push("MISSING_AUTHORITATIVE_QUANTITY");
  const policy = policyDecision(report);
  if (policy) reasons.push(policy);
  if (facts.invalidReference || !site || text(site.status).toLowerCase() === "inactive" ||
      (facts.reportSite && facts.eventSite && facts.reportSite !== facts.eventSite)) reasons.push("INVALID_SITE");
  const rows = normalizedSpecies(event || {}, report);
  const planted = rows.filter(row => Number(row.verifiedPlantedQuantity ?? row.releasedQuantity) > 0);
  if (new Set((planted.length ? planted : rows).map(row => row.species).filter(Boolean)).size > 1) notes.push("MULTI_SPECIES");
  if (!text(report.plantingDate || report.eventDate || event?.date)) notes.push("MISSING_PLANTING_DATE");
  return { decision: reasons[0] || ELIGIBLE, reasons, notes, quantity };
}

const fingerprint = facts => hash([pick(facts.report, REPORT_FIELDS), pick(facts.event, EVENT_FIELDS), facts.siteId, pick(facts.site, SITE_FIELDS)]);
const publicRow = (facts, outcome) => ({ reportId: facts.reportId, reportNumber: typeof facts.report?.reportNumber === "string" ? facts.report.reportNumber : null,
  decision: outcome.decision, reasons: outcome.reasons, quantity: outcome.quantity, expectedCohortId: facts.expectedCohortId, notes: outcome.notes });

async function review({ db, reportIds }) {
  assertReportIds(reportIds);
  return db.runTransaction(async tx => {
    const rows = [];
    for (const reportId of reportIds) {
      const facts = await gather(tx, db, reportId, { projected: true });
      rows.push({ row: publicRow(facts, decide(facts)), fingerprint: fingerprint(facts) });
    }
    const digest = hash([db.projectId || null, rows.map(({ row, fingerprint: value }) => [row, value])]).slice(0, 16);
    return { rows, digest };
  }, { readOnly: true });
}

async function planRecovery({ db, reportIds }) {
  const { rows, digest } = await review({ db, reportIds });
  return { readOnly: true, projectId: db.projectId || null, digest, reports: rows.map(({ row }) => row) };
}

// The provisioning function only needs reads and one create; any other write is refused before it is buffered.
function cohortOnly(tx, expectedCohortId) {
  const refuse = () => { throw new RecoveryStop("transaction", "Recovery may only create the expected cohort document."); };
  return { get: (...args) => tx.get(...args), set: refuse, update: refuse, delete: refuse,
    create: (ref, data) => (ref?.path === `${COHORTS}/${expectedCohortId}` ? tx.create(ref, data) : refuse()) };
}

async function recoverOne({ db, ensure, reviewed }) {
  const { reportId, expectedCohortId } = reviewed.row;
  return db.runTransaction(async tx => {
    const facts = await gather(tx, db, reportId, { projected: false });
    if (fingerprint(facts) !== reviewed.fingerprint) return "REPORT_CHANGED";
    const { decision } = decide(facts);
    if (decision !== ELIGIBLE) return decision;
    const cohort = await ensure(cohortOnly(tx, expectedCohortId), { reportId, report: facts.report });
    if (!cohort) return "PROVISIONING_GATED";
    if (cohort.id !== expectedCohortId) throw new RecoveryStop("transaction", "Provisioning returned an unexpected cohort.");
    return cohort.created === false ? "ALREADY_PROVISIONED" : "PROVISIONED";
  });
}

async function executeRecovery({ db, reportIds, confirmDigest, ensure }) {
  assertReportIds(reportIds);
  if (!String(db.projectId || "").startsWith("demo-")) throw new RecoveryStop("environment", "Recovery execution runs only against a demo project; production execution needs a separate approved plan.");
  if (typeof confirmDigest !== "string" || !/^[0-9a-f]{16}$/.test(confirmDigest)) throw new RecoveryStop("confirmation", "The digest from the reviewed dry run is required.");
  const { rows, digest } = await review({ db, reportIds });
  if (digest !== confirmDigest) throw new RecoveryStop("confirmation", "The reviewed plan changed; review a fresh dry run. Nothing was written.", { digest });
  const results = [];
  for (const reviewed of rows) {
    const { reportId, reportNumber, expectedCohortId, decision } = reviewed.row;
    let status = decision;
    if (decision === ELIGIBLE) {
      try { status = await recoverOne({ db, ensure, reviewed }); }
      catch (error) { return { status: "STOPPED", results, failedReportId: reportId, error: sanitizeError(error) }; }
    }
    results.push({ reportId, reportNumber, expectedCohortId, status });
  }
  return { status: "COMPLETED", results };
}

module.exports = { RecoveryStop, assertReportIds, executeRecovery, planRecovery };
