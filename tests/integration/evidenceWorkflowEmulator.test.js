// UUID-scoped authenticated API acceptance. Never reset collections or shared fixtures.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const http = require("node:http"), https = require("node:https");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { resolveEvidenceStorageConfig } = require("../../src/config/evidenceStorage");
// emulators:exec injects demo SDK discovery metadata. It is not an application
// credential; validate it before removing it from this isolated test child.
if (process.env.FIREBASE_CONFIG) {
  const config = JSON.parse(process.env.FIREBASE_CONFIG);
  assert.equal(config.projectId, "demo-menro-phase2");
  assert.ok(Object.keys(config).every(key => ["projectId", "databaseURL", "storageBucket"].includes(key)));
  if (config.storageBucket) assert.ok(["demo-menro-phase2.appspot.com", "demo-menro-phase2.firebasestorage.app"].includes(config.storageBucket));
  if (config.databaseURL) assert.equal(config.databaseURL, "https://demo-menro-phase2.firebaseio.com");
  delete process.env.FIREBASE_CONFIG;
}
if (!resolveEvidenceStorageConfig().cloudWorkflow) throw Error("Explicit credential-free demo cloud gate required");
const approvedFirestorePort = process.env.MENRO_MPDO_BOUNDARY_ACCEPTANCE === "true" ? "8180" : "8080";
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${approvedFirestorePort}`);
const allowedPorts = new Set([approvedFirestorePort, "9099", "9199"]);
const nativeRequest = http.request, nativeFetch = globalThis.fetch;
http.request = function (input, ...args) {
  const url = typeof input === "string" || input instanceof URL ? new URL(input) :
    new URL(input.path || "/", `http://${input.hostname || input.host}:${input.port}`);
  if (url.hostname !== "127.0.0.1" || !allowedPorts.has(url.port)) throw Error("Non-emulator HTTP blocked");
  return nativeRequest.call(this, input, ...args);
};
https.request = () => { throw Error("Cloud HTTPS blocked"); };
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !allowedPorts.has(url.port)) throw Error("Non-emulator fetch blocked");
  return nativeFetch(input, init);
};
const sharp = require("sharp");
const { Timestamp } = require("firebase-admin/firestore");
const { deleteApp } = require("firebase-admin/app");
const { app: firebaseApp, auth, db, getStorageBucket } = require("../../src/config/firebase");
const { dateOnlyInManila, shiftCalendarDate } = require("../../src/utils/earlyMonitoring.util");
const { UPLOAD_ROOT } = require("../../src/config/uploadRoot");
const app = require("../../src/app");
const prefix = `phase5-${randomUUID()}`;
const today = dateOnlyInManila();
const users = {}, tokens = {};
let server, base;
const hash = value => createHash("sha256").update(value).digest("hex");
async function api(role, method, route, body, key) {
  const headers = { authorization: role.startsWith("Guest ") ? role : `Bearer ${tokens[role]}` };
  if (key !== undefined) headers["Idempotency-Key"] = key;
  const form = body instanceof FormData;
  if (!form) headers["Content-Type"] = "application/json";
  const response = await fetch(`${base}/api${route}`, { method, headers,
    body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
  if (response.headers.get("content-type")?.startsWith("image/")) return { status: response.status, response, bytes: Buffer.from(await response.arrayBuffer()) };
  return { status: response.status, response, body: await response.json() };
}
function form(fields, bytes, field = "photo", filename = "original.jpg") {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, String(value));
  if (bytes) data.append(field, new Blob([bytes], { type: "image/jpeg" }), filename);
  return data;
}
function ok(result, status = 201) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(JSON.stringify(result.body).includes("privateEvidence"), false);
  assert.equal(JSON.stringify(result.body).includes("evidence/v1/"), false);
  return result.body.data;
}
async function image(date = today, outside = false) {
  return sharp({ create: { width: 80, height: 80, channels: 3, background: "#168a45" } }).jpeg().withMetadata({
    exif: { IFD0: { Make: "Synthetic MENRO Camera", ImageDescription: randomUUID() },
      // Midnight is never a future capture on the selected Manila calendar date.
      IFD2: { DateTimeOriginal: `${date.replaceAll("-", ":")} 00:00:00` },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: outside ? "12/1 41/1 0/1" : "12/1 40/1 156/10", GPSLongitudeRef: "E", GPSLongitude: "123/1 52/1 30/1" } },
  }).toBuffer();
}
async function browserCameraEvidence(binding, bytes) {
  const session = ok(await api("participant", "POST", "/evidence-capture-sessions", binding));
  const verification = ok(await api("participant", "POST",
    `/evidence-capture-sessions/${session.captureSessionId}/verify`, form({
      nonce: session.nonce, capturedAt: new Date().toISOString(), latitude: 12.671,
      longitude: 123.875, accuracy: 50, clientImageSha256: hash(bytes),
    }, bytes), undefined), 200);
  return { session, verification, evidenceManifest: JSON.stringify([{ source: "browser-camera",
    captureSessionId: session.captureSessionId, nonce: session.nonce,
    verificationId: verification.verificationId, imageSha256: verification.imageSha256 }]) };
}
async function assertConsumed(camera, recordId) {
  const snapshot = await db.collection("evidenceCaptureSessions").doc(camera.session.captureSessionId).get();
  assert.equal(snapshot.data().state, "CONSUMED");
  assert.equal(snapshot.data().consumedRecordId, recordId);
}
async function assertPrivateObject(reference, expectedBytes) {
  const file = getStorageBucket().file(reference.objectName);
  const [exists] = await file.exists();
  assert.equal(exists, true);
  const [metadata] = await file.getMetadata();
  assert.equal(metadata.contentType, "image/jpeg");
  const [stored] = await file.download();
  assert.deepEqual(stored, expectedBytes);
}
async function site() {
  const id = `${prefix}-site-${randomUUID()}`;
  await db.collection("sites").doc(id).create({ siteName: "Synthetic Phase 5 site", barangay: "Bical",
    latitude: 12.671, longitude: 123.875, coverageRadiusMeters: 100, status: "Active" });
  return id;
}
async function plantingFixture(linked = false) {
  const siteId = await site(), eventId = `${prefix}-event-${randomUUID()}`, distributionId = `${prefix}-distribution-${randomUUID()}`;
  const date = shiftCalendarDate(today, -2);
  const requestId = `${prefix}-request-${randomUUID()}`;
  if (linked) await db.collection("seedlingRequests").doc(requestId).create({ eventId, status: "Released", participantId: users.participant });
  await db.collection("events").doc(eventId).create({ name: "Synthetic Phase 5 event", date, status: "Ongoing",
    ...(linked ? { sourceRequestId: requestId, allocationReleasedAt: Timestamp.now(), seedlingTotalQuantity: 100,
      seedlingItems: [{ inventoryId: "synthetic-item", species: "Narra", quantity: 100 }] } : {}),
    recordStatus: "Authorized", plantingSiteId: siteId, barangay: "Bical" });
  await db.collection("distributions").doc(distributionId).create({ status: "Released", participantId: users.participant,
    participantName: "Synthetic participant", eventId, plantingSiteId: siteId, quantityReleased: 100, species: "Narra",
    ...(linked ? { requestId } : {}) });
  return { distributionId, siteId, eventId, barangay: "Bical", quantityPlanted: 25, plantingDate: date,
    plantingLocation: "Synthetic Phase 5 site", submittedByName: "Synthetic participant",
    submittedBySector: "Volunteer", submittedByContactNumber: "09123456789" };
}
async function monitoringFixture(early = false) {
  const siteId = await site(), reportId = `${prefix}-report-${randomUUID()}`;
  const plantingDate = shiftCalendarDate(today, early ? -6 : -20);
  await db.collection("plantingReports").doc(reportId).create({ participantId: users.participant,
    siteId, eventId: `${prefix}-monitor-event`, verificationStatus: "Approved", quantityPlanted: 100,
    plantingDate, ...(early ? { earlyMonitoring: { enabled: true, applicable: true, policyVersion: 1,
      openingDate: shiftCalendarDate(today, -1), deadlineDate: shiftCalendarDate(today, 5),
      officialOpeningDate: shiftCalendarDate(today, 8) } } : {}) });
  return { plantingReportId: reportId, totalMonitored: 25, healthyCount: 20, damagedCount: 3,
    deadCount: 2, maturityStatus: "Immature", monitoredDate: today, remarks: "Synthetic Phase 5 observation" };
}
async function raw(id) { return (await db.collection("monitoringRecords").doc(id).get()).data(); }
test.before(async () => {
  assert.ok(UPLOAD_ROOT.startsWith(`${os.tmpdir()}${path.sep}`));
  for (const role of ["participant", "other", "staff", "admin"]) {
    const uid = `${prefix}-${role}`, email = `${uid}@example.test`, password = `Synthetic-${randomUUID()}!`;
    await auth.createUser({ uid, email, password, emailVerified: true });
    await db.collection("users").doc(uid).create({ role: role === "other" ? "participant" : role,
      status: "active", fullName: `Synthetic ${role}`, email });
    const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    const body = await response.json(); assert.equal(response.status, 200); tokens[role] = body.idToken; users[role] = uid;
  }
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  allowedPorts.add(String(server.address().port)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await deleteApp(firebaseApp); });
test("authenticated planting upload, retry/filename independence, private retrieval and ownership", async () => {
  const fields = await plantingFixture(), bytes = await image(fields.plantingDate), key = randomUUID();
  const first = ok(await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos"), key));
  const again = ok(await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos", "renamed.jpg"), key));
  assert.equal(first.id, again.id);
  const saved = (await db.collection("plantingReports").doc(first.id).get()).data();
  assert.equal(saved.photos[0].privateEvidence.provider, "firebase");
  const intent = await db.collection("evidenceUploadIntents").doc(saved.photos[0].privateEvidence.uploadIntentId).get();
  assert.equal(intent.data().status, "LINKED");
  const quota = await db.collection("evidenceQuotaReservations").doc(intent.id).get();
  assert.equal(quota.data().state, "FINALIZED"); assert.equal(quota.data().actualFiles, 1);
  for (const role of ["participant", "staff", "admin"]) {
    const result = await api(role, "GET", `/evidence/planting-reports/${first.id}/photos/0`);
    assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes);
    assert.equal(result.response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal((await api("other", "GET", `/evidence/planting-reports/${first.id}/photos/0`)).status, 403);
  const conflict = await api("participant", "POST", "/planting-reports", form({ ...fields, quantityPlanted: 24 }, bytes, "photos"), key);
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
  const imageConflict = await api("participant", "POST", "/planting-reports", form(fields, await image(fields.plantingDate), "photos"), key);
  assert.equal(imageConflict.status, 409);
});
test("cloud no-key requests retain duplicate rejection rather than cross-request deduplication", async () => {
  const fields = await plantingFixture(), bytes = await image(fields.plantingDate);
  const first = ok(await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos")));
  assert.equal((await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos"))).status, 400);
  const records = await db.collection("plantingReports").where("distributionId", "==", fields.distributionId).get();
  assert.equal(records.size, 1); assert.equal(records.docs[0].id, first.id);
});
test("official partial observation, count/remarks reuse and replacement retain immutable revisions and quota", async () => {
  const fields = await monitoringFixture(), bytes = await image(), key = randomUUID();
  const first = ok(await api("participant", "POST", "/monitoring", form(fields, bytes), key));
  const again = ok(await api("participant", "POST", "/monitoring", form(fields, bytes), key));
  assert.equal(first.id, again.id); assert.equal(again.history.length, 1);
  const entry = again.history[0]; assert.equal(entry.survivalRate, 92); assert.equal(entry.mortalityRate, 8);
  assert.equal(entry.isFullCohortAssessment, false); assert.equal(again.nextMonitoringDate, null);
  const route = `/monitoring/${first.id}/observations/${entry.id}`;
  assert.equal((await api("admin", "PATCH", `${route}/approve`, { expectedVersion: 0 })).status, 409);
  ok(await api("staff", "PATCH", `${route}/return`, { expectedVersion: 0, reason: "Check counts" }), 200);
  const correction = { ...fields, expectedVersion: 1, retainEvidenceRevision: 1, healthyCount: 19, damagedCount: 4 };
  const correctionKey = randomUUID();
  const competingCorrections = await Promise.all([
    api("participant", "PATCH", `${route}/resubmit`, form(correction), correctionKey),
    api("participant", "PATCH", `${route}/resubmit`, form(correction), correctionKey),
  ]);
  assert.ok(competingCorrections.every(result => [200, 202].includes(result.status)));
  const corrected = ok(competingCorrections.find(result => result.status === 200), 200);
  const retry = ok(await api("participant", "PATCH", `${route}/resubmit`, form(correction), correctionKey), 200);
  assert.equal(retry.history[0].revisionHistory.length, 2); assert.equal(retry.history[0].id, entry.id);
  let saved = await raw(first.id);
  assert.deepEqual(saved.history[0].privateEvidence, saved.history[0].revisionHistory[0].evidenceRef.privateEvidence);
  const originalRef = saved.history[0].privateEvidence;
  ok(await api("staff", "PATCH", `${route}/return`, { expectedVersion: 2, reason: "Clarify remarks" }), 200);
  const remarks = { ...correction, expectedVersion: 3, remarks: "Clarified remarks" }, remarksKey = randomUUID();
  ok(await api("participant", "PATCH", `${route}/resubmit`, form(remarks), remarksKey), 200);
  ok(await api("staff", "PATCH", `${route}/return`, { expectedVersion: 4, reason: "Replace evidence" }), 200);
  const replacement = await image(), replacementKey = randomUUID(), updated = { ...remarks, expectedVersion: 5 };
  ok(await api("participant", "PATCH", `${route}/resubmit`, form(updated, replacement), replacementKey), 200);
  ok(await api("participant", "PATCH", `${route}/resubmit`, form(updated, replacement), replacementKey), 200);
  saved = await raw(first.id); assert.equal(saved.history[0].revisionHistory.length, 4);
  assert.notEqual(saved.history[0].privateEvidence.objectName, originalRef.objectName);
  for (const [revision, expected] of [[1, bytes], [4, replacement]]) {
    const result = await api("participant", "GET", `/evidence/monitoring/${first.id}/observations/${entry.id}/revisions/${revision}`);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.deepEqual(result.bytes, expected);
  }
  assert.equal((await api("other", "GET", `/evidence/monitoring/${first.id}/observations/${entry.id}/revisions/1`)).status, 403);
  assert.equal((await api("other", "PATCH", `${route}/resubmit`, form(updated), randomUUID())).status, 403);
  ok(await api("staff", "PATCH", `${route}/review`, { expectedVersion: 6 }), 200);
  const approved = ok(await api("admin", "PATCH", `${route}/approve`, { expectedVersion: 7 }), 200);
  assert.equal(approved.history[0].reviewStatus, "Approved"); assert.equal(approved.nextMonitoringDate, null);
  assert.equal(corrected.history[0].revisionNumber, 2);
  const charges = await db.collection("evidenceUploadIntents").where("actorId", "==", users.participant).get();
  const observationCharges = charges.docs.filter(doc => doc.data().recordId === entry.id);
  assert.equal(observationCharges.length, 2); assert.ok(observationCharges.every(doc => doc.data().status === "LINKED"));
});
test("early observation cloud upload and retry preserve official scheduling isolation", async () => {
  const fields = await monitoringFixture(true), bytes = await image(), key = randomUUID();
  const first = ok(await api("participant", "POST", "/monitoring/early", form(fields, bytes), key));
  const retry = ok(await api("participant", "POST", "/monitoring/early", form(fields, bytes), key));
  assert.equal(first.id, retry.id); assert.equal(retry.history.length, 1); assert.equal(retry.history[0].observationType, "early");
  assert.equal(retry.nextMonitoringDate, null);
  const result = await api("participant", "GET", `/evidence/monitoring/${first.id}/photos/0`);
  assert.deepEqual(result.bytes, bytes);
});
test("concurrent authenticated retries persist one observation and one intent", async () => {
  const fields = await monitoringFixture(), bytes = await image(), key = randomUUID();
  const results = await Promise.all([api("participant", "POST", "/monitoring", form(fields, bytes), key),
    api("participant", "POST", "/monitoring", form(fields, bytes), key)]);
  assert.ok(results.every(result => [201, 202].includes(result.status)), JSON.stringify(results.map(r => r.body)));
  const result = ok(results.find(result => result.status === 201));
  const saved = await raw(result.id); assert.equal(saved.history.length, 1);
  assert.equal((await db.collection("evidenceUploadIntents").where("recordId", "==", saved.history[0].id).get()).size, 1);
});
test("Storage success followed by business transaction failure recovers the same upload/quota on retry", async () => {
  const fields = await plantingFixture(), bytes = await image(fields.plantingDate), key = randomUUID();
  const originalTransaction = db.runTransaction.bind(db); let fail = true;
  db.runTransaction = (fn, options) => originalTransaction(async tx => {
    let links = false;
    const proxy = new Proxy(tx, { get(target, prop) {
      if (["create", "update", "set"].includes(prop)) return (ref, ...args) => {
        if (ref.parent.id === "plantingReports") links = true;
        return target[prop](ref, ...args);
      };
      const value = target[prop]; return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await fn(proxy); if (links && fail) { fail = false; throw Error("Synthetic linkage failure"); } return result;
  }, options);
  try {
    const failed = await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos"), key);
    assert.equal(failed.status, 500);
    const intents = await db.collection("evidenceUploadIntents").where("sha256", "==", hash(bytes)).get();
    assert.equal(intents.size, 1); const before = intents.docs[0].data(); assert.equal(before.status, "UPLOADED");
    const result = ok(await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos"), key));
    const after = (await intents.docs[0].ref.get()).data(); assert.equal(after.status, "LINKED");
    assert.equal(after.generation, before.generation);
    assert.equal((await db.collection("plantingReports").where("distributionId", "==", fields.distributionId).get()).size, 1);
    assert.ok(result.id);
  } finally { db.runTransaction = originalTransaction; }
});
test("durably linked business record survives an interrupted HTTP response and same-key replay", async () => {
  const fields = await monitoringFixture(), bytes = await image(), key = randomUUID();
  const originalJson = app.response.json; let interrupt = true;
  app.response.json = function (body) {
    if (interrupt && body.success && body.data?.plantingReportId === fields.plantingReportId) {
      interrupt = false; this.destroy(); return this;
    }
    return originalJson.call(this, body);
  };
  try { await assert.rejects(() => api("participant", "POST", "/monitoring", form(fields, bytes), key)); }
  finally { app.response.json = originalJson; }
  const result = ok(await api("participant", "POST", "/monitoring", form(fields, bytes), key));
  assert.equal(result.history.length, 1);
});
test("guest authorization, cloud linkage, parent photo ordering and retry accounting", async () => {
  const siteId = await site(), eventId = `${prefix}-guest-event`, reportId = `event_${eventId}`, requestId = `${prefix}-guest-request`;
  const participantId = hash(randomUUID()), token = `${participantId}.${hash(randomUUID())}`, contributionId = `${prefix}-guest-contribution`;
  const date = shiftCalendarDate(today, -1);
  await db.collection("events").doc(eventId).create({ name: "Synthetic guest event", date, status: "Ongoing", recordStatus: "Authorized",
    sourceRequestId: requestId, plantingSiteId: siteId, barangay: "Bical", allocationReleasedAt: Timestamp.now(),
    seedlingItems: [{ inventoryId: "synthetic-item", species: "Narra", quantity: 100 }], seedlingTotalQuantity: 100,
    pendingSeedlingsByInventory: { "synthetic-item": 10 }, pendingSeedlingQuantity: 10 });
  await db.collection("seedlingRequests").doc(requestId).create({ eventId, status: "Released", participantId: users.participant });
  await db.collection("plantingReports").doc(reportId).create({ reportType: "parent", eventId, requestId, participantId: users.participant,
    verificationStatus: "Partial", reportingProgress: "Partial", quantityReleased: 100, quantityPlanted: 0 });
  await db.collection("eventParticipants").doc(participantId).create({ participantType: "guest", eventId, sessionHash: hash(token),
    expiresAt: Timestamp.fromMillis(Date.now() + 3600000), fullName: "Synthetic guest" });
  await db.collection("plantingContributions").doc(contributionId).create({ reportId, eventId, participantId,
    contributorId: participantId, participantType: "guest", inventoryId: "synthetic-item", quantity: 10,
    evidencePending: true, allocationReserved: true });
  const bytes = await image(date), key = randomUUID(), route = `/guest-events/session/contributions/${contributionId}/evidence`;
  assert.equal((await api("Guest invalid", "POST", route, form({}, bytes, "photos"), key)).status, 401);
  const own = `Guest ${token}`;
  const strangerId = hash(randomUUID()), strangerToken = `${strangerId}.${hash(randomUUID())}`;
  await db.collection("eventParticipants").doc(strangerId).create({ participantType: "guest", eventId,
    sessionHash: hash(strangerToken), expiresAt: Timestamp.fromMillis(Date.now() + 3600000) });
  assert.equal((await api(`Guest ${strangerToken}`, "POST", route, form({}, bytes, "photos"), key)).status, 400);
  ok(await api(own, "POST", route, form({}, bytes, "photos"), key), 200);
  ok(await api(own, "POST", route, form({}, bytes, "photos"), key), 200);
  const report = ok(await api("staff", "GET", `/planting-reports/${reportId}`), 200);
  assert.equal(report.photos.length, 1); assert.equal(report.quantityPlanted, 10);
  const result = await api("staff", "GET", `/evidence/planting-reports/${reportId}/photos/0`);
  assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes);
  assert.equal((await api("other", "GET", `/evidence/planting-reports/${reportId}/photos/0`)).status, 403);
  const saved = (await db.collection("plantingContributions").doc(contributionId).get()).data();
  assert.equal(saved.photos.length, 1);
  const quota = (await db.collection("evidenceQuotaReservations").doc(saved.photos[0].privateEvidence.uploadIntentId).get()).data();
  assert.equal(quota.actualFiles, 1);
});
test("legacy local evidence remains privately retrievable in mixed cloud mode", async () => {
  const reportId = `${prefix}-legacy-report`, bytes = await image(), directory = path.join(UPLOAD_ROOT, "planting-reports", prefix);
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "local.jpg"), bytes, { flag: "wx" });
  await db.collection("plantingReports").doc(reportId).create({ participantId: users.participant, photos: [{ photoURL: `/uploads/planting-reports/${prefix}/local.jpg` }] });
  const result = await api("participant", "GET", `/evidence/planting-reports/${reportId}/photos/0`);
  assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes);
  assert.equal((await api("other", "GET", `/evidence/planting-reports/${reportId}/photos/0`)).status, 403);
});
test("registered request-linked contributions preserve parent aggregation, immutable target and photo index", async () => {
  const fields = await plantingFixture(true), bytes = await image(fields.plantingDate), key = randomUUID();
  const first = ok(await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos"), key));
  const again = ok(await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos"), key));
  assert.equal(first.id, again.id); assert.equal(again.photos.length, 1);
  assert.equal((await db.collection("plantingContributions").where("reportId", "==", first.id).get()).size, 1);
  const result = await api("participant", "GET", `/evidence/planting-reports/${first.id}/photos/0`);
  assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes);
});
test("invalid site GPS cannot be retained on correction and requires a new immutable image", async () => {
  const fields = await monitoringFixture(), bytes = await image(today, true);
  const first = ok(await api("participant", "POST", "/monitoring", form(fields, bytes), randomUUID()));
  const entry = first.history[0], route = `/monitoring/${first.id}/observations/${entry.id}`;
  ok(await api("staff", "PATCH", `${route}/return`, { expectedVersion: 0, reason: "Invalid site GPS" }), 200);
  const correction = { ...fields, expectedVersion: 1, retainEvidenceRevision: 1 };
  const invalid = await api("participant", "PATCH", `${route}/resubmit`, form(correction), randomUUID());
  assert.equal(invalid.status, 422); assert.equal(invalid.body.code, "OBSERVATION_EVIDENCE_INVALID");
  const replacement = await image();
  const corrected = ok(await api("participant", "PATCH", `${route}/resubmit`, form(correction, replacement), randomUUID()), 200);
  assert.equal(corrected.history[0].revisionNumber, 2); assert.equal(corrected.history[0].siteGpsValid, true);
});
test("missing objects, forged cross-record references and wrong generations have no local fallback or path disclosure", async () => {
  const fields = await plantingFixture(), bytes = await image(fields.plantingDate);
  const created = ok(await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos"), randomUUID()));
  const doc = db.collection("plantingReports").doc(created.id), saved = (await doc.get()).data(), reference = saved.photos[0].privateEvidence;
  try {
    for (const mutation of [
      { ...reference, generation: (BigInt(reference.generation) + 1n).toString() },
      { ...reference, objectName: reference.objectName.replace(created.id, "unrelated-record") },
      { ...reference, uploadIntentId: "00000000-0000-4000-8000-000000000000", objectName: `evidence/v1/planting-report/${created.id}/00000000-0000-4000-8000-000000000000` },
    ]) {
      await doc.update({ photos: [{ ...saved.photos[0], privateEvidence: mutation }] });
      const result = await api("participant", "GET", `/evidence/planting-reports/${created.id}/photos/0`);
      assert.ok([404, 500].includes(result.status)); assert.equal(JSON.stringify(result.body).includes("evidence/v1"), false);
    }
  } finally { await doc.update({ photos: saved.photos }); }
});
test("failed Storage upload leaves no business linkage and retries the original intent safely", async () => {
  const fields = await plantingFixture(), bytes = await image(fields.plantingDate), key = randomUUID();
  const prototype = Object.getPrototypeOf(getStorageBucket().file("synthetic-unused-handle")), originalSave = prototype.save;
  let fail = true;
  prototype.save = async function (...args) {
    if (fail && this.name.startsWith("evidence/v1/planting-report/")) {
      fail = false; throw Object.assign(Error("Synthetic unavailable Storage"), { code: 503 });
    }
    return originalSave.apply(this, args);
  };
  try {
    const failed = await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos"), key);
    assert.equal(failed.status, 503); assert.equal(failed.body.code, "EVIDENCE_RECONCILIATION_REQUIRED");
    assert.equal((await db.collection("plantingReports").where("distributionId", "==", fields.distributionId).get()).size, 0);
    const before = await db.collection("evidenceUploadIntents").where("sha256", "==", hash(bytes)).get();
    assert.equal(before.size, 1); assert.equal(before.docs[0].data().status, "RECONCILIATION_REQUIRED");
    const result = ok(await api("participant", "POST", "/planting-reports", form(fields, bytes, "photos"), key));
    assert.equal((await before.docs[0].ref.get()).data().status, "LINKED");
    assert.equal((await db.collection("evidenceUploadIntents").where("sha256", "==", hash(bytes)).get()).size, 1);
    assert.ok(result.id);
  } finally { prototype.save = originalSave; }
});

test("browser-camera planting report completes authenticated HTTP submission and idempotent retry", async () => {
  const fields = await plantingFixture(), bytes = await image(fields.plantingDate);
  const binding = { workflow: "planting-report", siteId: fields.siteId,
    eventId: fields.eventId, distributionId: fields.distributionId };
  const camera = await browserCameraEvidence(binding, bytes), key = randomUUID();
  const blocked = await api("participant", "POST", "/planting-reports",
    form({ ...fields, quantityPlanted: 0, evidenceManifest: camera.evidenceManifest }, bytes, "photos"), key);
  assert.equal(blocked.status, 400);
  assert.equal((await db.collection("evidenceCaptureSessions").doc(camera.session.captureSessionId).get()).data().state, "VERIFIED");
  const first = ok(await api("participant", "POST", "/planting-reports",
    form({ ...fields, evidenceManifest: camera.evidenceManifest }, bytes, "photos"), key));
  const retry = ok(await api("participant", "POST", "/planting-reports",
    form({ ...fields, evidenceManifest: camera.evidenceManifest }, bytes, "photos"), key));
  assert.equal(retry.id, first.id);
  await assertConsumed(camera, first.id);
  const saved = (await db.collection("plantingReports").doc(first.id).get()).data();
  assert.equal(saved.photos[0].evidenceSource, "browser-camera");
  assert.equal(saved.photos[0].captureSessionAuditId, camera.session.captureSessionId);
  await assertPrivateObject(saved.photos[0].privateEvidence, bytes);
  assert.equal((await api("participant", "GET", `/evidence/planting-reports/${first.id}/photos/0`)).status, 200);
  assert.equal((await api("other", "GET", `/evidence/planting-reports/${first.id}/photos/0`)).status, 403);
  assert.equal((await api("participant", "POST", "/planting-reports",
    form({ ...fields, evidenceManifest: camera.evidenceManifest }, bytes, "photos"), randomUUID())).status, 400);
});

test("browser-camera early monitoring persists privately without advancing official schedule", async () => {
  const fields = await monitoringFixture(true), reportBefore = (await db.collection("plantingReports").doc(fields.plantingReportId).get()).data();
  const bytes = await image(), binding = { workflow: "monitoring-early",
    plantingReportId: fields.plantingReportId, siteId: reportBefore.siteId };
  const camera = await browserCameraEvidence(binding, bytes), key = randomUUID();
  const first = ok(await api("participant", "POST", "/monitoring/early",
    form({ ...fields, siteId: reportBefore.siteId, evidenceManifest: camera.evidenceManifest }, bytes), key));
  const retry = ok(await api("participant", "POST", "/monitoring/early",
    form({ ...fields, siteId: reportBefore.siteId, evidenceManifest: camera.evidenceManifest }, bytes), key));
  assert.equal(retry.id, first.id);
  const observation = retry.history[0];
  assert.equal(observation.observationType, "early");
  assert.equal(observation.evidenceSource, "browser-camera");
  assert.equal(retry.nextMonitoringDate, null);
  await assertConsumed(camera, `${first.id}:${observation.id}`);
  const saved = await raw(first.id);
  await assertPrivateObject(saved.history[0].privateEvidence, bytes);
  const reportAfter = (await db.collection("plantingReports").doc(fields.plantingReportId).get()).data();
  assert.deepEqual(reportAfter.nextMonitoringDate, reportBefore.nextMonitoringDate);
  assert.equal((await api("participant", "GET", `/evidence/monitoring/${first.id}/photos/0`)).status, 200);
  assert.equal((await api("other", "GET", `/evidence/monitoring/${first.id}/photos/0`)).status, 403);
});

test("browser-camera official monitoring preserves partial-observation KPI scheduling rules", async () => {
  const fields = await monitoringFixture(), report = (await db.collection("plantingReports").doc(fields.plantingReportId).get()).data();
  const bytes = await image(), camera = await browserCameraEvidence({ workflow: "monitoring-official",
    plantingReportId: fields.plantingReportId, siteId: report.siteId }, bytes), key = randomUUID();
  const first = ok(await api("participant", "POST", "/monitoring",
    form({ ...fields, siteId: report.siteId, evidenceManifest: camera.evidenceManifest }, bytes), key));
  const retry = ok(await api("participant", "POST", "/monitoring",
    form({ ...fields, siteId: report.siteId, evidenceManifest: camera.evidenceManifest }, bytes), key));
  assert.equal(retry.id, first.id);
  const observation = retry.history[0];
  assert.equal(observation.observationType, "official");
  assert.equal(observation.evidenceSource, "browser-camera");
  assert.equal(observation.survivalRate, 92);
  assert.equal(observation.isFullCohortAssessment, false);
  assert.equal(retry.nextMonitoringDate, null);
  await assertConsumed(camera, `${first.id}:${observation.id}`);
  const saved = await raw(first.id);
  await assertPrivateObject(saved.history[0].privateEvidence, bytes);
  assert.equal((await api("participant", "GET", `/evidence/monitoring/${first.id}/photos/0`)).status, 200);
  assert.equal((await api("other", "GET", `/evidence/monitoring/${first.id}/photos/0`)).status, 403);
});

test("browser-camera monitoring resubmission after Staff Return atomically replaces evidence", async () => {
  const fields = await monitoringFixture(), report = (await db.collection("plantingReports").doc(fields.plantingReportId).get()).data();
  const originalBytes = await image(), originalCamera = await browserCameraEvidence({ workflow: "monitoring-official",
    plantingReportId: fields.plantingReportId, siteId: report.siteId }, originalBytes);
  const created = ok(await api("participant", "POST", "/monitoring", form({ ...fields, siteId: report.siteId,
    evidenceManifest: originalCamera.evidenceManifest }, originalBytes), randomUUID()));
  const observation = created.history[0], route = `/monitoring/${created.id}/observations/${observation.id}`;
  ok(await api("staff", "PATCH", `${route}/return`, { expectedVersion: 0, reason: "Retake evidence" }), 200);
  const replacement = await image(), replacementCamera = await browserCameraEvidence({ workflow: "monitoring-resubmit",
    plantingReportId: fields.plantingReportId, siteId: report.siteId, monitoringId: created.id,
    observationId: observation.id, expectedVersion: 1 }, replacement), key = randomUUID();
  const payload = { ...fields, siteId: report.siteId, expectedVersion: 1,
    evidenceManifest: replacementCamera.evidenceManifest };
  const updated = ok(await api("participant", "PATCH", `${route}/resubmit`, form(payload, replacement), key), 200);
  const retry = ok(await api("participant", "PATCH", `${route}/resubmit`, form(payload, replacement), key), 200);
  assert.equal(retry.history[0].revisionNumber, updated.history[0].revisionNumber);
  assert.equal(retry.history[0].reviewStatus, "Pending Review");
  assert.equal(retry.history[0].evidenceSource, "browser-camera");
  await assertConsumed(replacementCamera, `${created.id}:${observation.id}:2`);
  const saved = await raw(created.id);
  await assertPrivateObject(saved.history[0].privateEvidence, replacement);
  assert.equal((await api("participant", "GET", `/evidence/monitoring/${created.id}/observations/${observation.id}/revisions/2`)).status, 200);
  assert.equal((await api("other", "GET", `/evidence/monitoring/${created.id}/observations/${observation.id}/revisions/2`)).status, 403);
});
