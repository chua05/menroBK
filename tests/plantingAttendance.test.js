const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const { queryMemory } = require("./helpers/queryMemory");
const memory = queryMemory(), objects = new Map(); let generation = 0, failSave = false;
const bucket = { name: "demo-menro-phase2.firebasestorage.app", file(name, selected = {}) { return {
  async save(bytes, options) {
    assert.equal(memory.inTransaction(), false); assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
    if (failSave) throw Object.assign(new Error("Synthetic storage failure"), { code: 503 });
    if (objects.has(name)) throw Object.assign(new Error("exists"), { code: 412 });
    assert.equal(options.metadata.metadata.firebaseStorageDownloadTokens, undefined);
    objects.set(name, { bytes: Buffer.from(bytes), metadata: { ...options.metadata, generation: String(++generation), size: String(bytes.length), timeCreated: new Date().toISOString() } });
  }, async getMetadata() {
    if (!objects.has(name)) throw Object.assign(new Error("missing"), { code: 404 });
    const value = objects.get(name); if (selected.generation) assert.equal(selected.generation, value.metadata.generation); return [value.metadata];
  }, async download() { return [objects.get(name).bytes]; },
  async delete(options) { assert.equal(String(options.ifGenerationMatch), objects.get(name).metadata.generation); objects.delete(name); },
}; } };
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: memory.db, getStorageBucket: () => bucket } };
const service = require("../src/services/plantingAttendance.service");
const staff = { uid: "staff-owner", role: "staff" }, admin = { uid: "admin", role: "admin" };
const before = { ...process.env };
test.before(() => {
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) assert.equal(process.env[key], undefined, "Credential-free unit test required");
  Object.assign(process.env, { NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", GCLOUD_PROJECT: "demo-menro-phase2", FIREBASE_PROJECT_ID: "demo-menro-phase2", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", FIREBASE_STORAGE_BUCKET: bucket.name, EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true", EVIDENCE_CLOUD_READ_ENABLED: "true" });
});
test.after(() => { for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); });
function seed() {
  const id = randomUUID(), operationId = createHash("sha256").update(id).digest("hex"), requestId = `fixture-${id}`;
  memory.records("plantingContributions").set(id, { reportId: `report-${id}`, officialStaffReport: true, officialOperationId: operationId, authenticatedSubmitterUid: staff.uid, staffReviewStatus: "Pending Review" });
  memory.records("officialPlantingOperations").set(operationId, { staffId: staff.uid, requestId, reportId: `report-${id}`, submissionIds: [id] });
  return { id, operationId, requestId };
}
async function image() { return { originalname: "attendance.png", mimetype: "image/png", buffer: await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).png().toBuffer() }; }
function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(bytes) { this.bytes = bytes; } };
}
test("attendance is optional, private, byte-preserving, quota-accounted and retrievable by authorized MENRO roles", async () => {
  const fixture = seed(), file = await image();
  assert.deepEqual(await service.uploadAttendance(staff, fixture.id, file), { hasAttendance: true });
  const descriptor = memory.records("officialPlantingOperations").get(fixture.operationId).attendance;
  assert.equal(descriptor.sha256, createHash("sha256").update(file.buffer).digest("hex")); assert.equal(descriptor.contentType, "image/png");
  assert.equal(memory.records("plantingContributions").get(fixture.id).attendanceAvailable, true); assert.equal(descriptor.url, undefined);
  const out = response(); await service.streamAttendance(admin, fixture.id, out);
  assert.deepEqual(out.bytes, file.buffer); assert.equal(out.headers["Cache-Control"], "private, no-store"); assert.equal(out.headers["X-Content-Type-Options"], "nosniff"); assert.match(out.headers["Content-Disposition"], /attachment/);
  const reservation = [...memory.records("evidenceQuotaReservations").values()].find(row => row.generation === descriptor.generation);
  assert.equal(reservation.state, "FINALIZED"); assert.equal(reservation.actualFiles, 1);
});
test("same-file retry is idempotent and a different file cannot replace immutable attendance", async () => {
  const fixture = seed(), file = await image(); await service.uploadAttendance(staff, fixture.id, file);
  const count = objects.size; assert.deepEqual(await service.uploadAttendance(staff, fixture.id, file), { hasAttendance: true }); assert.equal(objects.size, count);
  await assert.rejects(service.uploadAttendance(staff, fixture.id, { ...file, buffer: await sharp(file.buffer).negate().png().toBuffer() }), error => error.status === 409);
});
test("safe PDF is accepted; executable, disguised, malformed, oversize and DOCX attendance are rejected", async () => {
  const fixture = seed(), pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  await service.uploadAttendance(staff, fixture.id, { originalname: "attendance.pdf", mimetype: "application/pdf", buffer: Buffer.from(await pdf.save()) });
  for (const file of [{ originalname: "script.svg", mimetype: "image/svg+xml", buffer: Buffer.from("<svg/>") }, { originalname: "bad.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-invalid") }, { originalname: "bad.png", mimetype: "image/png", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }, { originalname: "attendance.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK") }]) {
    await assert.rejects(service.uploadAttendance(staff, seed().id, file), error => error.status === 400);
  }
});
test("Participant/unauthenticated retrieval and Admin/non-owner uploading are denied", async () => {
  const fixture = seed(), file = await image();
  for (const user of [null, { uid: "requester", role: "participant" }]) await assert.rejects(service.streamAttendance(user, fixture.id, response()), error => [401, 403].includes(error.status));
  for (const user of [admin, { uid: "another-staff", role: "staff" }]) await assert.rejects(service.uploadAttendance(user, fixture.id, file), error => [403, 404].includes(error.status));
});
test("reviewed submissions reject new attendance, while an exact completed retry remains safe", async () => {
  const fixture = seed(), file = await image(); await service.uploadAttendance(staff, fixture.id, file);
  memory.records("plantingContributions").get(fixture.id).staffReviewStatus = "Accepted";
  assert.deepEqual(await service.uploadAttendance(staff, fixture.id, file), { hasAttendance: true });
  const other = seed(); memory.records("plantingContributions").get(other.id).staffReviewStatus = "Accepted";
  await assert.rejects(service.uploadAttendance(staff, other.id, file), error => error.status === 409);
});
test("failed storage attempts keep owned retry state and explicit emulator cleanup is scoped and idempotent", async () => {
  const fixture = seed(), unrelated = seed(), file = await image();
  await service.uploadAttendance(staff, unrelated.id, file);
  failSave = true; await assert.rejects(service.uploadAttendance(staff, fixture.id, file)); failSave = false;
  const operation = memory.records("officialPlantingOperations").get(fixture.operationId); assert.equal(operation.attendanceLease, ""); assert.equal(operation.attendance, undefined);
  await service.uploadAttendance(staff, fixture.id, file);
  await assert.rejects(service.cleanupAttendanceObject(fixture.operationId, unrelated.requestId), error => error.status === 409);
  assert.deepEqual(await service.cleanupAttendanceObject(fixture.operationId, fixture.requestId), { deleted: true });
  assert.deepEqual(await service.cleanupAttendanceObject(fixture.operationId, fixture.requestId), { deleted: false });
  const unrelatedDescriptor = memory.records("officialPlantingOperations").get(unrelated.operationId).attendance; assert.equal(objects.has(unrelatedDescriptor.objectName), true);
});
