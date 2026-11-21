const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { PassThrough, Readable } = require("node:stream");
const yazl = require("yazl");

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const REPO = path.join(__dirname, "..");
const file = p => path.join(REPO, p);

// ---- Module mocks (installed only while loading; no real Firebase) ----
const state = { bytes: Buffer.alloc(0), request: null, generation: null };
const fakeBucket = {
  name: "test-bucket",
  file(objectName, opts) {
    state.generation = opts && opts.generation;
    return {
      getMetadata: async () => [{ generation: "123", size: String(state.bytes.length), metadata: { sha256: "abc" } }],
      createReadStream: () => Readable.from([state.bytes]),
    };
  },
};
const unexpected = new Proxy({}, { get: (_t, name) => name === "getSeedlingRequestById"
  ? async () => state.request : () => { throw new Error("unexpected call " + String(name)); } });
const mocks = {
  [file("src/config/firebase.js")]: { db: {}, getStorageBucket: async () => fakeBucket },
  [file("src/config/requestLetterStorage.js")]: {
    resolveRequestLetterStorageConfig: () => ({ enabled: true, required: false, storage: { cloudRead: true, bucket: "test-bucket" } }),
  },
  [file("src/services/seedlingRequest.service.js")]: unexpected,
  [file("src/services/requestIdentification.service.js")]: new Proxy({}, { get: () => () => { throw new Error("unexpected"); } }),
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  try {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (Object.hasOwn(mocks, resolved)) return mocks[resolved];
  } catch { /* fall through to the real loader */ }
  return originalLoad.apply(this, arguments);
};
let service, controller, middleware;
try {
  service = require("../src/services/requestLetterStorage.service");
  controller = require("../src/controller/seedlingRequest.controller");
  middleware = require("../src/middleware/requestLetterUpload.middleware");
} finally { Module._load = originalLoad; }
const { validateRequestLetterFile } = service;

function docx(entries = {}, omit = []) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile(), chunks = [];
    const defaults = {
      "[Content_Types].xml": "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/></Types>",
      "_rels/.rels": "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"officeDocument\" Target=\"word/document.xml\"/></Relationships>",
      "word/document.xml": "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p/></w:body></w:document>",
      ...entries,
    };
    Object.entries(defaults).filter(([n]) => !omit.includes(n)).forEach(([n, v]) => zip.addBuffer(Buffer.from(v), n));
    zip.outputStream.on("data", c => chunks.push(c));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

const MISMATCH = /The request-letter extension, type, and contents do not match\./;
const UNSUPPORTED = /Only PDF, JPEG, PNG, or DOCX request letters are accepted\./;
const BAD_DOCX = /The DOCX is malformed, macro-enabled, contains active content, or exceeds safe limits\./;
const TOO_BIG = /Select a request letter not larger than 10 MB\./;

