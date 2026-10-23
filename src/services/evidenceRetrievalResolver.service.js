// Internal Phase 4 dispatcher, NOT wired to any route. Selectors never carry paths/references.
const path = require("node:path");
const { createFirebaseEvidenceRetrieval, EvidenceRetrievalError } = require("./firebaseEvidenceRetrieval.service");
const error = code => new EvidenceRetrievalError(code);
const keys = {
  planting: ["kind", "recordId", "photoIndex"],
  monitoring: ["kind", "recordId", "entryIndex"],
  "monitoring-revision": ["kind", "recordId", "observationId", "revisionNumber"],
};
function selectorValid(input) {
  return input && Object.getPrototypeOf(input) === Object.prototype && Object.hasOwn(keys, input.kind) &&
    Object.keys(input).every(key => keys[input.kind].includes(key)) &&
    typeof input.recordId === "string" && input.recordId.length > 0 && input.recordId.length <= 128 && !input.recordId.includes("/");
}
async function existingLegacyAuthorization(selector, user) {
  // Lazy import: legacy dispatch never initializes Firebase Storage or duplicates RBAC.
  const access = require("./evidenceAccess.service");
  let evidence;
  if (selector.kind === "planting") evidence = await access.plantingEvidenceForUser(selector.recordId, selector.photoIndex, user);
  else if (selector.kind === "monitoring") evidence = await access.monitoringEvidenceForUser(selector.recordId, selector.entryIndex, user);
  else evidence = await access.monitoringRevisionEvidenceForUser(selector.recordId, selector.observationId, selector.revisionNumber, user);
  return { provider: "local", evidence };
}
function createEvidenceRetrievalResolver({ authorizeAndResolve = existingLegacyAuthorization, cloud } = {}) {
  if (typeof authorizeAndResolve !== "function") throw error("INVALID_EVIDENCE_CONTEXT");
  // Phase 5 must supply a TRUSTED business resolver that authorizes the exact saved
  // report/observation/revision and returns its saved reference and expected context.
  // Never replace this with req.body, a path-ownership test or a client reference.
  async function resolve(selector, authenticatedUser) {
    if (!selectorValid(selector)) throw error("INVALID_EVIDENCE_CONTEXT");
    if (!authenticatedUser || typeof authenticatedUser.uid !== "string" || !authenticatedUser.uid) throw error("EVIDENCE_FORBIDDEN");
    try {
      const result = await authorizeAndResolve(Object.freeze({ ...selector }), authenticatedUser);
      if (!result) throw error("EVIDENCE_NOT_FOUND");
      const provider = result.provider ?? result.reference?.provider ?? "local";
      if (provider === "firebase") {
        // Explicit cloud records NEVER reach the local resolver, even on validation/404 failures.
        cloud ||= createFirebaseEvidenceRetrieval();
        const token = cloud.serverResolvedEvidence({ reference: result.reference,
          evidenceType: result.evidenceType, recordId: result.recordId });
        return Object.freeze({ provider: "firebase", streamTo: (destination, options) => cloud.streamTo(token, destination, options) });
      }
      if (provider !== "local" || (result.reference && typeof result.reference === "object" && result.reference.provider !== "local")) {
        throw error("UNSUPPORTED_EVIDENCE_PROVIDER");
      }
      const evidence = result.evidence;
      if (!evidence || typeof evidence.absolutePath !== "string" || !path.isAbsolute(evidence.absolutePath) ||
          !["image/jpeg", "image/png", "image/webp"].includes(evidence.contentType)) throw error("INVALID_EVIDENCE_REFERENCE");
      // Keep the existing, already-authorized descriptor for the existing sendFile implementation.
      return Object.freeze({ provider: "local", evidence: Object.freeze({ absolutePath: evidence.absolutePath, contentType: evidence.contentType }) });
    } catch (cause) {
      if (cause instanceof EvidenceRetrievalError) throw cause;
      if (cause?.code === "EVIDENCE_FORBIDDEN") throw error("EVIDENCE_FORBIDDEN");
      if (["EVIDENCE_NOT_FOUND", "INVALID_EVIDENCE_PATH"].includes(cause?.code) ||
          ["Planting report not found.", "Monitoring record not found."].includes(cause?.message)) throw error("EVIDENCE_NOT_FOUND");
      throw error("EVIDENCE_RESOLUTION_FAILED");
    }
  }
  return { resolve };
}
module.exports = { createEvidenceRetrievalResolver };
