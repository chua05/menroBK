const path = require("node:path");
const { createHash } = require("node:crypto");
const sharp = require("sharp");
const yauzl = require("yauzl");
const { Timestamp } = require("firebase-admin/firestore");
const { db, getStorageBucket } = require("../config/firebase");
const { resolveRequestLetterStorageConfig } = require("../config/requestLetterStorage");

const COLLECTION = "requestLetterUploadIntents";
const MAX_BYTES = 10 * 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");
const safeId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !value.includes("..");

class RequestLetterError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => new RequestLetterError(code, message, status);

function sanitizeName(value) {
  const name = path.basename(String(value || "")).replace(/[\r\n"\\]/g, "_").trim();
  return name.slice(0, 160) || "request-letter";
}

async function validatePdf(bytes) {
  let task;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true,
      isEvalSupported: false, useSystemFonts: false, stopEvent: true,
      maxImageSize: 25_000_000, disableFontFace: true });
    const pdf = await task.promise;
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 200) throw new Error("page-limit");
    const [scripts, attachments] = await Promise.all([pdf.getJSActions(), pdf.getAttachments()]);
    if ((scripts && Object.keys(scripts).length) || (attachments && Object.keys(attachments).length)) throw new Error("active-content");
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const annotations = await page.getAnnotations({ intent: "display" });
      if (annotations.some(item => item.url || item.unsafeUrl || item.action || item.attachment ||
          item.file || item.fileAttachment || item.subtype === "FileAttachment")) throw new Error("active-content");
      page.cleanup();
    }
    await task.destroy();
  } catch (error) {
    try { await task?.destroy(); } catch { /* best effort parser cleanup */ }
    throw fail("INVALID_REQUEST_LETTER", "The PDF is malformed, encrypted, contains active content, or exceeds safe limits.");
  }
}

function openZip(bytes) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, {
    lazyEntries: true, decodeStrings: true, validateEntrySizes: true, autoClose: false,
  }, (error, zip) => error ? reject(error) : resolve(zip)));
}

async function readZipEntry(zip, entry, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error) return reject(error);
    const chunks = []; let size = 0;
    stream.on("data", chunk => { size += chunk.length; if (size > maxBytes) stream.destroy(new Error("entry-limit")); else chunks.push(chunk); });
    stream.once("error", reject); stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  }));
}