// ---- 1. Validation ----
test("accepts a valid minimal DOCX and classifies it as docx", async () => {
  const buffer = await docx();
  const result = await validateRequestLetterFile({ buffer, originalname: "letter.docx", mimetype: DOCX_MIME });
  assert.equal(result.format, "docx");
  assert.equal(result.contentType, DOCX_MIME);
  assert.equal(result.originalName, "letter.docx");
  assert.equal(result.sizeBytes, buffer.length);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("rejects a non-zip file named .docx with the DOCX MIME", async () => {
  await assert.rejects(() => validateRequestLetterFile({ buffer: Buffer.from("plain text, not a zip"),
    originalname: "letter.docx", mimetype: DOCX_MIME }), MISMATCH);
  // starts with PK so it passes the sniff; yauzl parsing must still reject it
  await assert.rejects(() => validateRequestLetterFile({ buffer: Buffer.from("PK not really a zip archive"),
    originalname: "letter.docx", mimetype: DOCX_MIME }), BAD_DOCX);
});

test("rejects a valid DOCX with a wrong MIME type", async () => {
  const buffer = await docx();
  for (const mimetype of ["application/octet-stream", "application/pdf"]) {
    await assert.rejects(() => validateRequestLetterFile({ buffer, originalname: "letter.docx", mimetype }), MISMATCH);
  }
});

test("rejects a valid DOCX named .pdf", async () => {
  const buffer = await docx();
  for (const mimetype of [DOCX_MIME, "application/pdf"]) {
    await assert.rejects(() => validateRequestLetterFile({ buffer, originalname: "letter.pdf", mimetype }), MISMATCH);
  }
});

test("rejects a ZIP missing required DOCX parts", async () => {
  for (const missing of ["word/document.xml", "[Content_Types].xml", "_rels/.rels"]) {
    const buffer = await docx({}, [missing]);
    await assert.rejects(() => validateRequestLetterFile({ buffer, originalname: "letter.docx", mimetype: DOCX_MIME }),
      BAD_DOCX, "missing " + missing);
  }
});

test("rejects empty and over-10 MB buffers", async () => {
  await assert.rejects(() => validateRequestLetterFile({ buffer: Buffer.alloc(0), originalname: "letter.docx",
    mimetype: DOCX_MIME }), TOO_BIG);
  await assert.rejects(() => validateRequestLetterFile({ buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x50),
    originalname: "letter.docx", mimetype: DOCX_MIME }), TOO_BIG);
});

test("rejects .doc and .txt uploads with the supported-types message", async () => {
  const cases = [["letter.doc", "application/msword"], ["letter.txt", "text/plain"],
    ["letter.doc", "application/octet-stream"], ["letter.txt", "application/octet-stream"]];
  for (const [originalname, mimetype] of cases) {
    await assert.rejects(() => validateRequestLetterFile({ buffer: Buffer.from("hello"), originalname, mimetype }), UNSUPPORTED);
  }
});

test("middleware returns the 10 MB message when the multer limit is exceeded", async () => {
  const boundary = "----menroboundary";
  const body = Buffer.concat([
    Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"requestLetter\"; filename=\"big.docx\"\r\nContent-Type: " + DOCX_MIME + "\r\n\r\n"),
    Buffer.alloc(10 * 1024 * 1024 + 1024, 0x50),
    Buffer.from("\r\n--" + boundary + "--\r\n"),
  ]);
  const req = Readable.from([body]);
  req.headers = { "content-type": "multipart/form-data; boundary=" + boundary, "content-length": String(body.length) };
  req.method = "POST";
  const result = await new Promise(resolve => {
    const res = { status(code) { this.code = code; return this; }, json(payload) { resolve({ code: this.code, payload }); } };
    middleware.parseRequestLetterSubmission(req, res, () => resolve({ nextCalled: true }));
  });
  assert.equal(result.nextCalled, undefined);
  assert.equal(result.code, 400);
  assert.equal(result.payload.message, "The request letter must not exceed 10 MB.");
});

// ---- 2. Authorized retrieval (real controller + real streamRequestLetter; mocked Firestore/Storage) ----
function makeRes() {
  const res = new PassThrough();
  res.headers = {}; res.statusCode = 200; res.body = null; res.chunks = [];
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  res.on("data", c => res.chunks.push(c));
  return res;
}

async function download(user, requestOverrides = {}) {
  state.bytes = await docx();
  state.request = { id: "req1", participantId: "owner-uid", requestLetter: { privateDocument: {
    bucket: "test-bucket", objectName: "request-letters/v1/req1/intent", generation: "123",
    sizeBytes: state.bytes.length, sha256: "abc", contentType: DOCX_MIME, originalName: "my letter.docx" } },
    ...requestOverrides };
  const res = makeRes();
  await controller.getRequestLetter({ params: { id: "req1" }, user }, res);
  await new Promise(r => setImmediate(r));
  return res;
}

test("owner participant downloads a stored DOCX as an attachment with security headers", async () => {
  const res = await download({ uid: "owner-uid", role: "participant" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], DOCX_MIME);
  assert.equal(res.headers["content-disposition"], "attachment; filename=\"my letter.docx\"");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.headers["cache-control"], /no-store/);
  assert.match(res.headers["content-security-policy"], /sandbox/);
  assert.equal(state.generation, "123");
  assert.ok(Buffer.concat(res.chunks).equals(state.bytes));
});

test("non-owner participant gets 403 and nothing is streamed", async () => {
  const res = await download({ uid: "someone-else", role: "participant" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
  assert.equal(res.chunks.length, 0);
  assert.equal(res.headers["content-type"], undefined);
  assert.equal(res.headers["content-disposition"], undefined);
});

test("staff and admin can download any request's DOCX", async () => {
  for (const role of ["staff", "admin"]) {
    const res = await download({ uid: role + "-uid", role });
    assert.equal(res.statusCode, 200, role);
    assert.equal(res.headers["content-type"], DOCX_MIME);
    assert.equal(res.headers["content-disposition"], "attachment; filename=\"my letter.docx\"");
    assert.ok(Buffer.concat(res.chunks).equals(state.bytes));
  }
});

test("unknown roles are forbidden and a request without a letter returns 404", async () => {
  const forbidden = await download({ uid: "x", role: "guest" });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.chunks.length, 0);
  const missing = await download({ uid: "owner-uid", role: "participant" }, { requestLetter: {} });
  assert.equal(missing.statusCode, 404);
});
