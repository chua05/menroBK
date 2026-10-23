// Firestore business saga with emulator or explicitly approved GCS evidence.
// No Storage I/O occurs inside a business transaction.
const { createHash, randomUUID } = require("node:crypto");
const { resolveEvidenceStorageConfig } = require("../config/evidenceStorage");
const digest = value => createHash("sha256").update(value).digest("hex");
const LEASE_MS = 180_000;
const COLLECTION = "evidenceWorkflowOperations";
class EvidenceWorkflowError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}
function problem(code, status = 503) {
  const message = code === "IDEMPOTENCY_CONFLICT" ? "This Idempotency-Key was already used with different submission data."
    : code === "INVALID_IDEMPOTENCY_KEY" ? "Idempotency-Key must contain 8 to 128 ASCII letters, digits, underscores or hyphens."
      : code === "EVIDENCE_IN_PROGRESS" ? "Evidence processing is still in progress. Please retry with the same Idempotency-Key."
        : "Unable to process evidence. Please retry with the same Idempotency-Key.";
  return new EvidenceWorkflowError(code, status, message);
}
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw problem("INVALID_WORKFLOW_PAYLOAD", 400);
}
function enabled() { return resolveEvidenceStorageConfig().cloudWorkflow === true; }
function createEvidenceWorkflow({ db, storage, now = Date.now } = {}) {
  if (!enabled()) throw problem("CLOUD_WORKFLOW_DISABLED");
  db ||= require("../config/firebase").db;
  const expectedProject = resolveEvidenceStorageConfig().gcsProduction?.projectId || "demo-menro-phase2";
  if (db.projectId !== expectedProject) throw problem("CLOUD_WORKFLOW_DISABLED");
  storage ||= require("./firebaseEvidenceStorage.service").createFirebaseEvidenceStorage();
  const operations = db.collection(COLLECTION), capabilities = new WeakSet();
  const assert = operation => {
    if (!enabled() || !capabilities.has(operation)) throw problem("INVALID_WORKFLOW_CONTEXT");
  };
  async function run({ actor, workflow, target = "", payload, files = [], key }, perform, resolve) {
    if (!enabled()) throw problem("CLOUD_WORKFLOW_DISABLED");
    // Every real-GCS write requires a recoverable client intent. Emulator/local
    // compatibility retains its existing optional-header contract.
    const storageConfig = resolveEvidenceStorageConfig();
    if ((storageConfig.gcsDevelopment || storageConfig.gcsProduction) && key === undefined) throw problem("INVALID_IDEMPOTENCY_KEY", 400);
    if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key))) throw problem("INVALID_IDEMPOTENCY_KEY", 400);
    if (!["planting-report", "planting-contribution", "monitoring-early", "monitoring-official", "monitoring-resubmit"].includes(workflow) ||
        !actor || Object.keys(actor).length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(actor.uid ?? actor.guestParticipantId ?? "") ||
        typeof target !== "string" || target.length > 256 || !Array.isArray(files) || files.length > 10) throw problem("INVALID_WORKFLOW_CONTEXT", 400);
    const images = [];
    for (const file of files) {
      const details = await require("../utils/imageVerification.util").validateImageBuffer(file.buffer);
      images.push({ sha256: digest(file.buffer), sizeBytes: file.buffer.length, format: details.format });
    }
    const fingerprint = digest(canonical({ payload, images }));
    const scope = digest(canonical({ actor, workflow, target }));
    // No header means a NEW operation, never payload-based deduplication.
    const id = key === undefined ? randomUUID() : digest(canonical([scope, key]));
    const ref = operations.doc(id), token = randomUUID();
    const initial = { schemaVersion: 1, scope, fingerprint, workflow, targetId: randomUUID(),
      observationId: `OBS-${randomUUID()}`, intentIds: files.map(() => randomUUID()),
      status: "RUNNING", leaseToken: token, leaseUntil: now() + LEASE_MS,
      createdAt: now(), updatedAt: now(), retentionPolicy: "retain-no-ttl-v1" };
    let current;
    try { current = await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists) { tx.create(ref, initial); return initial; }
      const saved = doc.data();
      if (saved.scope !== scope || saved.fingerprint !== fingerprint) throw problem("IDEMPOTENCY_CONFLICT", 409);
      if (saved.schemaVersion !== 1 || saved.retentionPolicy !== "retain-no-ttl-v1" ||
          !["COMPLETED", "RUNNING", "RETRYABLE"].includes(saved.status) ||
          !Array.isArray(saved.intentIds) || saved.intentIds.length !== files.length ||
          !Number.isFinite(saved.leaseUntil)) throw problem("EVIDENCE_RECONCILIATION_REQUIRED");
      if (saved.status === "COMPLETED") return saved;
      if (saved.leaseUntil > now()) throw problem("EVIDENCE_IN_PROGRESS", 202);
      tx.update(ref, { status: "RUNNING", leaseToken: token, leaseUntil: now() + LEASE_MS, updatedAt: now() });
      return { ...saved, status: "RUNNING", leaseToken: token, leaseUntil: now() + LEASE_MS };
    }); } catch (cause) {
      if (cause instanceof EvidenceWorkflowError) throw cause;
      throw problem("EVIDENCE_RECONCILIATION_REQUIRED");
    }
    if (current.status === "COMPLETED") return resolve(current.resultLink);
    const operation = Object.freeze({ ...current, ref, actor: Object.freeze({ ...actor }), leaseToken: token });
    capabilities.add(operation);
    try {
      const result = await perform(operation);
      const confirmed = (await ref.get()).data();
      if (confirmed?.status !== "COMPLETED") throw problem("EVIDENCE_LINKAGE_UNCONFIRMED");
      return result;
    } catch (cause) {
      // Includes commit-acknowledgement loss. Never run the business mutation twice.
      let saved;
      try { saved = (await ref.get()).data(); } catch { throw problem("EVIDENCE_RECONCILIATION_REQUIRED"); }
      if (saved?.status === "COMPLETED") return resolve(saved.resultLink);
      try { await db.runTransaction(async tx => {
        const doc = await tx.get(ref);
        if (doc.data()?.status === "RUNNING" && doc.data().leaseToken === token) {
          tx.update(ref, { status: "RETRYABLE", leaseUntil: 0, updatedAt: now() });
        }
      }); } catch { /* Lease and durable handles remain for retry; never release quota. */ }
      if (cause instanceof EvidenceWorkflowError) throw cause;
      if (["UPLOAD_IN_PROGRESS", "INTENT_CONFLICT"].includes(cause.code)) throw problem("EVIDENCE_IN_PROGRESS", 202);
      if (cause.constructor?.name === "EvidenceStorageError") throw problem("EVIDENCE_RECONCILIATION_REQUIRED");
      if ((cause.code !== undefined && !cause.status) || cause instanceof TypeError || cause instanceof RangeError) {
        throw problem("EVIDENCE_RECONCILIATION_REQUIRED");
      }
      throw cause; // Existing business validation errors retain their existing contract.
    }
  }
  async function upload(operation, index, file, { recordId, evidenceType, verification = {} }) {
    assert(operation);
    const intentId = operation.intentIds[index];
    if (!intentId) throw problem("INVALID_WORKFLOW_CONTEXT");
    const context = storage.serverContext({ actor: operation.actor, recordId, evidenceType, verification });
    const input = { buffer: file.buffer, contentType: ({ jpeg: "image/jpeg", png: "image/png", webp: "image/webp" })[
      (await require("../utils/imageVerification.util").validateImageBuffer(file.buffer)).format] };
    await storage.reserve(context, input, intentId);
    return storage.upload(context, intentId, input);
  }
  async function prepareLink(tx, operation) {
    assert(operation);
    const [doc, ...intents] = await Promise.all([tx.get(operation.ref),
      ...operation.intentIds.map(id => tx.get(db.collection("evidenceUploadIntents").doc(id)))]);
    const saved = doc.data();
    if (saved?.status !== "RUNNING" || saved.leaseToken !== operation.leaseToken || saved.leaseUntil <= now()) throw problem("EVIDENCE_IN_PROGRESS", 202);
    if (intents.some(intent => intent.data()?.status !== "UPLOADED" || !intent.data()?.reference)) throw problem("EVIDENCE_LINKAGE_UNCONFIRMED");
    // This closure writes ONLY; call after all business reads, in the SAME transaction.
    return resultLink => {
      tx.update(operation.ref, { status: "COMPLETED", resultLink, leaseUntil: 0, updatedAt: now() });
      operation.intentIds.forEach(id => tx.update(db.collection("evidenceUploadIntents").doc(id), {
        status: "LINKED", linkedTo: resultLink, linkedAt: now(), updatedAt: now(),
      }));
    };
  }
  return { run, upload, prepareLink };
}
let instance;
function workflow() { return instance ||= createEvidenceWorkflow(); }
async function runWorkflow(options, perform, resolve) {
  if (!enabled()) return perform(null);
  return workflow().run(options, perform, resolve);
}
function workflowErrorResponse(res, error) {
  if (!(error instanceof EvidenceWorkflowError)) return false;
  if (error.status === 202) res.setHeader("Retry-After", "2");
  res.status(error.status).json({ success: false, code: error.code, message: error.message });
  return true;
}
module.exports = { enabled, workflow, runWorkflow, createEvidenceWorkflow, EvidenceWorkflowError,
  workflowErrorResponse, canonical, COLLECTION };
