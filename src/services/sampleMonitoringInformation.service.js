const crypto = require("node:crypto");
const release = require("../config/permanentSampleRelease");

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(400, `Text is required (maximum ${max} characters).`);
  return value.trim();
};
const digest = values => crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const safe = (id, row) => ({ id, visitId: row.visitId, cohortId: row.cohortId, siteId: row.siteId,
  question: row.question, status: row.status, version: row.version, createdAt: row.createdAt,
  answeredAt: row.answeredAt || null, answer: row.answer || null,
  history: (row.history || []).map(({ action, at, role }) => ({ action, at, role })), writesPaused: release.resolve().paused });

// Dependencies are injected only by credential-free tests; production uses the
// same Firebase database and transactional notification writer as other flows.
function createService({ db, notify, now, enabled }) {
  const ref = (collection, id) => {
    if (!validId(id)) fail(404, "Record not found.");
    return db.collection(collection).doc(id);
  };
  const gate = actor => {
    if (!enabled()) fail(409, "Monitoring information requests are disabled.");
    if (!actor?.actorId) fail(401, "Authentication required.");
    if (!["staff", "admin", "participant"].includes(actor.actorRole)) fail(403, "Access denied.");
    release.assertUser(actor.actorId);
  };
  async function visit(read, visitId, actor) {
    const snapshot = await read(ref("sampleMonitoringVisits", visitId));
    if (!snapshot.exists) fail(404, "Visit not found.");
    const row = snapshot.data();
    if (actor.actorRole === "participant" || (actor.actorRole === "staff" && row.createdBy !== actor.actorId)) fail(404, "Visit not found.");
    release.assertScope(actor.actorId, row.cohortId);
    return row;
  }
  async function recipient(read, row) {
    const cohort = await read(ref("verifiedPlantingCohorts", row.cohortId));
    const source = cohort.exists && cohort.data().source;
    if (!source || source.siteId !== row.siteId || !source.requestId || !source.plantingReportId) fail(409, "No verified requester relationship is available.");
    const report = await read(ref("plantingReports", source.plantingReportId));
    if (!report.exists) fail(409, "No verified requester relationship is available.");
    const data = report.data();
    const authoritative = data.reportType === "parent"
      ? data.reportingProgress === "Completed" && Number(data.acceptedQuantity) > 0
      : data.verificationStatus === "Approved" && Number(data.quantityPlanted) > 0;
    if (!authoritative || data.requestId !== source.requestId) fail(409, "No verified requester relationship is available.");
    const request = await read(ref("seedlingRequests", source.requestId));
    const uid = request.exists && request.data().participantId;
    if (!validId(uid)) fail(409, "No verified requester relationship is available.");
    const user = await read(ref("users", uid));
    if (!user.exists || user.data().role !== "participant" || user.data().status === "inactive") fail(409, "No verified requester relationship is available.");
    return { uid, requestId: source.requestId, plantingReportId: source.plantingReportId };
  }
  async function authorized(read, requestId, actor) {
    const snapshot = await read(ref("sampleMonitoringInformationRequests", requestId));
    if (!snapshot.exists) fail(404, "Information request not found.");
    const row = snapshot.data();
    release.assertScope(actor.actorId, row.cohortId);
    if (actor.actorRole === "participant") {
      if (row.recipientUserId !== actor.actorId) fail(404, "Information request not found.");
      const current = await recipient(read, row);
      if (current.uid !== row.recipientUserId || current.requestId !== row.sourceRequestId || current.plantingReportId !== row.plantingReportId) fail(404, "Information request not found.");
    } else {
      const current = await visit(read, row.visitId, actor);
      if (current.cohortId !== row.cohortId || current.siteId !== row.siteId) fail(404, "Information request not found.");
    }
    return row;
  }
  return {
    async create({ visitId, question, key, ...actor }) {
      gate(actor);
      if (!["staff", "admin"].includes(actor.actorRole)) fail(403, "Access denied.");
      release.assertWrite();
      question = text(question, 2000); key = text(key, 120);
      const id = `VPMI-${digest([visitId, actor.actorId, key])}`;
      return db.runTransaction(async tx => {
        const read = r => tx.get(r);
        const current = await visit(read, visitId, actor);
        const target = await recipient(read, current);
        release.assertScope(target.uid, current.cohortId);
        const doc = ref("sampleMonitoringInformationRequests", id);
        const existing = await read(doc);
        const fingerprint = digest([question, target.uid, target.requestId, target.plantingReportId, current.cohortId, current.siteId]);
        if (existing.exists) {
          if (existing.data().fingerprint !== fingerprint) fail(409, "Idempotency key conflicts with an existing question.");
          return safe(id, existing.data());
        }
        const at = now();
        const row = { visitId, cohortId: current.cohortId, siteId: current.siteId,
          requestedBy: actor.actorId, requestedByRole: actor.actorRole, recipientUserId: target.uid,
          sourceRequestId: target.requestId, plantingReportId: target.plantingReportId, fingerprint,
          question, status: "OPEN", version: 0, createdAt: at,
          history: [{ action: "REQUESTED", role: actor.actorRole, actorId: actor.actorId, at }] };
        release.writeScope(actor.actorId, row.cohortId);
        tx.create(doc, row);
        notify(tx, { notificationId: `${id}-question`, recipientUserId: target.uid,
          type: "sample_monitoring_information", title: "Monitoring information requested",
          message: "MENRO requested additional information. Answer This to respond securely.",
          relatedRecordType: "sampleMonitoringInformation", relatedRecordId: id, createdAt: at });
        return safe(id, row);
      });
    },
    async get({ requestId, ...actor }) {
      gate(actor);
      return safe(requestId, await authorized(r => r.get(), requestId, actor));
    },
    async list({ visitId, cursor = "", limit = 50, paged = false, ...actor }) {
      gate(actor);
      const size = Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > 50) fail(400, "Limit must be 1–50.");
      let query = db.collection("sampleMonitoringInformationRequests");
      if (actor.actorRole === "participant") query = release.scopeQuery(query.where("recipientUserId", "==", actor.actorId));
      else {
        await visit(r => r.get(), visitId, actor);
        query = query.where("visitId", "==", visitId);
      }
      query = query.orderBy("createdAt", "desc").orderBy("__name__", "desc");
      if (cursor) {
        if (!validId(cursor)) fail(400, "Invalid information cursor.");
        const doc = await ref("sampleMonitoringInformationRequests", cursor).get();
        if (!doc.exists || !release.allowsCohort(doc.data().cohortId) || (actor.actorRole === "participant" ? doc.data().recipientUserId !== actor.actorId : doc.data().visitId !== visitId)) fail(400, "Invalid information cursor.");
        query = query.startAfter(doc);
      }
      const snapshot = await query.limit(size + 1).get();
      const rows = [];
      for (const doc of snapshot.docs.slice(0, size)) {
        try { rows.push(safe(doc.id, await authorized(r => r.get(), doc.id, actor))); }
        catch (error) { if (error.status !== 404 && error.status !== 409) throw error; }
      }
      return paged ? { requests: rows, nextCursor: snapshot.docs.length > size ? snapshot.docs[size - 1].id : null } : rows;
    },
    async answer({ requestId, answer, expectedVersion, key, ...actor }) {
      gate(actor);
      if (actor.actorRole !== "participant") fail(403, "Only the intended requester may answer.");
      release.assertWrite();
      answer = text(answer, 4000); key = text(key, 120);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) fail(400, "Expected version is required.");
      return db.runTransaction(async tx => {
        const row = await authorized(r => tx.get(r), requestId, actor);
        const fingerprint = digest([actor.actorId, key, answer, expectedVersion]);
        if (row.status === "ANSWERED") {
          if (row.answerFingerprint !== fingerprint) fail(409, "This request has already been answered.");
          return safe(requestId, row);
        }
        if (row.version !== expectedVersion) fail(409, "Information request changed. Refresh before answering.");
        const at = now();
        const updated = { ...row, answer, answerFingerprint: fingerprint, answeredAt: at, status: "ANSWERED", version: row.version + 1,
          history: [...row.history, { action: "ANSWERED", role: "participant", actorId: actor.actorId, at }] };
        release.assertScope(row.requestedBy, row.cohortId);
        release.writeScope(actor.actorId, row.cohortId);
        tx.set(ref("sampleMonitoringInformationRequests", requestId), updated);
        notify(tx, { notificationId: `${requestId}-answer`, recipientUserId: row.requestedBy,
          type: "sample_monitoring_information_answer", title: "Monitoring information received",
          message: "The requester answered your monitoring information request.",
          relatedRecordType: "sampleMonitoringInformation", relatedRecordId: requestId, createdAt: at });
        return safe(requestId, updated);
      });
    },
  };
}

module.exports = { createService };
