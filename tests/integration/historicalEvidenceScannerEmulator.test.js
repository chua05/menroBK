// UUID-scoped emulator fixtures only. Scanner is read-only; fixture setup is not.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createEmulatorSource, emulatorGuard } = require('../../src/services/historicalEvidenceSource.service');
const { scanHistoricalEvidence } = require('../../src/services/historicalEvidenceScanner.service');
const { COLLECTIONS, canonical, sha } = require('../../src/utils/historicalEvidenceClassification.util');
emulatorGuard(process.env); // Fail, do not skip, if not explicitly isolated.
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore({ projectId: 'demo-menro-phase2', host: '127.0.0.1:8080', ssl: false,
  credentials: { client_email: 'fixture@example.invalid', private_key: 'unused-emulator-only' } });
const prefix = `scan6b-${randomUUID()}-`, id = suffix => `${prefix}${suffix}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X0AAAAASUVORK5CYII=', 'base64');
let temp, root, output, source, before, saved;
const photo = { photoPath: 'planting-reports/synthetic/one.png', imageHash: sha(PNG), imageDetails: { format: 'png', width: 1, height: 1 } };
async function snapshot() {
  const result = {};
  for (const c of COLLECTIONS) {
    const docs = []; let after = null;
    for (;;) { const page = await source.readPage(c, after, 2); docs.push(...page); if (page.length < 2) break; after = page.at(-1).id; }
    result[c] = docs;
  }
  return sha(canonical(result));
}
const run = extra => scanHistoricalEvidence({ source, evidenceRoot: root, outputDirectory: output,
  batchSize: 1, maxRecords: 100, maxFiles: 100, maxHashBytes: 100000, ...extra });
test.before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scan6b-emulator-')); root = path.join(temp, 'evidence'); output = path.join(temp, 'reports');
  await fs.mkdir(path.join(root, 'planting-reports', 'synthetic'), { recursive: true }); await fs.mkdir(output);
  await fs.writeFile(path.join(root, 'planting-reports/synthetic/one.png'), PNG);
  const evidence = { photoUrl: '/uploads/planting-reports/synthetic/one.png', imageHash: sha(PNG) };
  const observation = type => ({ id: id(`OBS-${type}`), observationType: type, originalReporterId: id('user'), monitoredDate: '2026-10-20',
    ...evidence, currentEvidenceRevision: 1, revisionHistory: [{ revisionNumber: 1, evidenceRevision: 1, evidenceRef: evidence },
      { revisionNumber: 2, evidenceRevision: 1, reusedEvidence: true, evidenceRef: evidence }] });
  const fixtures = [
    ['users', 'user', { role: 'participant', email: 'private-synthetic@example.test' }],
    ['events', 'event', {}], ['sites', 'site', {}],
    ['eventParticipants', 'guest', { eventId: id('event'), participantType: 'guest', sessionHash: 'private-session' }],
    ['plantingReports', 'parent', { reportType: 'parent', participantId: id('user'), eventId: id('event'), siteId: id('site') }],
    ['plantingReports', 'standalone', { participantId: id('user'), eventId: id('event'), siteId: id('site'), photos: [photo] }],
    ['plantingContributions', 'contribution', { reportId: id('parent'), eventId: id('event'), participantId: id('guest'), contributorId: id('guest'), photos: [photo] }],
    ['monitoringRecords', 'lifecycle', { plantingReportId: id('standalone'), siteId: id('site'), history: [observation('early'), observation('official')] }],
    ['monitoringRecords', 'missing-parent', { plantingReportId: id('absent'), history: [{ ...observation('official'), id: id('OBS-missing') }] }],
  ];
  for (const [c, name, value] of fixtures) await db.collection(c).doc(id(name)).create(value);
  source = createEmulatorSource({ namespace: prefix, complete: true }); before = await snapshot();
});
test.after(async () => {
  if (source) await source.close(); await db.terminate();
  if (temp) await fs.rm(temp, { recursive: true, force: true });
  // Retain this run's demo documents for audit; no deletes or collection resets.
});
test('reads only namespaced demo records, paginates across collections', async () => {
  saved = await run(); assert.equal(saved.report.metrics.allRecords, 9);
  assert.equal(saved.report.metrics.businessRecords, 5); assert.equal(saved.report.completeness.recordsComplete, true);
  assert.equal(saved.report.projectId, 'demo-menro-phase2');
});
test('planting, guest, early, official and every revision reference discovered', () => {
  assert.equal(saved.report.workflows.plantingReports.references, 1);
  assert.equal(saved.report.workflows.guestContributions.references, 1);
  assert.equal(saved.report.workflows.earlyMonitoring.references, 1);
  assert.equal(saved.report.workflows.officialMonitoring.references, 2);
  assert.equal(saved.report.workflows.monitoringRevisions.references, 6);
  assert.equal(saved.report.metrics.uniqueLocalFilePaths, 1); assert.equal(saved.report.metrics.distinctFileContents, 1);
});
test('missing relationships flagged and live source is not called an immutable snapshot', () => {
  assert.ok(saved.report.references.some(r => r.flags.includes('MISSING_RELATION')));
  assert.equal(saved.report.completeness.snapshot, 'live-non-point-in-time');
  assert.equal(saved.report.metrics.classifications.ELIGIBLE, 0);
});
test('checkpoint recovery preserves counts and verifies source prefixes', async () => {
  let r = await run({ maxRecords: 2 });
  for (let i = 0; i < 10 && !r.report.completeness.recordsComplete; i++) r = await run({ checkpoint: r.checkpoint, maxRecords: 2 });
  assert.equal(r.report.completeness.recordsComplete, true); assert.deepEqual(r.report.metrics, saved.report.metrics);
});
test('scanner causes no business writes, Storage imports or private data exposure', async () => {
  assert.equal(await snapshot(), before);
  assert.deepEqual(await fs.readFile(path.join(root, 'planting-reports/synthetic/one.png')), PNG);
  const loaded = Object.keys(require.cache);
  assert.ok(!loaded.some(p => /firebaseEvidence|evidenceWorkflow|config[\\/]firebase\.js|@google-cloud[\\/]storage/.test(p)));
  const encoded = JSON.stringify(saved);
  assert.ok(!encoded.includes('private-synthetic')); assert.ok(!encoded.includes('private-session')); assert.ok(!encoded.includes(root));
});
test('production project and non-loopback source rejected before SDK initialization', () => {
  assert.throws(() => createEmulatorSource({ namespace: prefix, env: { ...process.env, GCLOUD_PROJECT: 'menrosystem-ddfac' } }), /SCANNER_EMULATOR_REQUIRED/);
  assert.throws(() => createEmulatorSource({ namespace: prefix, env: { ...process.env, FIRESTORE_EMULATOR_HOST: 'example.test:8080' } }), /SCANNER_EMULATOR_REQUIRED/);
});
test('changed previously-read source makes checkpoint stale rather than hiding drift', async () => {
  const r = await run({ maxRecords: 1 });
  // Fixture mutator is separate from scanner. Only this run's UUID document.
  await db.collection('plantingReports').doc(id('parent')).update({ syntheticChanged: true });
  await assert.rejects(run({ checkpoint: r.checkpoint }), /SOURCE_CHANGED/);
});
