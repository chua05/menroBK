const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const yazl = require("yazl");

const uploadRoot = path.join(os.tmpdir(), `menro-request-letter-http-${process.pid}`);
fs.mkdirSync(uploadRoot, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", MENRO_REQUEST_LETTER_ACCEPTANCE: "true",
  GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8181", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", FIREBASE_STORAGE_BUCKET: "demo-menro-phase2.firebasestorage.app",
  EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true",
  EVIDENCE_CLOUD_READ_ENABLED: "true", REQUEST_LETTER_STORAGE_ENABLED: "true", REQUEST_LETTER_STORAGE_REQUIRED: "true",
  MENRO_UPLOAD_ROOT: uploadRoot,
  REQUEST_IDENTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64"),
});
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"])
  delete process.env[key];

const { auth, db, getStorageBucket } = require("../../src/config/firebase");
const app = require("../../src/app");
const PASSWORD = "Request-Letter-Test!2026";
const prefix = `request-letter-http-${Date.now()}`;
const users = Object.fromEntries(["participant", "other", "staff", "admin"].map(role =>
  [role, { uid: `${prefix}-${role}`, email: `${prefix}.${role}@example.test` }]));
let server, baseUrl, tokens = {}, inventoryId;

async function signIn(email) {
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.idToken;
}
async function call(role, method, route, body, form = false) {
  const headers = {}; if (role) headers.authorization = `Bearer ${tokens[role]}`;
  if (!form && body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${route}`, { method, headers,
    body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
}
async function json(role, method, route, body, form = false, expected = 200) {
  const response = await call(role, method, route, body, form); const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`); return payload.data;
}
const docx = () => new Promise((resolve, reject) => {
  const zip = new yazl.ZipFile(), chunks = [];
  zip.addBuffer(Buffer.from("<Types><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"), "[Content_Types].xml");
  zip.addBuffer(Buffer.from("<Relationships><Relationship Id=\"rId1\" Target=\"word/document.xml\"/></Relationships>"), "_rels/.rels");
  zip.addBuffer(Buffer.from("<w:document xmlns:w=\"x\"><w:body><w:p/></w:body></w:document>"), "word/document.xml");
  zip.outputStream.on("data", chunk => chunks.push(chunk)); zip.outputStream.once("error", reject);
  zip.outputStream.once("end", () => resolve(Buffer.concat(chunks))); zip.end();
});
async function files() {
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  return [
    ["letter.pdf", "application/pdf", Buffer.from(await pdf.save())],
    ["letter.jpg", "image/jpeg", await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).jpeg().toBuffer()],
    ["letter.png", "image/png", await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer()],
    ["letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await docx()],
  ];
}
function payload(id = crypto.randomUUID(), individual = false) {
  return { items: [{ inventoryId, quantity: 2 }], purpose: "Private document acceptance",
    plantingLocation: "Synthetic Site", preferredReleaseDate: "2026-11-10", clientSubmissionId: id,
    identification: { identificationType: "national_id", idNumber: `TEST-${id.slice(0, 8)}`, confirmed: true },
    workflow: { sector: individual ? "Resident / Individual" : "Civic Organization / NGO",
      requestingAs: individual ? "individual" : "group", siteMode: "existing",
      addressProvince: "Sorsogon", addressMunicipality: "Bulan", addressBarangay: "Bical", street: "Purok 1",
      siteBarangay: "Bical", areaChoice: "1 hectare", releaseMethod: "Pick-up",
      caretaker: "Synthetic caretaker", carePlan: "Water and monitor synthetic seedlings.",
      monitoringFrequency: "Weekly", existingSiteId: `${prefix}-site`,
      ...(individual ? {} : { eventName: "Synthetic planting" }) },
    eventProposal: { eventName: "Synthetic planting", barangay: "Bical", plantingSiteId: `${prefix}-site`,
      proposedDate: "2026-11-12", startTime: "09:00", endTime: "11:00", eventLocation: "Synthetic Site",
      latitude: 12.671, longitude: 123.875, expectedParticipants: 5, eventDescription: "Synthetic only" } };
}
function multipart(data, file) {
  const form = new FormData(); form.set("request", JSON.stringify(data));
  if (file) form.set("requestLetter", new Blob([file[2]], { type: file[1] }), file[0]); return form;
}

