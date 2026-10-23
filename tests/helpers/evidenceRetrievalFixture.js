const { randomUUID, createHash } = require("node:crypto");
const { Readable, Writable } = require("node:stream");
const sharp = require("sharp");
const { createFirebaseEvidenceRetrieval } = require("../../src/services/firebaseEvidenceRetrieval.service");
const hash = data => createHash("sha256").update(data).digest("hex");
const demoEnv = { MENRO_INTEGRATION_TEST: "true", NODE_ENV: "test", GCLOUD_PROJECT: "demo-menro-phase2",
  FIREBASE_PROJECT_ID: "demo-menro-phase2", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199",
  FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app", EVIDENCE_STORAGE_PROVIDER: "local",
  EVIDENCE_CLOUD_READ_ENABLED: "true" };
async function fixture({ format = "jpeg", timeoutMs = 2000, maxConcurrent = 3, buffer } = {}) {
  buffer ||= await sharp({ create: { width: 13, height: 13, channels: 3, background: "green" } }).toFormat(format).toBuffer();
  const type = "monitoring-official", recordId = `record-${randomUUID()}`, intentId = randomUUID();
  const reference = { provider: "firebase", storageVersion: 1, bucket: demoEnv.FIREBASE_STORAGE_BUCKET,
    objectName: `evidence/v1/${type}/${recordId}/${intentId}`, generation: "1800000000000001", contentType: `image/${format}`,
    format, sizeBytes: buffer.length, sha256: hash(buffer), uploadIntentId: intentId, uploadedAt: "2026-10-20T00:00:00Z" };
  const metadata = { name: reference.objectName, bucket: reference.bucket, generation: reference.generation,
    size: String(buffer.length), contentType: reference.contentType, cacheControl: "private, no-store",
    metadata: { schemaVersion: "1", uploadIntentId: intentId, evidenceType: type,
      recordScope: hash(recordId), actorScope: hash("synthetic-actor"), sha256: reference.sha256 } };
  const faults = {}, stats = { calls: [], streams: [], peakSourceBytes: 0 };
  const bucket = { name: reference.bucket, storage: { apiEndpoint: "http://127.0.0.1:9199" }, file(name) {
    const file = { interceptors: [], requestStream(options) {
      options = file.interceptors.reduce((value, interceptor) => interceptor.request(value), options);
      stats.calls.push({ name, options });
      const media = options.qs.alt === "media";
      const bytes = media ? faults.bytes || buffer : Buffer.from(JSON.stringify(metadata));
      let offset = 0, responded = false;
      const stream = new Readable({ highWaterMark: 64 * 1024, read() {
        if (!responded) {
          if ((!media && faults.metadataHang) || (media && faults.mediaHangBeforeResponse)) return;
          responded = true;
          this.emit("response", { statusCode: media ? faults.mediaStatus || 200 : faults.metadataStatus || 200,
            headers: media ? { "content-type": faults.responseType || metadata.contentType,
              "x-goog-generation": faults.responseGeneration || metadata.generation,
              ...(faults.responseLength === undefined ? {} : { "content-length": faults.responseLength }),
              "content-disposition": `attachment; filename=${reference.objectName}` } : {} });
        }
        if (this.destroyed || (media && faults.mediaHang)) return;
        if (media && faults.mediaErrorAt !== undefined && offset >= faults.mediaErrorAt) {
          this.destroy(Object.assign(Error(`private bucket ${reference.objectName}`), { code: "ECONNRESET" })); return;
        }
        if (offset === bytes.length) { this.push(null); return; }
        const chunk = bytes.subarray(offset, offset + 64 * 1024); offset += chunk.length;
        this.push(chunk);
        stats.peakSourceBytes = Math.max(stats.peakSourceBytes, this.readableLength);
        if (media) faults.onMediaChunk?.();
      } });
      // Match the SDK's legacy duplexify GET stream, not just a modern Readable.
      const legacy = require("duplexify")();
      stream.on("response", response => legacy.emit("response", response));
      queueMicrotask(() => legacy.setReadable(stream)); // Real SDK response follows asynchronous request setup.
      stats.streams.push(stream, legacy); return legacy;
    } };
    return file;
  } };
  const service = createFirebaseEvidenceRetrieval({ getBucket: () => bucket, timeoutMs, maxConcurrent, log() {} });
  const context = () => ({ reference, evidenceType: type, recordId });
  return { ...service, buffer, reference, metadata, faults, stats, bucket, context,
    token: () => service.serverResolvedEvidence(context()) };
}
function sink({ delay = 0, discard = false, failAfter = Infinity } = {}) {
  const headers = {}, chunks = [];
  let bytes = 0, peak = 0;
  const output = new Writable({ highWaterMark: 32 * 1024, write(chunk, encoding, callback) {
    bytes += chunk.length; peak = Math.max(peak, this.writableLength);
    if (!discard) chunks.push(Buffer.from(chunk));
    const error = bytes >= failAfter ? Error("private downstream failure") : null;
    if (delay) setTimeout(() => callback(error), delay); else callback(error);
  } });
  output.setHeader = (key, value) => { headers[key] = value; };
  return { output, headers, bytes: () => bytes, peak: () => peak, data: () => Buffer.concat(chunks) };
}
module.exports = { fixture, sink, demoEnv, hash };
