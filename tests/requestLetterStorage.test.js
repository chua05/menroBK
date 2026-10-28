const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const yazl = require("yazl");
const { validateRequestLetterFile } = require("../src/services/requestLetterStorage.service");
const { resolveRequestLetterStorageConfig } = require("../src/config/requestLetterStorage");

test("request-letter storage is disabled by default", () => {
  const config = resolveRequestLetterStorageConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.required, false);
});

test("request-letter upload availability and enforcement use separate fail-closed gates", () => {
  const storageEnv = {
    MENRO_INTEGRATION_TEST: "true",
    MENRO_REQUEST_LETTER_ACCEPTANCE: "true",
    GCLOUD_PROJECT: "demo-menro-phase2",
    FIREBASE_PROJECT_ID: "demo-menro-phase2",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8181",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199",
    FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app",
    EVIDENCE_STORAGE_PROVIDER: "firebase",
    EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true",
    EVIDENCE_CLOUD_READ_ENABLED: "true",
    REQUEST_LETTER_STORAGE_ENABLED: "true",
  };
  const transition = resolveRequestLetterStorageConfig(storageEnv);
  assert.equal(transition.enabled, true);
  assert.equal(transition.required, false);
  const enforced = resolveRequestLetterStorageConfig({
    ...storageEnv,
    REQUEST_LETTER_STORAGE_REQUIRED: "true",
  });
  assert.equal(enforced.required, true);
  assert.throws(
    () => resolveRequestLetterStorageConfig({ REQUEST_LETTER_STORAGE_REQUIRED: "true" }),
    /must be enabled before secure uploads are required/,
  );
  assert.throws(
    () => resolveRequestLetterStorageConfig({ REQUEST_LETTER_STORAGE_REQUIRED: "TRUE" }),
    /Invalid request-letter requirement gate/,
  );
});

test("request-letter image validation checks bytes, MIME, extension and size", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  const valid = await validateRequestLetterFile({ buffer: png, originalname: "letter.png", mimetype: "image/png" });
  assert.equal(valid.contentType, "image/png");
  assert.equal(valid.sizeBytes, png.length);
  await assert.rejects(() => validateRequestLetterFile({ buffer: png, originalname: "letter.jpg", mimetype: "image/jpeg" }), /do not match/);
  await assert.rejects(() => validateRequestLetterFile({ buffer: Buffer.from("not an image"), originalname: "letter.png", mimetype: "image/png" }), /not a valid image/);
  await assert.rejects(() => validateRequestLetterFile({ buffer: Buffer.alloc(10 * 1024 * 1024 + 1), originalname: "letter.png", mimetype: "image/png" }), /not larger than 10 MB/);
});

function docx(entries = {}) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile(), chunks = [];
    const defaults = {
      "[Content_Types].xml": "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
      "_rels/.rels": "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"officeDocument\" Target=\"word/document.xml\"/></Relationships>",
      "word/document.xml": "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p/></w:body></w:document>",
      ...entries,
    };
    Object.entries(defaults).forEach(([name, value]) => zip.addBuffer(Buffer.from(value), name));
    zip.outputStream.on("data", chunk => chunks.push(chunk));
    zip.outputStream.once("error", reject); zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

test("validates structurally safe PDF and DOCX documents", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  const pdfBytes = Buffer.from(await pdf.save());
  assert.equal((await validateRequestLetterFile({ buffer: pdfBytes, originalname: "letter.pdf", mimetype: "application/pdf" })).format, "pdf");
  const docxBytes = await docx();
  assert.equal((await validateRequestLetterFile({ buffer: docxBytes, originalname: "letter.docx",
    mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).format, "docx");
});

test("rejects malformed PDF and active or macro-enabled DOCX", async () => {
  await assert.rejects(() => validateRequestLetterFile({ buffer: Buffer.from("%PDF-1.7\n%%EOF"),
    originalname: "letter.pdf", mimetype: "application/pdf" }), /malformed, encrypted, contains active content/);
  const external = await docx({ "word/_rels/document.xml.rels":
    "<Relationships><Relationship TargetMode=\"External\" Target=\"https://example.invalid\"/></Relationships>" });
  await assert.rejects(() => validateRequestLetterFile({ buffer: external, originalname: "letter.docx",
    mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), /macro-enabled, contains active content/);
  const macro = await docx({ "word/vbaProject.bin": "unsafe" });
  await assert.rejects(() => validateRequestLetterFile({ buffer: macro, originalname: "letter.docx",
    mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), /macro-enabled, contains active content/);
});
