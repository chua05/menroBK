// Isolated synthetic namespaces only. Never reset shared collections or quotas.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const http = require('node:http'), https = require('node:https');
if (process.env.FIREBASE_CONFIG) {
  const c = JSON.parse(process.env.FIREBASE_CONFIG);
  assert.equal(c.projectId, 'demo-menro-phase2');
  assert.ok(Object.keys(c).every(k => ['projectId', 'databaseURL', 'storageBucket'].includes(k)));
  if (c.databaseURL) assert.equal(c.databaseURL, 'https://demo-menro-phase2.firebaseio.com');
  if (c.storageBucket) assert.ok(['demo-menro-phase2.appspot.com', 'demo-menro-phase2.firebasestorage.app'].includes(c.storageBucket));
  delete process.env.FIREBASE_CONFIG;
}
if (process.env.MENRO_HISTORICAL_MIGRATION !== 'true') throw Error('Explicit migration gate required');
const nativeRequest = http.request;
http.request = function(input, ...args) {
  const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.path || '/', `http://${input.hostname || input.host}:${input.port}`);
  if (url.hostname !== '127.0.0.1' || !['8080', '9199', '9099'].includes(url.port)) throw Error('Non-emulator HTTP blocked');
  return nativeRequest.call(this, input, ...args);
};
https.request = () => { throw Error('Cloud HTTPS blocked'); };
const sharp = require('sharp');
const { app, db, getStorageBucket } = require('../../src/config/firebase');
const { deleteApp } = require('firebase-admin/app');
const { createHistoricalEvidenceMigration } = require('../../src/services/historicalEvidenceMigration.service');
const { createEvidenceUploadQuota } = require('../../src/services/evidenceUploadQuota.service');
const { sha, canonical } = require('../../src/utils/historicalEvidenceClassification.util');
const ledger = db.collection('historicalEvidenceMigrations');
const strip = data => JSON.parse(JSON.stringify(data, (key, value) => key === 'privateEvidence' ? undefined : value));
let shared;
async function fixture(kind = 'photo', fault) {
  const namespace = `scan6b-${randomUUID()}-`, id = s => namespace + s;
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'menro-migration-'));
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'menro-migration-report-'));
  const folder = kind === 'monitoring' ? 'monitoring' : 'planting-reports', relative = `${folder}/synthetic/original.png`;
  await fs.mkdir(path.dirname(path.join(evidenceRoot, relative)), { recursive: true });
  const bytes = await sharp(randomBytes(8 * 8 * 3), { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer();
  await fs.writeFile(path.join(evidenceRoot, relative), bytes);
  const photo = { photoPath: relative, imageHash: sha(bytes), imageDetails: { format: 'png', width: 8, height: 8 } };
  await db.collection('users').doc(id('user')).create({ role: 'participant', status: 'active' });
  await db.collection('sites').doc(id('site')).create({ name: 'Synthetic migration site' });
  await db.collection('events').doc(id('event')).create({ name: 'Synthetic migration event' });
  const report = { participantId: id('user'), eventId: id('event'), siteId: id('site'), reviewStatus: 'Approved', quantityPlanted: 100 };
  let collection = 'plantingReports', recordId = id('report');
  if (kind === 'root') Object.assign(report, photo);
  else if (kind !== 'monitoring' && kind !== 'contribution') report.photos = [photo];
  if (kind === 'contribution') report.reportType = 'parent';
  await db.collection('plantingReports').doc(id('report')).create(report);
  if (kind === 'contribution') {
    await db.collection('eventParticipants').doc(id('guest')).create({ eventId: id('event'), participantType: 'guest' });
    collection = 'plantingContributions'; recordId = id('contribution');
    await db.collection(collection).doc(recordId).create({ reportId: id('report'), eventId: id('event'),
      participantId: id('guest'), contributorId: id('guest'), photos: [photo], quantity: 5 });
  }
  if (kind === 'monitoring') {
    collection = 'monitoringRecords'; recordId = id('lifecycle');
    const evidence = { photoUrl: `/uploads/${relative}`, imageHash: photo.imageHash, imageDetails: photo.imageDetails };
    await db.collection(collection).doc(recordId).create({ plantingReportId: id('report'), siteId: id('site'), participantId: id('user'),
      nextMonitoringDate: '2026-11-20', quantityPlanted: 100, history: [{ id: id('OBS'), observationType: 'official', originalReporterId: id('user'),
        monitoredDate: '2026-10-20', currentEvidenceRevision: 1, reviewStatus: 'Approved', totalMonitored: 100, healthyCount: 90, damagedCount: 5, deadCount: 5,
        ...evidence, revisionHistory: [{ revisionNumber: 1, evidenceRevision: 1, evidenceRef: evidence },
          { revisionNumber: 2, evidenceRevision: 1, reusedEvidence: true, evidenceRef: evidence }] }] });
  }
  const ref = db.collection(collection).doc(recordId), before = (await ref.get()).data();
  const options = { db, getBucket: getStorageBucket, namespace, evidenceRoot, outputDirectory, ...(fault ? { fault } : {}) };
  return { namespace, id, root: evidenceRoot, outputDirectory, relative, bytes, ref, before,
    service: createHistoricalEvidenceMigration(options), options };
}
test.after(() => deleteApp(app));
test('dry-run defaults to no business/ledger/quota/Storage writes', async () => {
  shared = await fixture();
  const before = (await ledger.where('namespace', '==', shared.namespace).get()).size;
  const result = await shared.service.execute(); assert.equal(result.mode, 'dry-run'); assert.equal(result.eligibleOperations, 1);
  assert.equal((await ledger.where('namespace', '==', shared.namespace).get()).size, before);
  assert.deepEqual((await shared.ref.get()).data(), shared.before);
});
test('eligible original migrates privately, successful quota finalized once and repeated execution reuses it', async () => {
  let result = await shared.service.execute({ executeEmulator: true });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].verified, true, JSON.stringify(result));
  const doc = (await ledger.doc(result.results[0].id).get()).data();
  assert.equal(doc.status, 'VERIFIED'); assert.equal(doc.retentionPolicy, 'retain-no-ttl-v1');
  const intent = (await db.collection('evidenceUploadIntents').doc(doc.intentId).get()).data();
  assert.equal(intent.actorKind, 'migration'); assert.equal(intent.actorId, 'historical-evidence-v1'); assert.equal(intent.status, 'LINKED');
  const charge = (await db.collection('evidenceQuotaReservations').doc(doc.intentId).get()).data();
  assert.equal(charge.actualFiles, 1); assert.equal(charge.actorKind, 'migration');
  result = await shared.service.execute({ executeEmulator: true }); assert.ok(result.results.every(r => r.verified));
  assert.equal((await db.collection('evidenceQuotaReservations').doc(doc.intentId).get()).data().actualFiles, 1);
  assert.deepEqual(strip((await shared.ref.get()).data()), strip(shared.before));
  assert.deepEqual(await fs.readFile(path.join(shared.root, shared.relative)), shared.bytes);
  assert.ok(!JSON.stringify(result).includes('objectName'));
});
test('read-only verification and rollback assessment do not modify ledger or business data', async () => {
  const rows = (await ledger.where('namespace', '==', shared.namespace).get()).docs.map(d => d.data());
  const result = await shared.service.verify(); assert.ok(result.results.every(r => r.verified)); assert.equal(result.writes, 0);
  await shared.service.rollbackAssessment();
  assert.equal(canonical((await ledger.where('namespace', '==', shared.namespace).get()).docs.map(d => d.data())), canonical(rows));
});
test('legacy root-only planting reference has tested private retrieval compatibility', async () => {
  const f = await fixture('root'), result = await f.service.execute({ executeEmulator: true });
  assert.ok(result.results[0]?.verified, JSON.stringify(result));
  const access = require('../../src/services/evidenceAccess.service');
  const resolved = await access.plantingEvidenceForUser(f.ref.id, '0', { uid: f.id('user'), role: 'participant' });
  assert.equal(resolved.provider, 'firebase');
  await assert.rejects(access.plantingEvidenceForUser(f.ref.id, '0', { uid: f.id('other'), role: 'participant' }), { code: 'EVIDENCE_FORBIDDEN' });
});
test('monitoring current/reused revision references share one operation and preserve history and schedule', async () => {
  const f = await fixture('monitoring'), result = await f.service.execute({ executeEmulator: true });
  assert.equal(result.results.length, 1); assert.ok(result.results[0].verified, JSON.stringify(result));
  const data = (await f.ref.get()).data(); assert.deepEqual(strip(data), strip(f.before));
  assert.deepEqual(data.history[0].privateEvidence, data.history[0].revisionHistory[0].evidenceRef.privateEvidence);
  assert.equal((await f.service.verify()).results[0].verified, true);
});
test('contribution migration preserves parent aggregation inputs without independently rewriting parent', async () => {
  const f = await fixture('contribution'); const parent = db.collection('plantingReports').doc(f.id('report'));
  const before = (await parent.get()).data(); const result = await f.service.execute({ executeEmulator: true });
  assert.ok(result.results[0]?.verified, JSON.stringify(result)); assert.deepEqual((await parent.get()).data(), before);
  const resolved = await require('../../src/services/evidenceAccess.service').plantingEvidenceForUser(parent.id, '0', { uid: f.id('user'), role: 'participant' });
  assert.equal(resolved.provider, 'firebase');
});
test('upload success followed by linkage interruption reuses the durable intent/object and charge', async () => {
  let first = true; const f = await fixture('photo', async stage => { if (stage === 'afterUpload' && first) { first = false; throw Error('SYNTHETIC_INTERRUPTION'); } });
  const failed = await f.service.execute({ executeEmulator: true }); assert.equal(failed.results[0].verified, false);
  const saved = (await ledger.doc(failed.results[0].id).get()).data(); assert.equal(saved.status, 'RECONCILIATION_REQUIRED');
  assert.equal((await f.ref.get()).data().photos[0].privateEvidence, undefined);
  const success = await f.service.execute({ executeEmulator: true }); assert.ok(success.results[0].verified, JSON.stringify(success));
  const final = (await ledger.doc(saved.plan.id).get()).data(); assert.equal(final.intentId, saved.intentId);
  assert.equal(final.reference.generation, saved.reference.generation);
});
test('linkage success followed by response interruption recovers without another upload', async () => {
  let first = true; const f = await fixture('photo', async stage => { if (stage === 'afterLink' && first) { first = false; throw Error('SYNTHETIC_RESPONSE_LOSS'); } });
  const failed = await f.service.execute({ executeEmulator: true }); const saved = (await ledger.doc(failed.results[0].id).get()).data();
  assert.equal(saved.status, 'LINKED');
  const next = await f.service.execute({ executeEmulator: true }); assert.ok(next.results[0].verified, JSON.stringify(next));
  assert.equal((await ledger.doc(saved.plan.id).get()).data().status, 'VERIFIED');
});
test('concurrent migration executions have one durable linkage and upload intent', async () => {
  const f = await fixture(), second = createHistoricalEvidenceMigration(f.options);
  const results = await Promise.all([f.service.execute({ executeEmulator: true }), second.execute({ executeEmulator: true })]);
  assert.ok(results.some(r => r.results.some(row => row.verified)), JSON.stringify(results));
  assert.equal((await ledger.where('namespace', '==', f.namespace).get()).size, 1);
  assert.equal((await f.service.verify()).results[0].verified, true);
});
test('stale reference after upload blocks linkage, preserves uploaded object and never overwrites new evidence', async () => {
  let f;
  f = await fixture('photo', async stage => { if (stage === 'afterUpload') await f.ref.update({ photos: [{ ...f.before.photos[0], photoPath: 'planting-reports/synthetic/new.png' }] }); });
  const result = await f.service.execute({ executeEmulator: true }); assert.equal(result.results[0].verified, false);
  assert.equal((await f.ref.get()).data().photos[0].photoPath, 'planting-reports/synthetic/new.png');
  assert.equal((await f.ref.get()).data().photos[0].privateEvidence, undefined);
});
test('missing, unsafe, invalid metadata and duplicate-content sources are not eligible', async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.root, 'planting-reports/synthetic/copy.png'), f.bytes);
  assert.equal((await f.service.execute()).eligibleOperations, 0);
  await f.ref.update({ photos: [{ ...f.before.photos[0], photoPath: '../outside.png' }] }); assert.equal((await f.service.execute()).eligibleOperations, 0);
  await f.ref.update({ photos: [{ ...f.before.photos[0], photoPath: 'planting-reports/synthetic/absent.png' }] }); assert.equal((await f.service.execute()).eligibleOperations, 0);
  await f.ref.update({ photos: [{ ...f.before.photos[0], imageHash: 'invalid' }] }); assert.equal((await f.service.execute()).eligibleOperations, 0);
});
test('verification detects a missing or corrupted cloud reference without repairing it', async () => {
  const data = (await shared.ref.get()).data(), original = data.photos[0].privateEvidence;
  await shared.ref.update({ photos: [{ ...data.photos[0], privateEvidence: { ...original, generation: '18446744073709551615' } }] });
  assert.equal((await shared.service.verify()).results[0].verified, false);
  // Restore only this test's deliberately altered synthetic reference for audit.
  await shared.ref.update({ photos: data.photos });
  const row = (await ledger.where('namespace', '==', shared.namespace).get()).docs[0].data();
  const fake = { ...row.reference, objectName: row.reference.objectName + '-missing' };
  await ledger.doc(row.plan.id).update({ reference: fake });
  assert.equal((await shared.service.verify()).results[0].verified, false);
});
test('shared emulator file/byte boundaries span independent workers and retain actor isolation', async () => {
  // An isolated synthetic calendar day; never reset today's shared migration ledger.
  const year = 3000 + randomBytes(2).readUInt16BE() % 3000;
  const date = new Date(`${year}-01-01T00:00:00Z`);
  const services = [createEvidenceUploadQuota({ db, clock: () => date }), createEvidenceUploadQuota({ db, clock: () => date })];
  const actor = services[0].serverActor({ migrationScope: 'historical-evidence-v1' });
  assert.equal(actor.key, services[1].serverActor({ migrationScope: 'historical-evidence-v1' }).key);
  let admitted = 0, denied = 0;
  await Promise.all(services.map(async q => {
    for (let i = 0; i < 26; i++) {
      try { await q.reserve(q.serverActor({ migrationScope: 'historical-evidence-v1' }), { intentId: randomUUID(), day: q.today(), fileCount: 1, byteCount: 1 }); admitted++; }
      catch (e) { assert.equal(e.code, 'EVIDENCE_DAILY_QUOTA_EXCEEDED'); denied++; }
    }
  }));
  assert.equal(admitted, 50); assert.equal(denied, 2);
  const bytesDay = new Date(`${year}-01-02T00:00:00Z`), q = createEvidenceUploadQuota({ db, clock: () => bytesDay }), a = q.serverActor({ migrationScope: 'historical-evidence-v1' });
  for (let i = 0; i < 20; i++) await q.reserve(a, { intentId: randomUUID(), day: q.today(), fileCount: 1, byteCount: 10485760 });
  await assert.rejects(q.reserve(a, { intentId: randomUUID(), day: q.today(), fileCount: 1, byteCount: 1 }), { code: 'EVIDENCE_DAILY_QUOTA_EXCEEDED' });
});
test('production project/bucket/credentials and non-synthetic root are rejected', () => {
  const original = process.env.FIREBASE_STORAGE_BUCKET;
  process.env.FIREBASE_STORAGE_BUCKET = 'menrosystem-ddfac.firebasestorage.app';
  assert.throws(() => createHistoricalEvidenceMigration(shared.options)); process.env.FIREBASE_STORAGE_BUCKET = original;
  assert.throws(() => createHistoricalEvidenceMigration({ ...shared.options, evidenceRoot: path.resolve('uploads') }));
  const project = process.env.GCLOUD_PROJECT;
  process.env.GCLOUD_PROJECT = 'menrosystem-ddfac'; assert.throws(() => createHistoricalEvidenceMigration(shared.options)); process.env.GCLOUD_PROJECT = project;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = 'not-read-synthetic-credential-path';
  assert.throws(() => createHistoricalEvidenceMigration(shared.options)); delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});
