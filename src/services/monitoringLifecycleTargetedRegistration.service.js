// Target-scoped historical Monitoring Lifecycle registration (separately approved operation).
//
// Registers lifecycles only for an explicit, fixed target list (production: the two approved reports) using
// the existing reviewed registration logic (prepareLifecycleRegistrationInTransaction /
// commitLifecycleRegistration). The Firestore instance is injected, so the Cloud Shell ADC tool and the
// emulator tests run the same code; the backend's key-based production app is never initialized here.
//
// Safety model:
// - A read-only preflight (monitoringLifecycleBackfill.service) runs first. Any block reason, numbering
//   integrity finding, unexpected method or action stops before writes. The operator must confirm the
//   exact plan digest printed by the dry run, so the state reviewed is the state written.
// - Each report is registered in ONE Firestore transaction that re-reads and revalidates the report
//   (number, eligibility, stored policy), every lifecycle linked to it (canonical ID only, no duplicates,
//   matching relationship and method) and current-year numbering (no malformed/duplicate numbers, counter
//   never behind existing numbers) before reserving the next MON number from the transactional counter.
//   A report is either fully registered (lifecycle + counter) or untouched; no half-written state.
// - Re-running is idempotent: a report whose canonical lifecycle already has a valid number is NO_CHANGE.
// - Created lifecycle IDs and MON numbers are reported only after their transaction commits.
const crypto = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { createMonitoringLifecycleBackfill } = require("./monitoringLifecycleBackfill.service");
const policy = require("./monitoringLifecyclePolicy");
const { lifecycleId } = require("../utils/monitoringLifecycleId.util");
const registration = require("./monitoringLifecycleRegistration.service");

const MON_NUMBER = /^MON-(\d{4})-(\d{3,})$/;
const ALLOWED_ACTIONS = new Set(["REGISTER", "ASSIGN_NUMBER", "KEEP"]);

class RegistrationStop extends Error {
  constructor(step, message, details = {}) { super(`[${step}] ${message}`); this.step = step; this.details = details; }
}

