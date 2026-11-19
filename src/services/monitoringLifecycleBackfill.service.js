// Read-only, target-scoped backfill preflight. Callers supply a configured SDK;
// this module never initializes Firebase, allocates a number, or performs writes.
const { validateIntegrationEnvironment } = require("../config/integrationEnvironment");
const PRODUCTION_PROJECT = "menrosystem-ddfac";
const PRODUCTION_TARGETS = Object.freeze([
  Object.freeze({ reportId: "event_EVT-2026-025", reportNumber: "RPT-2026-020" }),
  Object.freeze({ reportId: "event_EVT-2026-029", reportNumber: "RPT-2026-024" }),
]);
const REPORT_FIELDS = ["reportNumber", "archived", "verificationStatus", "reportingProgress", "verifiedAt", "adminVerifiedAt", "approvedAt", "reviewedAt", "completedAt", "verificationDate",
  "participantId", "eventId", "siteId", "plantingDate", "eventDate", "acceptedQuantity", "quantityPlanted",
  "reportingPolicy.monitoring", "reportingPolicy.definition.monitoring", "reportingPolicy.policyVersion"];
const LIFECYCLE_FIELDS = ["plantingReportId", "participantId", "eventId", "siteId", "monitoringNumber", "monitoringMethod", "archived", "scheduleStatus",
  "startMonitoringDate", "nextMonitoringDate", "monitoringEndDate"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const string = value => typeof value === "string" ? value.trim() : "";
function numberParts(value) {
  const normalized = string(value).toUpperCase(), match = /^MON-(\d{4})-(\d{3,})$/.exec(normalized);
  const sequence = match && Number(match[2]);
  return match && Number(match[1]) >= 1000 && Number.isSafeInteger(sequence) && sequence > 0 ? { normalized, year: Number(match[1]), sequence } : null;
}
function dateValue(value) {
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  return typeof value === "string" ? value : null;
}
function dateOnlyValid(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function createMonitoringLifecycleBackfill({ db, app, registration, lifecycleId, now = () => new Date(), env = process.env }) {
  function guard({ expectedProject, expectedDatabaseId = "(default)", targets }) {
    if (!string(expectedProject) || expectedProject !== db.projectId) throw new Error("Refusing preflight: expected project must match the resolved Firestore project before reads.");
    if (expectedDatabaseId !== "(default)" || db.databaseId !== expectedDatabaseId) throw new Error("Refusing preflight: only the verified (default) database is permitted.");
    for (const declared of [app?.options?.projectId, env.FIREBASE_PROJECT_ID, env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT]) {
      if (declared !== undefined && declared !== expectedProject) throw new Error("Refusing preflight: contradictory project declarations.");
    }
    if (expectedProject === PRODUCTION_PROJECT) {
      if (env.NODE_ENV !== "production" || env.FIREBASE_PROJECT_ID !== PRODUCTION_PROJECT) throw new Error("Refusing preflight: verified production mode and an explicit matching project declaration are required.");
      if (["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "MENRO_UNIT_TEST_FIREBASE"].some(key => env[key] !== undefined) ||
          ["MENRO_INTEGRATION_TEST", "MENRO_PHASE3C_ISOLATED_EMULATORS", "MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS", "MENRO_PHASE3C_BROWSER_ACCEPTANCE",
            "MENRO_SAMPLE_MONITORING_FORM_ACCEPTANCE", "MENRO_BASELINE_EVIDENCE_ACCEPTANCE", "MENRO_MPDO_BOUNDARY_ACCEPTANCE", "MENRO_REQUEST_LETTER_ACCEPTANCE"].some(key => env[key] === "true")) {
        throw new Error("Refusing preflight: production project cannot use emulator or test mode.");
      }
      const selected = targets || PRODUCTION_TARGETS;
      if (!Array.isArray(selected) || selected.length !== PRODUCTION_TARGETS.length || PRODUCTION_TARGETS.some(target => !selected.some(row => row.reportId === target.reportId && row.reportNumber === target.reportNumber))) {
        throw new Error("Refusing preflight: production scope is restricted to the two approved report document IDs.");
      }
      return PRODUCTION_TARGETS;
    }
    const integration = validateIntegrationEnvironment(env);
    if (!integration.integration || !(integration.phase3cIsolated || integration.legacyMonitoringIsolated) || integration.projectId !== expectedProject ||
        !Array.isArray(targets) || !targets.length || targets.length > 2 || targets.some(row => !UUID.test(row.reportId || "") || !string(row.reportNumber) || row.reportId.includes("/")) ||
        new Set(targets.map(row => row.reportId)).size !== targets.length || new Set(targets.map(row => row.reportNumber)).size !== targets.length) {
      throw new Error("Refusing preflight: custom fixtures require the validated isolated demo topology and unique UUID-scoped targets.");
    }
    return targets;
  }

  async function plan(options = {}) {
    const targets = guard(options); // Must finish before references, transactions, or reads.
    const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric" }).format(now()));
    return db.runTransaction(async transaction => {
      const reportsCollection = db.collection("plantingReports"), recordsCollection = db.collection("monitoringRecords");
      const reports = await transaction.getAll(...targets.map(target => reportsCollection.doc(target.reportId)), { fieldMask: REPORT_FIELDS });
      const pairs = targets.map((target, index) => ({ ...target, report: reports[index].exists ? reports[index].data() : null }));
      const canonicalIds = pairs.map(row => row.report ? lifecycleId(row.report.participantId || "", row.reportId, row.report.eventId || "", row.report.siteId || "") : null);
      const canonicalRefs = canonicalIds.filter(Boolean).map(id => recordsCollection.doc(id));
      const canonicalSnapshots = canonicalRefs.length ? await transaction.getAll(...canonicalRefs, { fieldMask: LIFECYCLE_FIELDS }) : [];
      const canonicalById = new Map(canonicalSnapshots.filter(doc => doc.exists).map(doc => [doc.id, doc.data()]));
      const linked = await transaction.get(recordsCollection.where("plantingReportId", "in", targets.map(target => target.reportId)).select(...LIFECYCLE_FIELDS));
      const allNumbers = await transaction.get(recordsCollection.select("monitoringNumber", "plantingReportId", "archived"));
      const counter = await transaction.get(db.collection("counters").doc(`monitoringRecords_${year}`));
      const humanMatches = [];
      for (const target of targets) humanMatches.push(await transaction.get(reportsCollection.where("reportNumber", "==", target.reportNumber).select("reportNumber").limit(2)));

      const numberCounts = new Map(); let malformedNumbers = 0, unnumbered = 0, maximumSequence = 0, currentYearNumbered = 0, otherYearNumbered = 0;
      for (const doc of allNumbers.docs) {
        const value = doc.data().monitoringNumber;
        if (value === undefined || value === null || value === "") { unnumbered++; continue; }
        const parsed = numberParts(value);
        if (!parsed) { malformedNumbers++; continue; }
        const sequenceKey = `${parsed.year}:${parsed.sequence}`;
        numberCounts.set(sequenceKey, (numberCounts.get(sequenceKey) || 0) + 1);
        if (parsed.year === year) { currentYearNumbered++; maximumSequence = Math.max(maximumSequence, parsed.sequence); }
        else otherYearNumbered++;
      }
      const duplicateNumbers = [...numberCounts.values()].filter(count => count > 1).length;
      const counterData = counter.exists ? counter.data() : null;
      const integrityReasons = [];
      if (malformedNumbers) integrityReasons.push("MALFORMED_MONITORING_NUMBERS");
      if (duplicateNumbers) integrityReasons.push("DUPLICATE_MONITORING_NUMBERS");
      if (!counter.exists && maximumSequence > 0) integrityReasons.push("COUNTER_MISSING_WITH_EXISTING_NUMBERS");
      if (counter.exists && (typeof counterData.lastNumber !== "number" || !Number.isSafeInteger(counterData.lastNumber) || counterData.lastNumber < 0 || counterData.year !== year)) integrityReasons.push("INVALID_COUNTER");
      else if (counter.exists && counterData.lastNumber < maximumSequence) integrityReasons.push("COUNTER_BEHIND_EXISTING_NUMBERS");
      if (counter.exists && counterData.lastNumber > Number.MAX_SAFE_INTEGER - targets.length) integrityReasons.push("COUNTER_EXHAUSTED");
      // A missing counter alone proves nothing: it is a legitimate first allocation only when the full scan of
      // monitoringRecords finds no current-year MON number (and no malformed/duplicate numbers). Registration
      // then starts the year's sequence at 1 (reserveRecordNumber treats a missing counter as lastNumber 0).
      const counterState = counter.exists
        ? integrityReasons.includes("INVALID_COUNTER") ? "INVALID"
          : integrityReasons.includes("COUNTER_BEHIND_EXISTING_NUMBERS") ? "BEHIND_EXISTING_NUMBERS"
            : integrityReasons.includes("COUNTER_EXHAUSTED") ? "EXHAUSTED" : "CONSISTENT"
        : currentYearNumbered > 0 ? "ABSENT_WITH_EXISTING_NUMBERS" : "ABSENT_FIRST_ALLOCATION";
      const firstAllocationSafe = counterState === "ABSENT_FIRST_ALLOCATION" && !malformedNumbers && !duplicateNumbers;

      const rows = pairs.map((row, index) => {
        const reasons = [...integrityReasons], report = row.report, canonicalId = canonicalIds[index];
        const matches = new Map(linked.docs.filter(doc => doc.data().plantingReportId === row.reportId).map(doc => [doc.id, doc.data()]));
        if (canonicalId && canonicalById.has(canonicalId)) matches.set(canonicalId, canonicalById.get(canonicalId));
        if (!report) reasons.push("REPORT_NOT_FOUND");
        if (humanMatches[index].docs.length !== 1 || humanMatches[index].docs[0]?.id !== row.reportId || report?.reportNumber !== row.reportNumber) reasons.push("REPORT_NUMBER_NOT_UNIQUE_OR_MISMATCHED");
        const resolution = report ? registration.monitoringPolicyResolution(report) : null;
        if (report?.archived === true) reasons.push("REPORT_ARCHIVED");
        if (resolution?.conflict) reasons.push("MONITORING_POLICY_CONFLICT");
        if (resolution && !["LEGACY", "STAFF_SPOT_CHECK", "PERMANENT_SAMPLE", "PENDING_MENRO_POLICY", "NONE"].includes(resolution.method)) reasons.push("UNRECOGNIZED_MONITORING_POLICY");
        if (report && !registration.eligible(report)) reasons.push("REPORT_NOT_ELIGIBLE");
        if (matches.size > 1) reasons.push("DUPLICATE_LIFECYCLES");
        if ([...matches.keys()].some(id => id !== canonicalId)) reasons.push("NONCANONICAL_LIFECYCLE");
        if ([...matches.values()].some(value => value.archived === true)) reasons.push("LIFECYCLE_ARCHIVED");
        const current = canonicalById.get(canonicalId);
        if (current && ["plantingReportId", "participantId", "eventId", "siteId"].some(key => String(current[key] || "") !== String(key === "plantingReportId" ? row.reportId : report?.[key] || ""))) reasons.push("LIFECYCLE_RELATIONSHIP_MISMATCH");
        if (current && resolution && (string(current.monitoringMethod) || "LEGACY") !== resolution.method) reasons.push("LIFECYCLE_POLICY_MISMATCH");
        if (current?.monitoringNumber && !numberParts(current.monitoringNumber)) reasons.push("INVALID_TARGET_MONITORING_NUMBER");
        if (report && resolution?.method === "LEGACY" && !current && !dateOnlyValid(String(report.plantingDate || report.eventDate || "").slice(0, 10))) reasons.push("LEGACY_PLANTING_DATE_INVALID");
        const action = reasons.length ? "BLOCKED" : current?.monitoringNumber ? "KEEP" : current ? "ASSIGN_NUMBER" : "REGISTER";
        return { reportId: row.reportId, reportNumber: row.reportNumber, verificationStatus: report?.verificationStatus || null,
          reportingProgress: report?.reportingProgress || null, verificationDate: dateValue(report?.adminVerifiedAt || report?.approvedAt || report?.completedAt || report?.verifiedAt || report?.verificationDate),
          reviewedAt: dateValue(report?.reviewedAt),
          monitoringMethod: resolution?.method || null, policySource: resolution?.source || null, canonicalLifecycleId: canonicalId,
          storedMonitoringPolicy: report ? { direct: string(report.reportingPolicy?.monitoring) || null, definition: string(report.reportingPolicy?.definition?.monitoring) || null } : null,
          lifecycles: [...matches].map(([id, value]) => ({ id, monitoringNumber: numberParts(value.monitoringNumber)?.normalized || null,
            hasMonitoringNumber: Boolean(value.monitoringNumber), monitoringNumberValid: Boolean(numberParts(value.monitoringNumber)), archived: value.archived === true,
            monitoringMethod: value.monitoringMethod || null, scheduleStatus: value.scheduleStatus || null,
            startMonitoringDate: value.startMonitoringDate || null, nextMonitoringDate: value.nextMonitoringDate || null, monitoringEndDate: value.monitoringEndDate || null })),
          action, reasons: [...new Set(reasons)], scheduleEffect: current ? "EXISTING_SCHEDULE_UNCHANGED" : resolution?.method === "LEGACY" ? "EXISTING_LEGACY_RULES_ON_REGISTRATION" : "AWAITING_MONITORING_POLICY_NO_DATES" };
      });
      const registerCount = rows.filter(row => row.action === "REGISTER").length, assignCount = rows.filter(row => row.action === "ASSIGN_NUMBER").length;
      const blocked = rows.some(row => row.action === "BLOCKED");
      return { mode: "dry-run", readOnly: true, projectId: options.expectedProject, databaseId: "(default)",
        targetCount: targets.length, monitoringRecordsScanned: allNumbers.docs.length, otherReportsPlanned: 0,
        proposedChangeCount: registerCount + assignCount,
        blocked, numberIntegrity: { year, counterId: `monitoringRecords_${year}`, counterExists: counter.exists, counterState, firstAllocationSafe,
          counterLastNumber: Number.isSafeInteger(counterData?.lastNumber) ? counterData.lastNumber : null, maximumExistingSequence: maximumSequence,
          currentYearNumberedCount: currentYearNumbered, otherYearNumberedCount: otherYearNumbered, malformedNumberCount: malformedNumbers,
          duplicateNumberCount: duplicateNumbers, unnumberedRecordCount: unnumbered, reasons: integrityReasons },
        // Exact effect a separately approved registration would have (counts only; no MON IDs are allocated or shown).
        writeScopeIfApproved: blocked || !(registerCount + assignCount) ? null : {
          monitoringRecordsCreated: registerCount, monitoringNumbersAssignedToExisting: assignCount,
          counterDocument: counter.exists ? "UPDATE_LAST_NUMBER" : "CREATE", counterId: `monitoringRecords_${year}`,
          plantingReportsChanged: 0, monitoringPoliciesChanged: 0, observationsOrVisitsCreated: 0 },
        plan: rows };
    }, { readOnly: true });
  }
  return { plan };
}
module.exports = { PRODUCTION_PROJECT, PRODUCTION_TARGETS, createMonitoringLifecycleBackfill };