test('bounded reruns prioritize pending operations instead of repeatedly verifying the first completed batch', async () => {
  const f = await fixture(), bytes = await sharp(randomBytes(8 * 8 * 3), { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer();
  const relative = 'planting-reports/synthetic/second.png'; await fs.writeFile(path.join(f.root, relative), bytes);
  await db.collection('plantingReports').doc(f.id('second')).create({ ...f.before,
    photos: [{ photoPath: relative, imageHash: sha(bytes), imageDetails: { format: 'png', width: 8, height: 8 } }] });
  const first = await f.service.execute({ executeEmulator: true, maxOperations: 1 });
  const second = await f.service.execute({ executeEmulator: true, maxOperations: 1 });
  assert.ok(first.results[0].verified && second.results[0].verified, JSON.stringify([first, second]));
  assert.notEqual(first.results[0].id, second.results[0].id);
  assert.equal(second.remaining, 0);
  assert.equal((await f.service.verify()).results.filter(r => r.verified).length, 2);
});
test('standalone CLI defaults to dry-run and does not publish private source paths', async () => {
  const f = await fixture(), config = path.join(f.outputDirectory, 'config.json');
  await fs.writeFile(config, JSON.stringify({ namespace: f.namespace, evidenceRoot: f.root, outputDirectory: f.outputDirectory }));
  const { execFileSync } = require('node:child_process');
  const output = execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/migrateHistoricalEvidenceEmulator.js'), '--config', config], { encoding: 'utf8', timeout: 30000 });
  const result = JSON.parse(output); assert.equal(result.mode, 'dry-run'); assert.equal(result.writes, 0); assert.equal(result.eligibleOperations, 1);
  assert.ok(!output.includes(f.root)); assert.equal((await ledger.where('namespace', '==', f.namespace).get()).size, 0);
});
test('relationship mutation after upload blocks linkage without overwriting reassigned business context', async () => {
  let f;
  f = await fixture('photo', async stage => { if (stage === 'afterUpload') await f.ref.update({ eventId: f.id('new-event') }); });
  const result = await f.service.execute({ executeEmulator: true }); assert.equal(result.results[0].verified, false);
  assert.equal(result.results[0].code, 'MIGRATION_RELATION_CHANGED');
  assert.equal((await f.ref.get()).data().eventId, f.id('new-event'));
  assert.equal((await f.ref.get()).data().photos[0].privateEvidence, undefined);
});
test('changed source identity cannot create a second operation at an unresolved reserved evidence location', async () => {
  const f = await fixture('photo', async stage => { if (stage === 'afterUpload') throw Error('SYNTHETIC_INTERRUPTION'); });
  const first = await f.service.execute({ executeEmulator: true }); assert.equal(first.results[0].verified, false);
  const bytes = await sharp(randomBytes(8 * 8 * 3), { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer();
  const relative = 'planting-reports/synthetic/new-source.png'; await fs.writeFile(path.join(f.root, relative), bytes);
  await f.ref.update({ photos: [{ photoPath: relative, imageHash: sha(bytes), imageDetails: { format: 'png', width: 8, height: 8 } }] });
  await assert.rejects(f.service.execute({ executeEmulator: true }), /MIGRATION_SOURCE_CONFLICT/);
  assert.equal((await ledger.where('namespace', '==', f.namespace).get()).size, 1);
  assert.deepEqual(await fs.readFile(path.join(f.root, f.relative)), f.bytes);
});