test.before(async () => {
  for (const [role, user] of Object.entries(users)) {
    await auth.createUser({ ...user, password: PASSWORD, emailVerified: true });
    await db.collection("users").doc(user.uid).set({ ...user, role: role === "other" ? "participant" : role,
      fullName: `Synthetic ${role}`, userType: role === "participant" ? "Organization Member" : "MENRO",
      organization: "Synthetic Organization", contactNumber: "09123456789",
      status: "active", profileComplete: true, testFixture: true });
  }
  await db.collection("sites").doc(`${prefix}-site`).set({ siteName: "Synthetic Site", barangay: "Bical",
    latitude: 12.671, longitude: 123.875, coverageRadius: 100, status: "Active", archived: false, testFixture: true });
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const [role, user] of Object.entries(users)) tokens[role] = await signIn(user.email);
  const inventory = await json("staff", "POST", "/inventory", { species: "Narra", category: "Native Tree",
    initialQuantity: 100, stockStatus: "Available", sourceType: "MENRO Propagation",
    dateReceived: "2026-10-01", storageLocation: "MENRO Nursery", description: "Test only" }, false, 201);
  inventoryId = inventory.id;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

test("all supported files traverse multipart HTTP, persist privately, link, and authorize downloads", async () => {
  for (const file of await files()) {
    const created = await json("participant", "POST", "/seedling-requests", multipart(payload(), file), true, 201);
    assert.equal(created.requestLetter.storageStatus, "private_v1");
    assert.equal(JSON.stringify(created).includes("request-letters/v1"), false);
    assert.equal(JSON.stringify(created).includes("firebasestorage.app"), false);
    const stored = (await db.collection("seedlingRequests").doc(created.id).get()).data();
    const descriptor = stored.requestLetter.privateDocument;
    assert.equal(descriptor.sha256, crypto.createHash("sha256").update(file[2]).digest("hex"));
    const [metadata] = await (await getStorageBucket()).file(descriptor.objectName).getMetadata();
    assert.equal(String(metadata.generation), descriptor.generation);
    assert.equal(String(metadata.size), String(file[2].length));
    for (const role of ["participant", "staff", "admin"]) {
      const response = await call(role, "GET", `/seedling-requests/${created.id}/request-letter`);
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), file[2]);
      assert.match(response.headers.get("content-disposition"), /^attachment;/);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    assert.equal((await call("other", "GET", `/seedling-requests/${created.id}/request-letter`)).status, 403);
    assert.equal((await call(null, "GET", `/seedling-requests/${created.id}/request-letter`)).status, 401);
  }
});

test("individual needs no letter, group without one fails, and retries stay idempotent", async () => {
  const individual = await json("participant", "POST", "/seedling-requests", payload(crypto.randomUUID(), true), false, 201);
  assert.equal(individual.requestLetter, undefined);
  await json("participant", "POST", "/seedling-requests", payload(), false, 400);
  const file = (await files())[2], data = payload();
  const first = await json("participant", "POST", "/seedling-requests", multipart(data, file), true, 201);
  const second = await json("participant", "POST", "/seedling-requests", multipart(data, file), true, 201);
  assert.equal(second.id, first.id);
  const matches = await db.collection("seedlingRequests").where("clientSubmissionId", "==", data.clientSubmissionId).get();
  assert.equal(matches.size, 1);
});

test("historical metadata-only request remains readable but has no fabricated download", async () => {
  const id = `${prefix}-historical`;
  await db.collection("seedlingRequests").doc(id).set({ participantId: users.participant.uid, status: "Pending",
    workflow: { requestLetter: { name: "historical.pdf", type: "application/pdf", size: 12 } }, createdAt: new Date() });
  const record = await json("participant", "GET", `/seedling-requests/${id}`);
  assert.equal(record.requestLetter.storageStatus, "legacy_metadata_only");
  assert.equal((await call("participant", "GET", `/seedling-requests/${id}/request-letter`)).status, 404);
});

