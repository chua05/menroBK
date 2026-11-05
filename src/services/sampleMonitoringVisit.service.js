const crypto = require("node:crypto");
const validation = require("./sampleMonitoringValidation");
const release = require("../config/permanentSampleRelease");
const {
  Timestamp
} = require("firebase-admin/firestore");
const {
  db
} = require("../config/firebase");
const {
  resolveVerifiedPlantingCohortConfig
} = require("../config/verifiedPlantingCohort");
const CONDITIONS = new Set(["Healthy", "Damaged", "Dead", "Needs Rechecking"]);
const INVESTIGATION_OUTCOMES = new Set(["Not Located After Rechecking"]);
const disabled = () => Object.assign(new Error("Verified planting cohort workflow is disabled."), {
  status: 409,
  code: "COHORT_WORKFLOW_DISABLED"
});
const conflict = m => Object.assign(new Error(m), {
  status: 409
});
const id = (cohortId, date) => `VPMV-${crypto.createHash("sha256").update(`${cohortId}\0${date}`).digest("hex").slice(0, 28)}`;
const visitRef = visitId => db.collection("sampleMonitoringVisits").doc(visitId);
async function priorApprovedVisit(cohortId, siteId, planVersion, baselineVersion, visitDate) {
  const snapshot = await db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortId).where("status", "==", "APPROVED").get();
  const candidates = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  })).filter(visit => visit.siteId === siteId && Number(visit.samplingPlanVersion) === Number(planVersion) && Number(visit.baselineVersion) === Number(baselineVersion) && String(visit.visitDate) < String(visitDate));
  candidates.sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate)) || String(a.id).localeCompare(String(b.id)));
  if (candidates.length > 1 && candidates.at(-1).visitDate === candidates.at(-2).visitDate) throw conflict("Ambiguous prior approved monitoring visits require MENRO review.");
  return candidates.at(-1) || null;
}
function summary(assessments) {
  return assessments.reduce((r, a) => {
    if (a.condition === "Healthy") r.healthy++;else if (a.condition === "Damaged") r.damaged++;else if (a.condition === "Dead") r.dead++;else r.needsRechecking++;
    return r;
  }, {
    healthy: 0,
    damaged: 0,
    dead: 0,
    needsRechecking: 0
  });
}
function normalize(items, samples) {
  if (!Array.isArray(items) || items.length !== samples.length) throw new Error("Every approved sample requires an assessment.");
  const allowed = new Set(samples.map(s => s.permanentId));
  const seen = new Set();
  return items.map(a => {
    const sampleId = String(a?.sampleId || "");
    if (!allowed.has(sampleId) || seen.has(sampleId) || !CONDITIONS.has(a?.condition)) throw new Error("Assessment does not match an approved sample.");
    seen.add(sampleId);
    const remarks = String(a?.remarks || "").trim().slice(0, 1000),
      outcome = String(a?.investigationOutcome || "").trim();
    if (a.condition === "Needs Rechecking" && !remarks) throw new Error("Needs Rechecking requires remarks.");
    if (outcome && !INVESTIGATION_OUTCOMES.has(outcome)) throw new Error("Invalid investigation outcome.");
    if (outcome && a.condition !== "Needs Rechecking") throw new Error("An investigation outcome requires Needs Rechecking.");
    if (outcome && !String(a?.searchFindings || "").trim()) throw new Error("Not Located After Rechecking requires documented search findings.");
    return {
      sampleId,
      condition: a.condition,
      remarks,
      heightCentimeters: validation.measurement(a.heightCentimeters),
      diameterCentimeters: validation.measurement(a.diameterCentimeters),
      investigationOutcome: outcome || null,
      searchFindings: outcome ? String(a.searchFindings).trim().slice(0, 1000) : null,
      recheckQueued: a.condition === "Needs Rechecking" && !outcome
    };
  });
}
async function create({
  cohortId,
  actorId,
  visitDate,
  testOnly = false
}) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabled();
  release.writeScope(actorId, cohortId);
  if (!testOnly) throw conflict("Future visit scheduling requires MENRO policy approval.");
  const snap = await db.collection("verifiedPlantingCohorts").doc(cohortId).get(),
    c = snap.data(),
    plan = c?.samplingPlan,
    units = c?.baseline?.sampleUnits;
  if (!snap.exists || plan?.status !== "APPROVED" || c?.baseline?.approvalStatus !== "APPROVED" || !Array.isArray(units) || !units.length) throw conflict("Approved cohort, plan, and baseline are required.");
  const baselineVersion = Number(c.baselineVersion || 0),
    prior = await priorApprovedVisit(cohortId, c.source.siteId, plan.version, baselineVersion, visitDate),
    unresolved = new Map((prior?.sampleAssessments || []).filter(a => a.recheckQueued || a.condition === "Needs Rechecking").map(a => [a.sampleId, a]));
  const visitId = id(cohortId, visitDate),
    ref = visitRef(visitId);
  await db.runTransaction(async tx => {
    const old = await tx.get(ref);
    release.writeScope(actorId, cohortId);
    if (!old.exists) tx.create(ref, {
      schemaVersion: 1,
      cohortId,
      siteId: c.source.siteId,
      samplingPlanVersion: plan.version,
      baselineVersion,
      visitDate,
      status: "DRAFT",
      version: 0,
      createdBy: actorId,
      priorVisitId: prior?.id || null,
      sampleAssessments: units.map(u => {
        const previous = unresolved.get(u.permanentId);
        return {
          sampleId: u.permanentId,
          condition: null,
          remarks: "",
          baselineReference: {
            sampleId: u.permanentId
          },
          recheckRequired: Boolean(previous),
          previousAssessmentReference: previous ? {
            visitId: prior.id,
            sampleId: previous.sampleId,
            condition: previous.condition,
            remarks: previous.remarks || "",
            investigationOutcome: previous.investigationOutcome || null
          } : null
        };
      }),
      history: [],
      createdAt: Timestamp.now()
    });
  });
  return get(visitId);
}
async function get(visitId, { actorId, actorRole } = {}) {
  const s = await visitRef(visitId).get();
  if (!s.exists) throw Object.assign(new Error("Monitoring visit not found."), {
    status: 404
  });
  const value = s.data();
  if (actorRole && !['staff', 'admin'].includes(actorRole)) throw Object.assign(new Error('Monitoring visit not found.'), { status: 404 });
  if (actorRole === 'staff' && value.createdBy !== actorId) throw Object.assign(new Error('Monitoring visit not found.'), { status: 404 });
  if (actorRole) release.assertScope(actorId, value.cohortId);
  return {
    id: s.id,
    ...value,
    writesPaused: release.resolve().paused,
  };
}
async function list({ actorId, actorRole, status, limit = 25, cursor = "" }) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabled();
  if (!['staff', 'admin'].includes(actorRole)) throw Object.assign(new Error('Monitoring visits are restricted to MENRO Staff and Admin.'), { status: 403 });
  const policy = release.assertUser(actorId);
  const size = Math.max(1, Math.min(Number(limit) || 25, 50));
  let query = db.collection('sampleMonitoringVisits');
  if (actorRole === 'staff') query = query.where('createdBy', '==', actorId);
  query = release.scopeQuery(query, policy);
  if (status) query = query.where('status', '==', String(status));
  query = query.orderBy('visitDate', 'desc').orderBy('__name__').limit(size + 1);
  if (cursor) {
    const cursorDoc = await db.collection('sampleMonitoringVisits').doc(String(cursor)).get();
    if (!cursorDoc.exists || !release.allowsCohort(cursorDoc.data().cohortId, policy) || (actorRole === 'staff' && cursorDoc.data().createdBy !== actorId)) throw Object.assign(new Error('Invalid monitoring visit cursor.'), { status: 400 });
    query = query.startAfter(cursorDoc);
  }
  const snapshot = await query.get();
  const visits = snapshot.docs.slice(0, size).map(doc => {
    const value = doc.data(); const assessments = value.sampleAssessments || [];
    const completed = assessments.filter(item => item.condition).length;
    const editable = !policy.paused && actorRole === 'staff' && value.createdBy === actorId && ['DRAFT', 'RETURNED'].includes(value.status);
    return { id: doc.id, cohortId: value.cohortId, siteId: value.siteId, visitDate: value.visitDate, status: value.status,
      version: value.version, samplingPlanVersion: value.samplingPlanVersion, baselineVersion: value.baselineVersion,
      progress: { completed, total: assessments.length, rechecking: assessments.filter(item => item.recheckRequired || item.recheckQueued).length },
      actions: { view: true, saveDraft: editable, submit: editable, review: !policy.paused && actorRole === 'admin' && value.status === 'PENDING_ADMIN_APPROVAL' } };
  });
  return { visits, nextCursor: snapshot.docs.length > size ? snapshot.docs[size - 1].id : null };
}
async function save({
  visitId,
  actorId,
  expectedVersion,
  assessments,
  submit = false
}) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabled();
  validation.version(expectedVersion);
  validation.boolean(submit, "submit");
  release.assertUser(actorId); release.assertWrite();
  const ref = visitRef(visitId);
  await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw Object.assign(new Error("Monitoring visit not found."), {
      status: 404
    });
    const cur = doc.data();
    release.assertScope(actorId, cur.cohortId);
    if (cur.createdBy !== actorId || !["DRAFT", "RETURNED"].includes(cur.status) || Number(cur.version) !== Number(expectedVersion)) throw conflict("This monitoring visit is no longer editable.");
    const cohort = (await tx.get(db.collection("verifiedPlantingCohorts").doc(cur.cohortId))).data();
    const samples = cohort?.baseline?.sampleUnits || [];
    validation.cohortBinding(cohort, cur);
    const priorVisit = await validation.historicalVisit(id => tx.get(visitRef(id)), cur);
    const inputBySampleId = new Map((assessments || []).map(row => [row?.sampleId, row]));
    const priorBySampleId = new Map((cur.sampleAssessments || []).map(entry => [entry.sampleId, entry]));
    const values = normalize(assessments, samples).map(entry => {
      const prior = priorBySampleId.get(entry.sampleId);
      const comparable = value => value && ({ condition: value.condition, remarks: value.remarks || "", heightCentimeters: value.heightCentimeters ?? null, diameterCentimeters: value.diameterCentimeters ?? null, investigationOutcome: value.investigationOutcome || null, searchFindings: value.searchFindings || null, recheckQueued: Boolean(value.recheckQueued) });
      const correctedAfterReturn = cur.status === "RETURNED" && JSON.stringify(comparable(entry)) !== JSON.stringify(comparable(prior));
      return {
        ...entry,
        ...validation.references(inputBySampleId.get(entry.sampleId), entry.sampleId, priorVisit, cur.priorVisitId),
        assessmentRevision: Number(prior?.assessmentRevision || 0) + (correctedAfterReturn ? 1 : 0),
        evidenceHistory: Array.isArray(prior?.evidenceHistory) ? prior.evidenceHistory : []
      };
    });
    if (submit && values.some(entry => !entry.condition)) throw conflict("Every approved sample requires an assessment before submission.");
    const version = Number(cur.version) + 1;
    const status = submit ? "PENDING_ADMIN_APPROVAL" : "DRAFT";
    const now = Timestamp.now();
    release.writeScope(actorId, cur.cohortId);
    tx.update(ref, {
      sampleAssessments: values,
      summary: summary(values),
      status,
      version,
      recheckQueue: values.filter(entry => entry.recheckQueued).map(entry => entry.sampleId),
      officialKpiEligible: false,
      history: [...(cur.history || []), {
        version,
        status,
        updatedBy: actorId,
        updatedAt: now,
        summary: summary(values)
      }],
      updatedAt: now
    });
  });
  return get(visitId);
}
async function review({
  visitId,
  actorId,
  expectedVersion,
  approve,
  reasons = ""
}) {
  if (!resolveVerifiedPlantingCohortConfig().enabled) throw disabled();
  validation.version(expectedVersion);
  validation.boolean(approve, "approve");
  release.assertUser(actorId); release.assertWrite();
  if (typeof reasons !== "string" || reasons.trim().length > 1000 || !approve && !reasons.trim()) {
    throw validation.invalid("Return requires a nonblank reason (maximum 1000 characters).");
  }
  const ref = visitRef(visitId);
  await db.runTransaction(async tx => {
    const d = await tx.get(ref);
    if (!d.exists || d.data().status !== "PENDING_ADMIN_APPROVAL" || Number(d.data().version) !== Number(expectedVersion)) throw conflict("Monitoring visit is not ready for review.");
    const cohort = await tx.get(db.collection("verifiedPlantingCohorts").doc(d.data().cohortId));
    release.assertScope(actorId, d.data().cohortId);
    validation.cohortBinding(cohort.data(), d.data());
    if (approve) {
      normalize(d.data().sampleAssessments, cohort.data().baseline.sampleUnits || []);
      const prior = await validation.historicalVisit(id => tx.get(visitRef(id)), d.data());
      for (const row of d.data().sampleAssessments) validation.references(row, row.sampleId, prior, d.data().priorVisitId);
    }
    const now = Timestamp.now(),
      status = approve ? "APPROVED" : "RETURNED";
    release.writeScope(actorId, d.data().cohortId);
    tx.update(ref, {
      status,
      reviewedBy: actorId,
      reviewReasons: String(reasons).trim().slice(0, 1000),
      reviewedAt: now,
      history: [...(d.data().history || []), {
        version: d.data().version,
        status,
        reviewedBy: actorId,
        reviewedAt: now
      }]
    });
  });
  return get(visitId);
}
module.exports = {
  create,
  list,
  get,
  save,
  review,
  _test: {
    summary,
    normalize,
    id,
    priorApprovedVisit
  }
};