const manilaYear = (date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric" }).format(date));
function parseNumber(value) {
  const match = MON_NUMBER.exec(String(value || "").trim().toUpperCase());
  const sequence = match && Number(match[2]);
  return match && Number(match[1]) >= 1000 && Number.isSafeInteger(sequence) && sequence > 0 ? { year: Number(match[1]), sequence } : null;
}

// Stable digest of everything the operator reviews in the dry run; any change requires a new review.
function planDigest(preflight) {
  const canonical = {
    project: preflight.projectId, databaseId: preflight.databaseId, scanned: preflight.monitoringRecordsScanned,
    counter: { year: preflight.numberIntegrity.year, exists: preflight.numberIntegrity.counterExists, lastNumber: preflight.numberIntegrity.counterLastNumber,
      state: preflight.numberIntegrity.counterState, maximum: preflight.numberIntegrity.maximumExistingSequence },
    rows: preflight.plan.map(row => ({ reportId: row.reportId, reportNumber: row.reportNumber, action: row.action, method: row.monitoringMethod,
      canonical: row.canonicalLifecycleId, lifecycles: row.lifecycles.map(item => [item.id, item.monitoringNumber]) })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

function assessPlan(preflight, requiredMethod) {
  const blockers = [];
  if (preflight.readOnly !== true) blockers.push("PREFLIGHT_NOT_READ_ONLY");
  if (preflight.blocked) blockers.push("PREFLIGHT_BLOCKED");
  for (const reason of preflight.numberIntegrity.reasons) blockers.push(`NUMBERING:${reason}`);
  for (const row of preflight.plan) {
    if (row.monitoringMethod !== requiredMethod) blockers.push(`${row.reportId}:METHOD_${row.monitoringMethod || "MISSING"}`);
    if (!ALLOWED_ACTIONS.has(row.action)) blockers.push(`${row.reportId}:ACTION_${row.action}`);
  }
  return [...new Set(blockers)];
}

function createTargetedRegistration({ db, app, env = process.env, targets, expectedProject = db.projectId, requiredMethod = "STAFF_SPOT_CHECK", now = () => Timestamp.now() }) {
  if (!Array.isArray(targets) || !targets.length) throw new RegistrationStop("targets", "An explicit target list is required.");
  const preflightService = createMonitoringLifecycleBackfill({ db, app, registration: policy, lifecycleId, env, now: () => now().toDate() });

  async function dryRun() {
    const preflight = await preflightService.plan({ expectedProject, expectedDatabaseId: "(default)", targets });
    return { preflight, planDigest: planDigest(preflight), blockers: assessPlan(preflight, requiredMethod) };
  }

  // One atomic transaction per report. Throws RegistrationStop (no write) on any revalidation failure.
  async function registerTarget(target) {
    return db.runTransaction(async (transaction) => {
      const timestamp = now();
      const year = manilaYear(timestamp.toDate());
      const records = db.collection("monitoringRecords");
      const reportSnap = await transaction.get(db.collection("plantingReports").doc(target.reportId));
      if (!reportSnap.exists) throw new RegistrationStop("revalidate", `${target.reportId}: report not found.`);
      const report = reportSnap.data() || {};
      const resolution = policy.monitoringPolicyResolution(report);
      if (report.reportNumber !== target.reportNumber) throw new RegistrationStop("revalidate", `${target.reportId}: report number changed.`);
      if (report.archived === true || !policy.eligible(report)) throw new RegistrationStop("revalidate", `${target.reportId}: report is no longer eligible.`);
      if (resolution.conflict || resolution.method !== requiredMethod) throw new RegistrationStop("revalidate", `${target.reportId}: stored monitoring policy is ${resolution.method}, not ${requiredMethod}.`);

      const canonicalId = lifecycleId(report.participantId || "", target.reportId, report.eventId || "", report.siteId || "");
      const linked = await transaction.get(records.where("plantingReportId", "==", target.reportId));
      const canonical = await transaction.get(records.doc(canonicalId));
      if (linked.docs.some(doc => doc.id !== canonicalId)) throw new RegistrationStop("revalidate", `${target.reportId}: a noncanonical or duplicate lifecycle exists.`);
      if (canonical.exists) {
        const current = canonical.data() || {};
        if (["plantingReportId", "participantId", "eventId", "siteId"].some(key => String(current[key] || "") !== String(key === "plantingReportId" ? target.reportId : report[key] || ""))) {
          throw new RegistrationStop("revalidate", `${target.reportId}: existing lifecycle relationship does not match the report.`);
        }
        if (current.archived === true) throw new RegistrationStop("revalidate", `${target.reportId}: existing lifecycle is archived.`);
        if ((String(current.monitoringMethod || "").trim() || "LEGACY") !== resolution.method) throw new RegistrationStop("revalidate", `${target.reportId}: existing lifecycle method differs from the stored policy.`);
        if (current.monitoringNumber) {
          if (!parseNumber(current.monitoringNumber)) throw new RegistrationStop("revalidate", `${target.reportId}: existing lifecycle has a malformed Monitoring ID.`);
          return { reportId: target.reportId, reportNumber: target.reportNumber, status: "NO_CHANGE", lifecycleId: canonicalId, monitoringNumber: String(current.monitoringNumber).toUpperCase() };
        }
      }

      // Current-year numbering integrity, re-read inside the transaction (Firestore retries on concurrent change).
      const counterSnap = await transaction.get(db.collection("counters").doc(`monitoringRecords_${year}`));
      const numbers = await transaction.get(records.select("monitoringNumber"));
      const seen = new Set(); let maximum = 0;
      for (const doc of numbers.docs) {
        const value = doc.data().monitoringNumber;
        if (value === undefined || value === null || value === "") continue;
        const parsed = parseNumber(value);
        if (!parsed) throw new RegistrationStop("numbering", "A malformed Monitoring ID exists; review before registering.");
        const key = `${parsed.year}:${parsed.sequence}`;
        if (seen.has(key)) throw new RegistrationStop("numbering", "Duplicate Monitoring IDs exist; review before registering.");
        seen.add(key);
        if (parsed.year === year) maximum = Math.max(maximum, parsed.sequence);
      }
      if (counterSnap.exists) {
        const counter = counterSnap.data() || {};
        if (counter.year !== year || !Number.isSafeInteger(counter.lastNumber) || counter.lastNumber < 0) throw new RegistrationStop("numbering", "The Monitoring ID counter is invalid.");
        if (counter.lastNumber < maximum) throw new RegistrationStop("numbering", "The Monitoring ID counter is behind existing numbers.");
      } else if (maximum > 0) {
        throw new RegistrationStop("numbering", "The Monitoring ID counter is missing while current-year numbers exist.");
      }

      // Existing reviewed registration: reserve from the transactional counter, then create/assign.
      const plan = await registration.prepareLifecycleRegistrationInTransaction(transaction, { reportId: target.reportId, report, now: timestamp, db });
      if (!plan) throw new RegistrationStop("revalidate", `${target.reportId}: registration was not applicable after revalidation.`);
      const monitoringNumber = registration.commitLifecycleRegistration(transaction, plan);
      return { reportId: target.reportId, reportNumber: target.reportNumber, status: plan.exists ? "NUMBER_ASSIGNED" : "REGISTERED", lifecycleId: plan.id, monitoringNumber };
    });
  }

  async function verifyAfter() {
    const { preflight } = await dryRun();
    const problems = [];
    if (preflight.numberIntegrity.reasons.length) problems.push(...preflight.numberIntegrity.reasons);
    for (const row of preflight.plan) {
      const [lifecycle] = row.lifecycles;
      if (row.action !== "KEEP" || row.lifecycles.length !== 1) problems.push(`${row.reportId}:${row.action}:${row.lifecycles.length}`);
      else if (lifecycle.monitoringMethod !== requiredMethod || (requiredMethod !== "LEGACY" && (lifecycle.scheduleStatus !== registration.AWAITING_MONITORING_POLICY ||
          lifecycle.startMonitoringDate || lifecycle.nextMonitoringDate || lifecycle.monitoringEndDate))) problems.push(`${row.reportId}:LIFECYCLE_SHAPE`);
    }
    return { ok: problems.length === 0, problems, counterState: preflight.numberIntegrity.counterState, counterLastNumber: preflight.numberIntegrity.counterLastNumber,
      lifecycles: preflight.plan.map(row => ({ reportId: row.reportId, reportNumber: row.reportNumber, ...row.lifecycles[0] })) };
  }

  async function execute({ confirmPlanDigest }) {
    const before = await dryRun();
    if (before.blockers.length) throw new RegistrationStop("preflight", `Preflight is not safe to execute: ${before.blockers.join(", ")}.`, { planDigest: before.planDigest });
    if (!confirmPlanDigest || confirmPlanDigest !== before.planDigest) {
      throw new RegistrationStop("confirmation", "The confirmed plan digest does not match the current state. Re-run the dry run, review it, and confirm its digest.", { planDigest: before.planDigest });
    }
    const results = [];
    for (const target of targets) {
      try { results.push(await registerTarget(target)); }
      catch (error) {
        const pending = targets.slice(results.length).map(row => row.reportId);
        return { status: results.some(row => row.status !== "NO_CHANGE") ? "PARTIAL" : "FAILED", completed: results, failedReportId: target.reportId, notCompleted: pending,
          error: error.message,
          recovery: ["Each report is registered in a single atomic transaction: a failed report has no lifecycle and consumed no Monitoring ID.",
            "Do not delete created lifecycles, edit the counter or change any report policy.",
            "Resolve the reported cause, re-run the dry run (completed reports now show KEEP), review it, then re-run --execute with the new plan digest.",
            "Re-running is idempotent: already registered reports return NO_CHANGE."] };
      }
    }
    return { status: "COMPLETED", planDigest: before.planDigest, results, postVerification: await verifyAfter() };
  }

  return { dryRun, execute, registerTarget, verifyAfter };
}

module.exports = { RegistrationStop, assessPlan, createTargetedRegistration, planDigest };