async function validateDocx(bytes) {
  let zip;
  try {
    zip = await openZip(bytes);
    const required = new Set(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
    const xmlEntries = [];
    let count = 0, total = 0;
    await new Promise((resolve, reject) => {
      zip.once("error", reject);
      zip.once("end", resolve);
      zip.on("entry", entry => {
        count += 1; total += Number(entry.uncompressedSize || 0);
        const name = entry.fileName.replace(/\\/g, "/");
        const lower = name.toLowerCase();
        if (count > 5000 || total > 50 * 1024 * 1024 ||
            (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 100) ||
            /(^|\/)(vbaproject\.bin|activex|embeddings|customui)(\/|$)/i.test(lower) ||
            lower.endsWith(".exe") || lower.endsWith(".dll") || lower.endsWith(".js") || lower.endsWith(".vbs")) {
          reject(new Error("unsafe-package")); zip.close(); return;
        }
        required.delete(name);
        if (lower.endsWith(".xml") || lower.endsWith(".rels")) xmlEntries.push(entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
    if (required.size) throw new Error("missing-docx-parts");
    for (const entry of xmlEntries) {
      const xml = await readZipEntry(zip, entry);
      if (/TargetMode\s*=\s*["']External["']/i.test(xml) ||
          /\b(DDEAUTO|DDE|INCLUDETEXT|INCLUDEPICTURE|LINK)\b/i.test(xml) ||
          /<(?:\w+:)?(?:object|oleObject|control)\b/i.test(xml)) throw new Error("active-content");
    }
  } catch {
    throw fail("INVALID_REQUEST_LETTER", "The DOCX is malformed, macro-enabled, contains active content, or exceeds safe limits.");
  } finally { try { zip?.close(); } catch { /* already closed */ } }
}

async function validateRequestLetterFile(file) {
  if (!file?.buffer?.length || file.buffer.length > MAX_BYTES) {
    throw fail("INVALID_REQUEST_LETTER", "Select a request letter not larger than 10 MB.");
  }
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (extension === ".pdf" || file.mimetype === "application/pdf") {
    if (extension !== ".pdf" || file.mimetype !== "application/pdf" || !file.buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw fail("INVALID_REQUEST_LETTER", "The request-letter extension, type, and contents do not match.");
    await validatePdf(file.buffer);
    return { bytes: Buffer.from(file.buffer), originalName: sanitizeName(file.originalname), contentType: "application/pdf",
      sizeBytes: file.buffer.length, sha256: hash(file.buffer), format: "pdf" };
  }
  const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === ".docx" || file.mimetype === docxMime) {
    if (extension !== ".docx" || file.mimetype !== docxMime || file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b)
      throw fail("INVALID_REQUEST_LETTER", "The request-letter extension, type, and contents do not match.");
    await validateDocx(file.buffer);
    return { bytes: Buffer.from(file.buffer), originalName: sanitizeName(file.originalname), contentType: docxMime,
      sizeBytes: file.buffer.length, sha256: hash(file.buffer), format: "docx" };
  }
  if (![".jpg", ".jpeg", ".png"].includes(extension) || !["image/jpeg", "image/png"].includes(file.mimetype)) {
    throw fail("INVALID_REQUEST_LETTER", "Only PDF, JPEG, PNG, or DOCX request letters are accepted.");
  }
  let metadata;
  try { metadata = await sharp(file.buffer, { failOn: "error", limitInputPixels: 40_000_000 }).metadata(); }
  catch { throw fail("INVALID_REQUEST_LETTER", "The selected request letter is not a valid image."); }
  const contentType = metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "png" ? "image/png" : "";
  if (!contentType || contentType !== file.mimetype ||
      (contentType === "image/jpeg" && ![".jpg", ".jpeg"].includes(extension)) ||
      (contentType === "image/png" && extension !== ".png")) {
    throw fail("INVALID_REQUEST_LETTER", "The request-letter extension, type, and contents do not match.");
  }
  return { bytes: Buffer.from(file.buffer), originalName: sanitizeName(file.originalname),
    contentType, sizeBytes: file.buffer.length, sha256: hash(file.buffer), format: metadata.format };
}

function publicMetadata(descriptor) {
  if (!descriptor) return null;
  return { storageStatus: "private_v1", originalName: descriptor.originalName,
    contentType: descriptor.contentType, sizeBytes: descriptor.sizeBytes,
    uploadedAt: descriptor.uploadedAt || null };
}

async function uploadRequestLetter({ requestId, participantId, clientSubmissionId, file }) {
  const config = resolveRequestLetterStorageConfig();
  if (!config.enabled) throw fail("REQUEST_LETTER_STORAGE_DISABLED", "Request-letter upload is temporarily unavailable.", 503);
  if (!safeId(requestId) || !safeId(participantId) || !clientSubmissionId) throw fail("INVALID_REQUEST_LETTER", "Invalid request-letter upload context.");
  const validated = await validateRequestLetterFile(file);
  const intentId = hash(`${participantId}:${clientSubmissionId}:request-letter`).slice(0, 40);
  const objectName = `request-letters/v1/${requestId}/${intentId}`;
  const ref = db.collection(COLLECTION).doc(intentId);
  const existing = await ref.get();
  if (existing.exists && (existing.data().requestId !== requestId || existing.data().participantId !== participantId ||
      existing.data().sha256 !== validated.sha256)) throw fail("REQUEST_LETTER_CONFLICT", "This submission key was already used with another request letter.", 409);
  const bucket = await getStorageBucket();
  if (bucket.name !== config.storage.bucket) throw fail("REQUEST_LETTER_STORAGE_UNAVAILABLE", "Request-letter storage is unavailable.", 503);
  const object = bucket.file(objectName);
  const metadataMatches = metadata => metadata?.generation &&
    String(metadata.size) === String(validated.sizeBytes) && metadata.contentType === validated.contentType &&
    metadata.cacheControl === "private, no-store" && metadata.metadata?.sha256 === validated.sha256 &&
    !metadata.metadata?.firebaseStorageDownloadTokens &&
    !metadata.acl?.some(entry => ["allUsers", "allAuthenticatedUsers"].includes(entry.entity));
  const descriptorFrom = metadata => ({ provider: "firebase", storageVersion: 1, bucket: bucket.name, objectName,
    generation: String(metadata.generation), uploadIntentId: intentId, originalName: validated.originalName,
    contentType: validated.contentType, sizeBytes: validated.sizeBytes, sha256: validated.sha256,
    uploadedAt: metadata.timeCreated || null });
  const reuseExistingObject = async () => {
    try {
      const [metadata] = await object.getMetadata();
      if (!metadataMatches(metadata)) throw fail("REQUEST_LETTER_INTEGRITY_FAILED", "Request-letter upload could not be verified.", 503);
      const descriptor = descriptorFrom(metadata);
      const snapshot = await ref.get();
      if (snapshot.data()?.status !== "LINKED") await ref.set({ status: "UPLOADED", generation: descriptor.generation,
        descriptor, uploadedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
      return descriptor;
    } catch (error) {
      if (Number(error.code) === 404) return null;
      throw error;
    }
  };
  if (existing.exists) {
    const descriptor = await reuseExistingObject();
    if (descriptor) return descriptor;
  } else {
    try {
      await ref.create({ schemaVersion: 1, intentId, requestId, participantId,
        objectName, bucket: bucket.name, originalName: validated.originalName, contentType: validated.contentType,
        sizeBytes: validated.sizeBytes, sha256: validated.sha256, format: validated.format, status: "UPLOADING",
        retentionPolicy: "retain-no-automatic-deletion-v1", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
    } catch (error) {
      if (Number(error.code) !== 6) throw error;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const descriptor = await reuseExistingObject();
        if (descriptor) return descriptor;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw fail("REQUEST_LETTER_STORAGE_UNAVAILABLE", "Request-letter upload is still being confirmed. Retry with the same submission.", 503);
    }
  }
  try {
    await object.save(validated.bytes, { resumable: false, validation: "crc32c",
      preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: validated.contentType,
        cacheControl: "private, no-store", metadata: { schemaVersion: "1", uploadIntentId: intentId,
          requestScope: hash(requestId), actorScope: hash(participantId), sha256: validated.sha256 } } });
  } catch (error) { if (Number(error.code) !== 412) {
    await ref.set({ status: "RECONCILIATION_REQUIRED", updatedAt: Timestamp.now() }, { merge: true });
    throw fail("REQUEST_LETTER_STORAGE_UNAVAILABLE", "Request-letter upload could not be confirmed. Retry with the same submission.", 503);
  } }
  let metadata;
  try { [metadata] = await object.getMetadata(); } catch {
    await ref.set({ status: "RECONCILIATION_REQUIRED", updatedAt: Timestamp.now() }, { merge: true });
    throw fail("REQUEST_LETTER_STORAGE_UNAVAILABLE", "Request-letter upload could not be confirmed. Retry with the same submission.", 503);
  }
  if (!metadataMatches(metadata)) {
    await ref.set({ status: "RECONCILIATION_REQUIRED", updatedAt: Timestamp.now() }, { merge: true });
    throw fail("REQUEST_LETTER_INTEGRITY_FAILED", "Request-letter upload could not be verified.", 503);
  }
  const descriptor = descriptorFrom(metadata);
  await ref.set({ status: "UPLOADED", generation: descriptor.generation, descriptor,
    uploadedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
  return descriptor;
}

async function linkRequestLetterInTransaction(transaction, descriptor, requestId, participantId) {
  if (!descriptor) return;
  const ref = db.collection(COLLECTION).doc(descriptor.uploadIntentId);
  const doc = await transaction.get(ref);
  const row = doc.data();
  if (!doc.exists || row.status !== "UPLOADED" || row.requestId !== requestId || row.participantId !== participantId ||
      row.sha256 !== descriptor.sha256) throw fail("REQUEST_LETTER_INTEGRITY_FAILED", "Request-letter linkage could not be verified.", 503);
  transaction.update(ref, { status: "LINKED", linkedAt: Timestamp.now(), updatedAt: Timestamp.now() });
}

async function streamRequestLetter(descriptor, response) {
  const config = resolveRequestLetterStorageConfig();
  if (!config.storage.cloudRead) throw fail("REQUEST_LETTER_NOT_FOUND", "Request letter not found.", 404);
  const bucket = await getStorageBucket();
  if (!descriptor || bucket.name !== descriptor.bucket || !descriptor.objectName?.startsWith("request-letters/v1/"))
    throw fail("REQUEST_LETTER_NOT_FOUND", "Request letter not found.", 404);
  const object = bucket.file(descriptor.objectName, { generation: descriptor.generation });
  const [metadata] = await object.getMetadata();
  if (String(metadata.generation) !== descriptor.generation || String(metadata.size) !== String(descriptor.sizeBytes) ||
      metadata.metadata?.sha256 !== descriptor.sha256) throw fail("REQUEST_LETTER_INTEGRITY_FAILED", "Request letter is unavailable.", 503);
  response.setHeader("Content-Type", descriptor.contentType);
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  response.setHeader("Content-Disposition", `attachment; filename="${sanitizeName(descriptor.originalName)}"`);
  return new Promise((resolve, reject) => object.createReadStream().once("error", reject).once("end", resolve).pipe(response));
}

module.exports = { COLLECTION, RequestLetterError, validateRequestLetterFile, uploadRequestLetter,
  linkRequestLetterInTransaction, streamRequestLetter, publicMetadata };
