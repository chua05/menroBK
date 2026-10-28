const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const yazl = require("yazl");

Object.assign(process.env, {
  NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", MENRO_REQUEST_LETTER_ACCEPTANCE: "true",
  GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8181", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app",
  EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true",
  EVIDENCE_CLOUD_READ_ENABLED: "true", REQUEST_LETTER_STORAGE_ENABLED: "true", REQUEST_LETTER_STORAGE_REQUIRED: "true",
});
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"])
  delete process.env[key];

const { db, getStorageBucket } = require("../../src/config/firebase");
const { uploadRequestLetter, linkRequestLetterInTransaction, COLLECTION } =
  require("../../src/services/requestLetterStorage.service");
let persistedObjectName;

const docx = () => new Promise((resolve, reject) => {
  const zip = new yazl.ZipFile(), chunks = [];
  const entries = {
    "[Content_Types].xml": "<Types><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
    "_rels/.rels": "<Relationships><Relationship Id=\"rId1\" Target=\"word/document.xml\"/></Relationships>",
    "word/document.xml": "<w:document xmlns:w=\"x\"><w:body><w:p/></w:body></w:document>",
  };
  Object.entries(entries).forEach(([name, value]) => zip.addBuffer(Buffer.from(value), name));
  zip.outputStream.on("data", chunk => chunks.push(chunk)); zip.outputStream.once("error", reject);
  zip.outputStream.once("end", () => resolve(Buffer.concat(chunks))); zip.end();
});

async function fixtures() {
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  return [
    ["letter.pdf", "application/pdf", Buffer.from(await pdf.save())],
    ["letter.jpg", "image/jpeg", await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).jpeg().toBuffer()],
    ["letter.png", "image/png", await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer()],
    ["letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await docx()],
  ];
}

test("persists and links PDF, JPEG, PNG and DOCX privately in the Storage emulator", async () => {
  const bucket = await getStorageBucket();
  for (const [index, [name, mimetype, buffer]] of (await fixtures()).entries()) {
    const suffix = crypto.randomUUID(), requestId = `request-${suffix}`, participantId = `participant-${suffix}`;
    const descriptor = await uploadRequestLetter({ requestId, participantId,
      clientSubmissionId: `submission-${suffix}`, file: { originalname: name, mimetype, buffer } });
    persistedObjectName ||= descriptor.objectName;
    assert.match(descriptor.objectName, new RegExp(`^request-letters/v1/${requestId}/`));
    assert.equal(descriptor.sha256, crypto.createHash("sha256").update(buffer).digest("hex"));
    assert.equal(descriptor.sizeBytes, buffer.length); assert.equal(descriptor.contentType, mimetype);
    const [metadata] = await bucket.file(descriptor.objectName).getMetadata();
    assert.equal(String(metadata.generation), descriptor.generation);
    assert.equal(metadata.cacheControl, "private, no-store");
    assert.equal(metadata.metadata.sha256, descriptor.sha256);
    assert.equal(metadata.metadata.firebaseStorageDownloadTokens, undefined);
    const requestRef = db.collection("seedlingRequests").doc(requestId);
    await db.runTransaction(async transaction => {
      await linkRequestLetterInTransaction(transaction, descriptor, requestId, participantId);
      transaction.create(requestRef, { participantId, requestLetter: { privateDocument: descriptor }, formatIndex: index });
    });
    assert.equal((await requestRef.get()).data().requestLetter.privateDocument.sha256, descriptor.sha256);
    assert.equal((await db.collection(COLLECTION).doc(descriptor.uploadIntentId).get()).data().status, "LINKED");
  }
});

test("same-intent retry is idempotent and conflicting bytes are rejected without deletion", async () => {
  const [name, mimetype, buffer] = (await fixtures())[2];
  const suffix = crypto.randomUUID(), input = { requestId: `request-${suffix}`, participantId: `participant-${suffix}`,
    clientSubmissionId: `submission-${suffix}`, file: { originalname: name, mimetype, buffer } };
  const first = await uploadRequestLetter(input), second = await uploadRequestLetter(input);
  assert.equal(second.objectName, first.objectName); assert.equal(second.generation, first.generation);
  const different = await sharp({ create: { width: 3, height: 3, channels: 3, background: "black" } }).png().toBuffer();
  await assert.rejects(() => uploadRequestLetter({ ...input, file: { originalname: name, mimetype, buffer: different } }),
    error => error.code === "REQUEST_LETTER_CONFLICT");
  const [exists] = await (await getStorageBucket()).file(first.objectName).exists(); assert.equal(exists, true);
});

test("concurrent same-intent uploads resolve to one immutable generation", async () => {
  const [name, mimetype, buffer] = (await fixtures())[1];
  const suffix = crypto.randomUUID(), input = { requestId: `request-${suffix}`, participantId: `participant-${suffix}`,
    clientSubmissionId: `submission-${suffix}`, file: { originalname: name, mimetype, buffer } };
  const [first, second] = await Promise.all([uploadRequestLetter(input), uploadRequestLetter(input)]);
  assert.equal(second.objectName, first.objectName);
  assert.equal(second.generation, first.generation);
});

test("direct unauthenticated Storage REST access is denied by client rules", async () => {
  assert.ok(persistedObjectName);
  const response = await fetch(`http://127.0.0.1:9199/v0/b/demo-menro-phase2.firebasestorage.app/o/${encodeURIComponent(persistedObjectName)}?alt=media`);
  assert.ok([401, 403].includes(response.status));
});
