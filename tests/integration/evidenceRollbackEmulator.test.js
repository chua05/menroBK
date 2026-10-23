// Phase 8B: authenticated READ-ONLY cloud capability after local-provider rollback.
// UUID synthetic fixtures only. Never reset quotas/collections or delete evidence.
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), https = require('node:https');
if (process.env.FIREBASE_CONFIG) {
  const c = JSON.parse(process.env.FIREBASE_CONFIG);
  assert.equal(c.projectId, 'demo-menro-phase2');
  assert.ok(Object.keys(c).every(k => ['projectId', 'databaseURL', 'storageBucket'].includes(k)));
  if (c.databaseURL) assert.equal(c.databaseURL, 'https://demo-menro-phase2.firebaseio.com');
  if (c.storageBucket) assert.ok(['demo-menro-phase2.appspot.com', 'demo-menro-phase2.firebasestorage.app'].includes(c.storageBucket));
  delete process.env.FIREBASE_CONFIG;
}
const { resolveEvidenceStorageConfig } = require('../../src/config/evidenceStorage');
const initial = resolveEvidenceStorageConfig();
assert.equal(initial.provider, 'local'); assert.equal(initial.cloudRead, true); assert.equal(initial.cloudWorkflow, undefined);
const ports = new Set(['8080', '9099', '9199']);
const request = http.request, fetchNative = globalThis.fetch;
let objectReads = 0;
http.request = function(input, ...args) {
  const u = typeof input === 'string' || input instanceof URL ? new URL(input) :
    new URL(input.path || '/', `http://${input.hostname || input.host}:${input.port}`);
  if (u.hostname !== '127.0.0.1' || !ports.has(u.port)) throw Error('Non-emulator HTTP prohibited');
  if (u.port === '9199' && u.pathname.includes('/o/')) objectReads++;
  return request.call(this, input, ...args);
};
https.request = () => { throw Error('Cloud HTTPS prohibited'); };
globalThis.fetch = (input, init) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !ports.has(u.port)) throw Error('Non-emulator fetch prohibited');
  return fetchNative(input, init);
};
const sharp = require('sharp');
const { app: firebaseApp, auth, db, getStorageBucket } = require('../../src/config/firebase');
const { deleteApp } = require('firebase-admin/app');
const { createFirebaseEvidenceStorage } = require('../../src/services/firebaseEvidenceStorage.service');
const { UPLOAD_ROOT } = require('../../src/config/uploadRoot');
const { dateOnlyInManila, shiftCalendarDate } = require('../../src/utils/earlyMonitoring.util');
const prefix = `rollback8b-${randomUUID()}`, ids = {}, tokens = {};
let server, base, bytes, cloudPhoto, rootPhoto, earlyPhoto, officialPhoto, history, beforeIntents;
const report = db.collection('plantingReports').doc(`${prefix}-report`);
const root = db.collection('plantingReports').doc(`${prefix}-root`);
const local = db.collection('plantingReports').doc(`${prefix}-local`);
const monitoring = db.collection('monitoringRecords').doc(`${prefix}-monitoring`);
const earlyId = `${prefix}-early`, officialId = `${prefix}-official`;
const cloudPath = `/evidence/planting-reports/${report.id}/photos/0`;
async function api(role, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}/api${route}`, { method,
    headers: role ? { authorization: `Bearer ${tokens[role]}` } : {}, body });
  if (response.headers.get('content-type')?.startsWith('image/')) return { status: response.status, response, bytes: Buffer.from(await response.arrayBuffer()) };
  const data = await response.json(), json = JSON.stringify(data);
  assert.ok(!json.includes('evidence/v1/') && !json.includes('privateEvidence') && !json.includes(UPLOAD_ROOT));
  return { status: response.status, response, data };
}
async function seedPhoto(recordId, evidenceType, uid) {
  // Trusted fixture setup reuses existing adapter/user quota, NOT migration accounting.
  // No application cloud workflow/write gate is enabled, even during fixture setup.
  const storage = createFirebaseEvidenceStorage({ db, getBucket: getStorageBucket, log() {} });
  const context = storage.serverContext({ actor: { uid }, evidenceType, recordId });
  const image = { buffer: bytes, contentType: 'image/png' };
  const { intentId } = await storage.reserve(context, image);
  return storage.upload(context, intentId, image);
}
async function intents() {
  return Promise.all([cloudPhoto, rootPhoto, earlyPhoto, officialPhoto].map(async ref => {
    const intent = (await db.collection('evidenceUploadIntents').doc(ref.uploadIntentId).get()).data();
    const quota = (await db.collection('evidenceQuotaReservations').doc(ref.uploadIntentId).get()).data();
    const daily = (await db.collection('evidenceQuotaDays').doc(`${intent.quotaDay}_${intent.quotaActorKey}`).get()).data();
    return { intent, quota, daily };
  }));
}
test.before(async () => {
  assert.ok(UPLOAD_ROOT.startsWith(os.tmpdir() + path.sep));
  bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#168a45' } }).png().toBuffer();
  for (const role of ['owner', 'reporter', 'other', 'staff', 'admin']) {
    const uid = `${prefix}-${role}`, email = `${uid}@example.test`, password = `Synthetic-${randomUUID()}!`;
    await auth.createUser({ uid, email, password, emailVerified: true }); ids[role] = uid;
    await db.collection('users').doc(uid).create({ role: ['staff', 'admin'].includes(role) ? role : 'participant', status: 'active', email, fullName: 'Synthetic user' });
    const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    assert.equal(r.status, 200); tokens[role] = (await r.json()).idToken;
  }
  cloudPhoto = await seedPhoto(report.id, 'planting-report', ids.owner);
  rootPhoto = await seedPhoto(root.id, 'planting-report', ids.owner);
  earlyPhoto = await seedPhoto(earlyId, 'monitoring-early', ids.reporter);
  officialPhoto = await seedPhoto(officialId, 'monitoring-official', ids.reporter);
  const plantingPath = `planting-reports/${prefix}/original.png`, monitoringPath = `monitoring/${prefix}/old.png`;
  for (const p of [plantingPath, monitoringPath]) {
    await fs.mkdir(path.dirname(path.join(UPLOAD_ROOT, p)), { recursive: true });
    await fs.writeFile(path.join(UPLOAD_ROOT, p), bytes, { flag: 'wx' });
  }
  await report.create({ participantId: ids.owner, photos: [{ privateEvidence: cloudPhoto, photoPath: plantingPath }] });
  await root.create({ participantId: ids.owner, photoPath: plantingPath, privateEvidence: rootPhoto });
  await local.create({ participantId: ids.owner, photoPath: plantingPath });
  history = [
    { id: earlyId, observationType: 'early', originalReporterId: ids.reporter, reviewStatus: 'Approved',
      totalMonitored: 25, healthyCount: 20, damagedCount: 3, deadCount: 2, privateEvidence: earlyPhoto,
      photoUrl: `/uploads/${monitoringPath}`, revisionHistory: [
        { revisionNumber: 1, evidenceRef: { photoUrl: `/uploads/${monitoringPath}` } },
        { revisionNumber: 2, evidenceRef: { privateEvidence: earlyPhoto, photoUrl: `/uploads/${monitoringPath}` } }] },
    { id: officialId, observationType: 'official', originalReporterId: ids.reporter, reviewStatus: 'Reviewed',
      privateEvidence: officialPhoto, revisionHistory: [{ revisionNumber: 1, evidenceRef: { privateEvidence: officialPhoto } }] },
  ];
  await monitoring.create({ participantId: ids.owner, quantityPlanted: 100, nextMonitoringDate: '2026-12-01', history });
  beforeIntents = await intents();
  // First application startup is ALREADY local uploads + read-only cloud capability.
  server = require('../../src/app').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  ports.add(String(server.address().port)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await deleteApp(firebaseApp); });

test('local-only legacy root evidence retains private headers and requires authentication', async () => {
  const url = `/evidence/planting-reports/${local.id}/photos/0`;
  assert.equal((await api(null, url)).status, 401);
  const r = await api('owner', url); assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes);
  assert.equal(r.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.response.headers.get('x-content-type-options'), 'nosniff');
});
test('rollback-started API reads saved cloud evidence for owner/Staff/Admin with unchanged bytes', async () => {
  for (const role of ['owner', 'staff', 'admin']) {
    const r = await api(role, cloudPath); assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes);
    assert.equal(r.response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(require('../../src/services/evidenceWorkflow.service').enabled(), false);
});
test('missing auth and unrelated participant are rejected before any Storage object request', async () => {
  const before = objectReads;
  assert.equal((await api(null, cloudPath)).status, 401);
  assert.equal((await api('other', cloudPath)).status, 403);
  assert.equal(objectReads, before);
});
test('cloud root-only planting reference is preserved during local-provider rollback', async () => {
  const r = await api('owner', `/evidence/planting-reports/${root.id}/photos/0`);
  assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes);
});
test('early and official current observations retain exact type/reporter and owner authorization', async () => {
  for (const index of [0, 1]) for (const role of ['owner', 'reporter', 'staff', 'admin']) {
    const r = await api(role, `/evidence/monitoring/${monitoring.id}/photos/${index}`);
    assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes);
  }
  assert.equal((await api('other', `/evidence/monitoring/${monitoring.id}/photos/0`)).status, 403);
});
test('local and cloud monitoring revisions preserve narrower reporter/Staff/Admin authorization', async () => {
  for (const [obs, rev] of [[earlyId, 1], [earlyId, 2], [officialId, 1]]) {
    const url = `/evidence/monitoring/${monitoring.id}/observations/${obs}/revisions/${rev}`;
    for (const role of ['reporter', 'staff', 'admin']) {
      const r = await api(role, url); assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes);
    }
    assert.equal((await api('owner', url)).status, 403); assert.equal((await api('other', url)).status, 403);
  }
});
test('malformed explicit cloud references never select an existing local alias', async () => {
  const original = (await report.get()).data();
  try {
    for (const ref of [false, '', {}, { ...cloudPhoto, provider: 'local' }, { ...cloudPhoto, bucket: 'menrosystem-ddfac.firebasestorage.app' }]) {
      await report.update({ photos: [{ ...original.photos[0], privateEvidence: ref }] });
      const before = objectReads, r = await api('owner', cloudPath);
      assert.ok([404, 500].includes(r.status)); assert.equal(r.bytes, undefined); assert.equal(objectReads, before);
    }
  } finally { await report.update({ photos: original.photos }); await root.update({ privateEvidence: rootPhoto }); }
});
test('explicitly cleared null marker preserves legitimate local replacement and retained cloud revisions', async () => {
  try {
    const replacement = { ...history[0], privateEvidence: null };
    await monitoring.update({ history: [replacement, history[1]] });
    const r = await api('reporter', `/evidence/monitoring/${monitoring.id}/photos/0`);
    assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes);
    const revision = await api('reporter', `/evidence/monitoring/${monitoring.id}/observations/${earlyId}/revisions/2`);
    assert.equal(revision.status, 200); assert.deepEqual(revision.bytes, bytes);
  } finally { await monitoring.update({ history }); }
});
test('missing object and wrong generation fail without reading local shadow evidence', async () => {
  const original = (await report.get()).data(), intent = randomUUID();
  try {
    for (const ref of [{ ...cloudPhoto, uploadIntentId: intent, objectName: `evidence/v1/planting-report/${report.id}/${intent}` },
      { ...cloudPhoto, generation: '18446744073709551615' }]) {
      await report.update({ photos: [{ ...original.photos[0], privateEvidence: ref }] });
      const r = await api('owner', cloudPath); assert.ok([404, 500].includes(r.status)); assert.equal(r.bytes, undefined);
    }
  } finally { await report.update({ photos: original.photos }); }
});
test('read flag revocation/default-local fails closed; re-enabling reads restores saved evidence', async () => {
  try {
    for (const flag of ['false', undefined]) {
      if (flag === undefined) delete process.env.EVIDENCE_CLOUD_READ_ENABLED; else process.env.EVIDENCE_CLOUD_READ_ENABLED = flag;
      const before = objectReads; assert.equal((await api('owner', cloudPath)).status, 404); assert.equal(objectReads, before);
      assert.equal((await api('owner', `/evidence/planting-reports/${local.id}/photos/0`)).status, 200);
    }
  } finally { process.env.EVIDENCE_CLOUD_READ_ENABLED = 'true'; }
  assert.equal((await api('owner', cloudPath)).status, 200);
});
test('existing write-enabled configuration remains read-compatible and rollback returns to read-only', async () => {
  try {
    process.env.EVIDENCE_STORAGE_PROVIDER = 'firebase'; process.env.EVIDENCE_CLOUD_WORKFLOW_ENABLED = 'true';
    assert.equal((await api('owner', cloudPath)).status, 200);
    process.env.EVIDENCE_CLOUD_WORKFLOW_ENABLED = 'false';
    assert.equal(require('../../src/services/evidenceWorkflow.service').enabled(), false);
    assert.equal((await api('owner', cloudPath)).status, 200);
  } finally { process.env.EVIDENCE_STORAGE_PROVIDER = 'local'; process.env.EVIDENCE_CLOUD_WORKFLOW_ENABLED = 'false'; }
  assert.equal((await api('owner', cloudPath)).status, 200);
});
test('new application submission after rollback writes local evidence, not cloud intents/quota', async () => {
  const today = dateOnlyInManila(), date = shiftCalendarDate(today, -2), siteId = `${prefix}-site`, eventId = `${prefix}-event`, distributionId = `${prefix}-distribution`;
  await db.collection('sites').doc(siteId).create({ siteName: 'Synthetic rollback site', barangay: 'Bical', latitude: 12.671, longitude: 123.875, coverageRadiusMeters: 100, status: 'Active' });
  await db.collection('events').doc(eventId).create({ name: 'Synthetic rollback event', date, status: 'Ongoing', recordStatus: 'Authorized', plantingSiteId: siteId, barangay: 'Bical' });
  await db.collection('distributions').doc(distributionId).create({ status: 'Released', participantId: ids.owner, participantName: 'Synthetic owner', eventId, plantingSiteId: siteId, quantityReleased: 100, species: 'Narra' });
  const photo = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#168a45' } }).jpeg().withMetadata({ exif: {
    IFD0: { Make: 'Synthetic camera', ImageDescription: randomUUID() }, IFD2: { DateTimeOriginal: `${date.replaceAll('-', ':')} 00:00:00` },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '12/1 40/1 156/10', GPSLongitudeRef: 'E', GPSLongitude: '123/1 52/1 30/1' } } }).toBuffer();
  const form = new FormData();
  for (const [k, v] of Object.entries({ distributionId, siteId, eventId, barangay: 'Bical', quantityPlanted: 25, plantingDate: date,
    plantingLocation: 'Synthetic rollback site', submittedByName: 'Synthetic owner', submittedBySector: 'Volunteer', submittedByContactNumber: '09123456789' })) form.append(k, String(v));
  form.append('photos', new Blob([photo], { type: 'image/jpeg' }), 'synthetic.jpg');
  const r = await api('owner', '/planting-reports', { method: 'POST', body: form }); assert.equal(r.status, 201, JSON.stringify(r.data));
  const saved = (await db.collection('plantingReports').doc(r.data.data.id).get()).data();
  assert.equal(saved.photos[0].privateEvidence, undefined); assert.ok(saved.photos[0].photoPath);
  assert.deepEqual(await intents(), beforeIntents);
});
test('read operations preserve all original monitoring/revision/scheduling and upload audit data', async () => {
  const saved = (await monitoring.get()).data();
  assert.deepEqual(saved.history, history); assert.equal(saved.nextMonitoringDate, '2026-12-01'); assert.equal(saved.quantityPlanted, 100);
  assert.deepEqual(await intents(), beforeIntents);
});
