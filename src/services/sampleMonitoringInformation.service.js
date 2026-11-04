const crypto = require("node:crypto");

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
  history: (row.history || []).map(({ action, at, role }) => ({ action, at, role })) });

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
  };
  async function visit(read, visitId, actor) {
    const snapshot = await read(ref("sampleMonitoringVisits", visitId));
    if (!snapshot.exists) fail(404, "Visit not found.");
    const row = snapshot.data();
    if (actor.actorRole === "participant" || (actor.actorRole === "staff" && row.createdBy !== actor.actorId)) fail(404, "Visit not found.");
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
      question = text(question, 2000); key = text(key, 120);
      const id = `VPMI-${digest([visitId, actor.actorId, key])}`;
      return db.runTransaction(async tx => {
        const read = r => tx.get(r);
        const current = await visit(read, visitId, actor);
        const target = await recipient(read, current);
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
    async list({ visitId, ...actor }) {
      gate(actor);
      let query = db.collection("sampleMonitoringInformationRequests");
      if (actor.actorRole === "participant") query = query.where("recipientUserId", "==", actor.actorId);
      else {
        await visit(r => r.get(), visitId, actor);
        query = query.where("visitId", "==", visitId);
      }
      // Bounded inbox. Direct links remain independently authorized.
      const snapshot = await query.orderBy("createdAt", "desc").limit(50).get();
      const rows = [];
      for (const doc of snapshot.docs) {
        try { rows.push(safe(doc.id, await authorized(r => r.get(), doc.id, actor))); }
        catch (error) { if (error.status !== 404 && error.status !== 409) throw error; }
      }
      return rows;
    },
    async answer({ requestId, answer, expectedVersion, key, ...actor }) {
      gate(actor);
      if (actor.actorRole !== "participant") fail(403, "Only the intended requester may answer.");
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