test("historical returned requests retain metadata or preserve it in history when replaced", async () => {
  const makeHistorical = async (suffix, version) => {
    const id = `${prefix}-historical-returned-${suffix}`;
    const data = payload(); delete data.clientSubmissionId; delete data.identification;
    await db.collection("seedlingRequests").doc(id).set({
      ...data, participantId: users.participant.uid, participantName: "Synthetic participant",
      status: "Returned", requestVersion: version, reviewHistory: [],
      workflow: { ...data.workflow, requestLetter: { name: "historical.pdf", type: "application/pdf", size: 12 } },
      createdAt: new Date(),
    });
    return { id, data };
  };

  const retainedFixture = await makeHistorical("retain", 3);
  const retainedPayload = { ...retainedFixture.data, expectedVersion: 3 };
  const retained = await json("participant", "PATCH", `/seedling-requests/${retainedFixture.id}/resubmit`,
    retainedPayload, false, 200);
  assert.equal(retained.id, retainedFixture.id);
  const retainedStored = (await db.collection("seedlingRequests").doc(retainedFixture.id).get()).data();
  assert.equal(retainedStored.workflow.requestLetter.name, "historical.pdf");
  assert.equal(retainedStored.requestLetter, undefined);

  const replaceFixture = await makeHistorical("replace", 5);
  const replacement = (await files())[2];
  const replacePayload = { ...replaceFixture.data, expectedVersion: 5 };
  const replaced = await json("participant", "PATCH", `/seedling-requests/${replaceFixture.id}/resubmit`,
    multipart(replacePayload, replacement), true, 200);
  assert.equal(replaced.id, replaceFixture.id);
  const replacedStored = (await db.collection("seedlingRequests").doc(replaceFixture.id).get()).data();
  assert.equal(replacedStored.requestLetter.privateDocument.contentType, "image/png");
  assert.equal(replacedStored.workflow.requestLetter, null);
  assert.equal(replacedStored.requestLetterHistory.at(-1).legacyMetadata.name, "historical.pdf");
  const displayed = await json("participant", "GET", `/seedling-requests/${replaceFixture.id}`);
  assert.equal(displayed.requestLetterHistory.at(-1).storageStatus, "legacy_metadata_only");
  assert.equal((await call("participant", "PATCH", `/seedling-requests/${replaceFixture.id}/resubmit`,
    multipart(replacePayload, replacement), true)).status, 409);
});

test("authenticated capability reports the active backend upload gate", async () => {
  const capability = await json("participant", "GET", "/seedling-requests/capabilities");
  assert.deepEqual(capability, { requestLetterStorage: { uploadEnabled: true, uploadRequired: true } });
});

test("returned-request replacement preserves the prior immutable document and rejects stale versions", async () => {
  const [original, replacement] = (await files()).slice(1, 3);
  const created = await json("participant", "POST", "/seedling-requests", multipart(payload(), original), true, 201);
  const before = (await db.collection("seedlingRequests").doc(created.id).get()).data().requestLetter.privateDocument;
  await json("staff", "PATCH", `/seedling-requests/${created.id}/return`,
    { expectedVersion: 0, reason: "Replace the synthetic supporting document." });
  const revised = payload(); delete revised.clientSubmissionId; delete revised.identification;
  revised.expectedVersion = 1;
  const resubmitted = await json("participant", "PATCH", `/seedling-requests/${created.id}/resubmit`,
    multipart(revised, replacement), true, 200);
  assert.equal(resubmitted.id, created.id);
  const stored = (await db.collection("seedlingRequests").doc(created.id).get()).data();
  assert.equal(stored.requestLetterHistory.length, 1);
  assert.equal(stored.requestLetterHistory[0].privateDocument.generation, before.generation);
  assert.notEqual(stored.requestLetter.privateDocument.generation, before.generation);
  assert.equal((await (await getStorageBucket()).file(before.objectName).exists())[0], true);
  const stale = { ...revised, expectedVersion: 1 };
  assert.equal((await call("participant", "PATCH", `/seedling-requests/${created.id}/resubmit`,
    multipart(stale, replacement), true)).status, 409);
});

test("replacement idempotency keys are isolated between requests at the same revision", async () => {
  const [original, replacement] = (await files()).slice(1, 3);
  const created = [];
  for (let index = 0; index < 2; index += 1) {
    const request = await json("participant", "POST", "/seedling-requests",
      multipart(payload(), original), true, 201);
    await json("staff", "PATCH", `/seedling-requests/${request.id}/return`,
      { expectedVersion: 0, reason: "Replace the synthetic supporting document." });
    const revised = payload(); delete revised.clientSubmissionId; delete revised.identification;
    revised.expectedVersion = 1;
    await json("participant", "PATCH", `/seedling-requests/${request.id}/resubmit`,
      multipart(revised, replacement), true, 200);
    created.push((await db.collection("seedlingRequests").doc(request.id).get()).data());
  }
  assert.notEqual(created[0].requestLetter.privateDocument.uploadIntentId,
    created[1].requestLetter.privateDocument.uploadIntentId);
});
