// Real Firestore emulator: an Admin-approved Staff-encoded walk-in is released by its encoder exactly once, stock never goes
// negative, the citizen stays the requester, and Staff reporting follows the policy stored at release.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");

for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG", "MENRO_PHASE3C_ISOLATED_EMULATORS"]) delete process.env[key];
process.env.MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS = "true";
const topology = require("../helpers/emulatorTestTopology");
Object.assign(process.env, { NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", GCLOUD_PROJECT: topology.project, FIREBASE_PROJECT_ID: topology.project,
  FIRESTORE_EMULATOR_HOST: topology.firestore, FIREBASE_AUTH_EMULATOR_HOST: topology.auth, FIREBASE_STORAGE_EMULATOR_HOST: topology.storage, FIREBASE_STORAGE_BUCKET: topology.bucket,
  EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true", EVIDENCE_CLOUD_READ_ENABLED: "true", MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-walkin-release-${process.pid}`) });
const validation = require("../../src/config/integrationEnvironment").validateIntegrationEnvironment();
assert.equal(validation.integration, true); assert.match(validation.projectId, /^demo-/); assert.match(topology.firestore, /^127\.0\.0\.1:/);
const { db } = require("../../src/config/firebase");
const requests = require("../../src/services/seedlingRequest.service");
const reports = require("../../src/services/officialPlantingReport.service");

const prefix = `walkin-release-${crypto.randomUUID()}`, touched = [];
const staff = name => ({ uid: `${prefix}-${name}`, role: "staff", fullName: name });
const encoder = staff("encoder"), officer = staff("officer");
const set = async (collection, id, data) => { const ref = db.collection(collection).doc(id); touched.push(ref); await ref.set({ ...data, testFixture: prefix }); return ref; };
// An approved walk-in as the Admin approval transaction leaves it.
async function approved(key, { reporting = "REQUIRED", stock = 5, quantity = 4 } = {}) {
  const id = `${prefix}-${key}`, eventId = `${id}-event`, inventoryId = `${id}-narra`;
  const items = [{ inventoryId, species: "Narra", quantity }];
  const policy = { policyVersion: 1, policyStatus: "RESOLVED", definition: { purpose: "Reforestation", reporting, monitoring: "PERMANENT_SAMPLE", quantityThreshold: null }, sampling: {} };
  await set("seedlingInventory", inventoryId, { species: "Narra", availableQuantity: stock, currentQuantity: stock, reservedQuantity: 0, distributedQuantity: 0 });
  await set("events", eventId, { name: "Walk-in planting", sourceRequestId: id, status: "Approved", date: "2099-01-02", startTime: "08:00", plantingSiteId: `${prefix}-site`, plantingSiteName: "Site", barangay: "Bical", seedlingItems: items, seedlingTotalQuantity: quantity });
  const ref = await set("seedlingRequests", id, { requestNumber: `REQ-${key}`, status: "Approved", requestVersion: 2, participantId: `walkin_${id}`, participantName: "Walk-in Citizen", organization: "", contactNumber: "", purpose: "Reforestation", plantingLocation: "Bical, Bulan", preferredReleaseDate: "2099-01-01", remarks: "", reviewedBy: "", eventProposal: { eventName: "Walk-in planting", barangay: "Bical", plantingSiteId: `${prefix}-site`, proposedDate: "2099-01-02", proposedStartTime: "08:00", eventLocation: "Bical, Bulan" }, requesterRole: "walk-in", createdByRole: "staff", requestType: "individual",
    submissionPath: "STAFF_DIRECT_TO_ADMIN", submittedByUid: encoder.uid, approvedBy: `${prefix}-admin`, eventId, items, quantity, inventoryReserved: false, inventoryReleased: false, approvedPurposePolicy: policy,
    workflow: { sector: "Resident / Individual", effectiveRequestType: "individual" }, walkIn: { encodedBy: encoder.uid, encodedByName: "encoder", citizenHasAccount: false } });
  touched.push(db.collection("distributions").doc(id), db.collection("plantingReports").doc(`event_${eventId}`));
  return { id, eventId, inventoryId, ref, quantity };
}
const release = (row, user, quantity = row.quantity) => requests.releaseSeedlingRequest(row.id, user.uid, { expectedVersion: 2, availableReleaseDate: "2099-01-01", items: [{ inventoryId: row.inventoryId, releasedQuantity: quantity, shortReleaseReason: quantity < row.quantity ? "Limited stock" : "" }] });
const read = async (collection, id) => (await db.collection(collection).doc(id).get()).data();
const stockOf = async row => (await read("seedlingInventory", row.inventoryId)).availableQuantity;
const reportBody = row => ({ requestId: row.id, confirmationBasis: "release-based", remarks: "Planted", clientSubmissionId: crypto.randomUUID(), expectedVersion: 0, items: [{ inventoryId: row.inventoryId, quantityPlanted: row.quantity, leftoverQuantity: 0 }] });

test.before(() => set("sites", `${prefix}-site`, { siteName: "Site", barangay: "Bical", status: "Active", latitude: 12.66, longitude: 123.93 }));
test.after(async () => {
  for (const collection of ["plantingContributions", "officialPlantingOperations", "verificationLogs"]) for (const doc of (await db.collection(collection).get()).docs) if (JSON.stringify(doc.data()).includes(prefix)) await doc.ref.delete();
  for (const collection of ["notifications", "counters"]) for (const doc of (await db.collection(collection).get()).docs) await doc.ref.delete();
  for (const ref of touched) await ref.delete();
});

test("six simultaneous releases by the encoder and another Staff release once and deduct stock once", async () => {
  const row = await approved("race");
  const results = await Promise.allSettled([encoder, officer, encoder, officer, encoder, officer].map(user => release(row, user)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(await stockOf(row), 1); assert.equal((await read("seedlingInventory", row.inventoryId)).distributedQuantity, 4);
  const request = await read("seedlingRequests", row.id), distribution = await read("distributions", row.id);
  assert.equal(request.status, "Released"); assert.ok([encoder.uid, officer.uid].includes(request.releasedBy)); assert.ok(request.releasedAt); assert.equal(request.totalQuantityReleased, 4);
  assert.equal(distribution.participantId, request.participantId); assert.notEqual(request.participantId, encoder.uid); assert.equal(request.participantName, "Walk-in Citizen");
});

test("a release that exceeds stock changes nothing, and a partial release records the actual quantity", async () => {
  const row = await approved("stock", { stock: 3 });
  await assert.rejects(release(row, encoder), /available stock/); assert.equal(await stockOf(row), 3); assert.equal(await read("distributions", row.id), undefined); assert.equal((await read("seedlingRequests", row.id)).status, "Approved");
  const released = await release(row, encoder, 3);
  assert.deepEqual([released.status, released.releaseType, released.totalQuantityReleased, released.releasedBy, released.releasedItems[0].shortReleaseReason], ["Released", "Partial", 3, encoder.uid, "Limited stock"]); assert.equal(await stockOf(row), 0);
});

test("reporting opens only after release: required is submitted by Staff for the citizen, not required is refused and not listed", async () => {
  const required = await approved("required"), none = await approved("none", { reporting: "NOT_REQUIRED" });
  for (const row of [required, none]) { await assert.rejects(reports.submitOfficialReport(encoder, reportBody(row))); await release(row, encoder); await db.collection("events").doc(row.eventId).update({ date: "2026-01-02" }); /* the planting day has passed */ }
  const listed = (await reports.listReleasedOptions(encoder)).options.map(option => option.requestId);
  assert.ok(listed.includes(required.id)); assert.ok(!listed.includes(none.id));
  const report = await reports.submitOfficialReport(encoder, reportBody(required));
  assert.equal(report.submissions[0].requesterName, "Walk-in Citizen"); assert.equal(report.participantId, (await read("seedlingRequests", required.id)).participantId);
  await assert.rejects(reports.submitOfficialReport(encoder, reportBody(none)), error => error.status === 409 && error.code === "PLANTING_REPORT_NOT_REQUIRED");
  assert.equal((await db.collection("plantingContributions").where("reportId", "==", `event_${none.eventId}`).get()).size, 0);
});
