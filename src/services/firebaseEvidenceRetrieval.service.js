// Phase 4 INTERNAL infrastructure only. Call after business-record authorization.
// No routes, credentials, signed URLs, upload writes, quota changes or object deletion.
const { createHash } = require("node:crypto");
const { Transform, PassThrough } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveEvidenceStorageConfig } = require("../config/evidenceStorage");
const { matchesEvidenceObject } = require('../config/developmentGcs');

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = new Set(["planting-report", "planting-contribution", "monitoring-early", "monitoring-official"]);
const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const sha = value => createHash("sha256").update(value).digest("hex");
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !value.includes("..");
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const onlyKeys = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => keys.includes(key));
class EvidenceRetrievalError extends Error {
  constructor(code) { super(`Private evidence retrieval failed (${code}).`); this.code = code; }
}
const failure = code => new EvidenceRetrievalError(code);
function guard() {
  const config = resolveEvidenceStorageConfig();
  if ((!config.storageEmulator && !config.gcsDevelopment && !config.gcsProduction) || !config.cloudRead) throw failure("RETRIEVAL_EMULATOR_REQUIRED");
}
function safeError(error, delivering = false) {
  if (error instanceof EvidenceRetrievalError) return error;
  if (Number(error?.code) === 404) return failure("EVIDENCE_NOT_FOUND");
  if ([401, 403].includes(Number(error?.code))) return failure("EVIDENCE_STORAGE_FORBIDDEN");
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(error?.code)) return failure("EVIDENCE_TIMEOUT");
  return failure(delivering ? "EVIDENCE_DELIVERY_FAILED" : "EVIDENCE_STORAGE_UNAVAILABLE");
}
function imageSignature(bytes, format) {
  if (format === "jpeg") return bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (format === "png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}
function validateResolved(input) {
  if (!onlyKeys(input, ["reference", "evidenceType", "recordId"]) || !TYPES.has(input.evidenceType) || !identifier(input.recordId)) {
    throw failure("INVALID_EVIDENCE_CONTEXT");
  }
  const ref = input.reference;
  if (!onlyKeys(ref, ["provider", "storageVersion", "bucket", "objectName", "generation", "contentType", "format",
    "sizeBytes", "sha256", "uploadIntentId", "uploadedAt"]) || ref.provider !== "firebase") throw failure("INVALID_EVIDENCE_REFERENCE");
  const config = resolveEvidenceStorageConfig();
  if (ref.storageVersion !== 1 || ref.bucket !== config.bucket || !uuid(ref.uploadIntentId) ||
      !matchesEvidenceObject(config, ref.objectName, `evidence/v1/${input.evidenceType}/${input.recordId}/${ref.uploadIntentId}`) ||
      typeof ref.generation !== "string" || !/^[1-9]\d{0,19}$/.test(ref.generation) || BigInt(ref.generation) > 18446744073709551615n ||
      !Object.hasOwn(MIME, ref.format) || ref.contentType !== MIME[ref.format] ||
      !Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 1 || ref.sizeBytes > MAX_BYTES ||
      typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      (ref.uploadedAt !== undefined && ref.uploadedAt !== null && (typeof ref.uploadedAt !== "string" ||
        ref.uploadedAt.length > 64 || !Number.isFinite(Date.parse(ref.uploadedAt))))) throw failure("INVALID_EVIDENCE_REFERENCE");
  return Object.freeze({ reference: Object.freeze({ ...ref }), evidenceType: input.evidenceType, recordId: input.recordId });
}
function validateMetadata(metadata, context) {
  const ref = context.reference;
  if (String(metadata?.generation) !== ref.generation) throw failure("EVIDENCE_GENERATION_MISMATCH");
  if (String(metadata.size) !== String(ref.sizeBytes)) throw failure("EVIDENCE_SIZE_MISMATCH");
  if (metadata.contentType !== ref.contentType || (metadata.contentEncoding && metadata.contentEncoding !== "identity")) {
    throw failure("EVIDENCE_CONTENT_TYPE_MISMATCH");
  }
  const custom = metadata.metadata;
  if (metadata.name !== ref.objectName || metadata.bucket !== ref.bucket || metadata.cacheControl !== "private, no-store" ||
      custom?.schemaVersion !== "1" || custom?.uploadIntentId !== ref.uploadIntentId ||
      custom?.evidenceType !== context.evidenceType || custom?.recordScope !== sha(context.recordId) ||
      custom?.sha256 !== ref.sha256 || typeof custom?.actorScope !== "string" || !/^[a-f0-9]{64}$/.test(custom.actorScope) ||
      Object.hasOwn(custom, "firebaseStorageDownloadTokens") ||
      metadata.acl?.some(acl => ["allUsers", "allAuthenticatedUsers"].includes(acl.entity))) throw failure("EVIDENCE_METADATA_MISMATCH");
}

function createFirebaseEvidenceRetrieval({ getBucket, timeoutMs = 30_000, maxConcurrent = 3,
  log = event => console.warn("[evidence-retrieval]", event) } = {}) {
  guard();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw failure("INVALID_RETRIEVAL_LIMITS");
  getBucket ||= require("../config/firebase").getStorageBucket;
  const capabilities = new WeakMap();
  let active = 0;
  function serverResolvedEvidence(input) {
    guard();
    const context = validateResolved(input), token = Object.freeze({});
    capabilities.set(token, context); return token;
  }
  async function streamTo(token, destination, { signal } = {}) {
    guard();
    const context = capabilities.get(token);
    if (!context) throw failure("INVALID_EVIDENCE_CONTEXT");
    if (!destination || typeof destination.write !== "function" || typeof destination.end !== "function" ||
        typeof destination.on !== "function" || typeof destination.setHeader !== "function" || destination.headersSent ||
        (signal !== undefined && !(signal instanceof AbortSignal))) throw failure("INVALID_EVIDENCE_DESTINATION");
    if (active >= maxConcurrent) throw failure("EVIDENCE_RETRIEVAL_BUSY");
    active++;
    const controller = new AbortController(), upstreams = new Set();
    let directory, stagingPath, delivering = false;
    const stop = code => { if (!controller.signal.aborted) controller.abort(failure(code)); };
    const onAbort = () => stop("CLIENT_DISCONNECTED");
    const onClose = () => { if (!destination.writableFinished) onAbort(); };
    const cancelUpstreams = () => { for (const stream of upstreams) stream.destroy(controller.signal.reason); };
    controller.signal.addEventListener("abort", cancelUpstreams, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    destination.on("close", onClose); destination.on("error", onAbort);
    const timer = setTimeout(() => stop("EVIDENCE_TIMEOUT"), timeoutMs);
    const throwIfAborted = () => { if (controller.signal.aborted) throw controller.signal.reason; };
    try {
      if (signal?.aborted || destination.destroyed || destination.writableEnded) onAbort();
      throwIfAborted();
      const bucket = await getBucket(), config = resolveEvidenceStorageConfig();
      guard(); // Recheck read enablement after awaiting the keyless client.
      if (bucket.name !== context.reference.bucket || bucket.name !== config.bucket || !bucket.storage ||
          String(bucket.storage.apiEndpoint).replace(/\/$/, "") !==
          ((config.gcsDevelopment || config.gcsProduction) ? 'https://storage.googleapis.com' : "http://127.0.0.1:9199")) {
        throw failure("RETRIEVAL_EMULATOR_REQUIRED");
      }
      // Use the guarded Admin SDK File transport, keeping the uint64 generation a STRING.
      // File({generation}) in SDK 8.4.0 coerces it to Number and can round large values.
      const ref = context.reference, file = bucket.file(ref.objectName);
      if (!Array.isArray(file.interceptors) || typeof file.requestStream !== "function") throw failure("EVIDENCE_STORAGE_UNAVAILABLE");
      // This File is operation-local. Never mutate the shared Storage client's retry policy.
      file.interceptors.push({ request: options => ({ ...options, maxRetries: 0, timeout: timeoutMs }) });
      function request(media) {
        throwIfAborted();
        const sdkStream = file.requestStream({ method: "GET", uri: "", maxRetries: 0, timeout: timeoutMs,
          qs: { generation: ref.generation, ...(media ? { alt: "media" } : {}) },
          headers: { "Accept-Encoding": "identity", "Cache-Control": "no-store" } });
        // SDK returns an older duplexify stream: its async iterator can wait forever
        // for an unused writable side after GET end. Bridge to native Node streams.
        const stream = new PassThrough({ highWaterMark: 64 * 1024 });
        let sdkEnded = false;
        upstreams.add(stream); upstreams.add(sdkStream);
        sdkStream.on("error", error => stream.destroy(error));
        sdkStream.once("end", () => { sdkEnded = true; });
        sdkStream.once("close", () => { if (!sdkEnded && !stream.destroyed) stream.destroy(failure("EVIDENCE_STORAGE_UNAVAILABLE")); });
        stream.once("close", () => {
          try { if (!sdkEnded && typeof sdkStream.abort === "function") sdkStream.abort(); }
          catch { /* Still destroy the request below; never surface an abort SDK error. */ }
          sdkStream.destroy();
        });
        stream.on("error", () => {}); // The iterator/pipeline below handles the sanitized error.
        let sawResponse = false;
        sdkStream.on("response", response => {
          sawResponse = true;
          const status = response.statusCode;
          if (status !== 200) {
            stream.destroy(failure(status === 404 ? "EVIDENCE_NOT_FOUND" : [401, 403].includes(status)
              ? "EVIDENCE_STORAGE_FORBIDDEN" : "EVIDENCE_STORAGE_UNAVAILABLE")); return;
          }
          if (!media) return;
          const headers = response.headers || {};
          if (String(headers["x-goog-generation"]) !== ref.generation) stream.destroy(failure("EVIDENCE_GENERATION_MISMATCH"));
          else if (headers["content-type"] !== ref.contentType || (headers["content-encoding"] && headers["content-encoding"] !== "identity")) {
            stream.destroy(failure("EVIDENCE_CONTENT_TYPE_MISMATCH"));
          } else if (headers["content-length"] !== undefined && String(headers["content-length"]) !== String(ref.sizeBytes)) {
            stream.destroy(failure("EVIDENCE_SIZE_MISMATCH"));
          }
        });
        sdkStream.pipe(stream);
        return { stream, assertResponse() { if (!sawResponse) throw failure("EVIDENCE_STORAGE_UNAVAILABLE"); } };
      }
      const metadataRequest = request(false), chunks = [];
      let metadataBytes = 0;
      for await (const chunk of metadataRequest.stream) {
        metadataBytes += chunk.length;
        if (metadataBytes > 64 * 1024) throw failure("EVIDENCE_METADATA_MISMATCH");
        chunks.push(chunk);
      }
      metadataRequest.assertResponse();
      let metadata;
      try { metadata = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("EVIDENCE_METADATA_MISMATCH"); }
      validateMetadata(metadata, context); throwIfAborted();
      directory = await fsp.mkdtemp(path.join(os.tmpdir(), "menro-evidence-read-"));
      stagingPath = path.join(directory, "verified-image");
      throwIfAborted();
      const digest = createHash("sha256");
      let size = 0, prefix = Buffer.alloc(0);
      const verifier = new Transform({ highWaterMark: 64 * 1024, transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > ref.sizeBytes || size > MAX_BYTES) { callback(failure("EVIDENCE_SIZE_MISMATCH")); return; }
        if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
        digest.update(chunk); callback(null, chunk);
      } });
      const mediaRequest = request(true);
      await pipeline(mediaRequest.stream, verifier,
        fs.createWriteStream(stagingPath, { flags: "wx", mode: 0o600, highWaterMark: 64 * 1024 }), { signal: controller.signal });
      mediaRequest.assertResponse();
      if (size !== ref.sizeBytes) throw failure("EVIDENCE_SIZE_MISMATCH");
      if (digest.digest("hex") !== ref.sha256) throw failure("EVIDENCE_CHECKSUM_MISMATCH");
      if (!imageSignature(prefix, ref.format)) throw failure("EVIDENCE_CONTENT_TYPE_MISMATCH");
      throwIfAborted();
      guard(); // Environment cannot change a staged operation into an activated cloud response.
      destination.setHeader("Content-Type", ref.contentType);
      destination.setHeader("Content-Length", String(size));
      destination.setHeader("Cache-Control", "private, no-store");
      destination.setHeader("X-Content-Type-Options", "nosniff");
      delivering = true;
      await pipeline(fs.createReadStream(stagingPath, { highWaterMark: 64 * 1024 }), destination, { signal: controller.signal });
      return { contentType: ref.contentType, sizeBytes: size, generation: ref.generation };
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : safeError(error, delivering);
    } finally {
      clearTimeout(timer);
      for (const stream of upstreams) stream.destroy();
      controller.signal.removeEventListener("abort", cancelUpstreams);
      signal?.removeEventListener("abort", onAbort);
      destination.removeListener("close", onClose); destination.removeListener("error", onAbort);
      try {
        if (stagingPath) await fsp.unlink(stagingPath).catch(error => { if (error.code !== "ENOENT") throw error; });
        if (directory) await fsp.rmdir(directory);
      } catch {
        try { log({ operation: "private_evidence_retrieval", category: "STAGING_CLEANUP_FAILED" }); } catch { /* no private details */ }
      }
      active--;
    }
  }
  return { serverResolvedEvidence, streamTo };
}
module.exports = { createFirebaseEvidenceRetrieval, EvidenceRetrievalError };
