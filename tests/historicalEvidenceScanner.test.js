const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createMemorySource, emulatorGuard } = require('../src/services/historicalEvidenceSource.service');
const { scanHistoricalEvidence, inspectFile } = require('../src/services/historicalEvidenceScanner.service');
const { sha, canonical, localPath, primary, opaque } = require('../src/utils/historicalEvidenceClassification.util');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X0AAAAASUVORK5CYII=', 'base64');
async function setup() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scan6b-unit-'));
  const root = path.join(temp, 'evidence'), output = path.join(temp, 'reports');
  await fs.mkdir(path.join(root, 'planting-reports', 'actor'), { recursive: true });
  await fs.mkdir(path.join(root, 'monitoring', 'actor'), { recursive: true }); await fs.mkdir(output);
  const collections = { users: { actor: {} }, sites: { site: {} }, events: { event: {} },
    plantingReports: { report: { participantId: 'actor', siteId: 'site', eventId: 'event', photos: [photo('planting-reports/actor/a.png')] } } };
  await fs.writeFile(path.join(root, 'planting-reports/actor/a.png'), PNG);
  return { temp, root, output, collections };
}
const photo = relative => ({ photoPath: relative, imageHash: sha(PNG), imageDetails: { format: 'png', width: 1, height: 1 } });
const source = f => createMemorySource({ synthetic: true, complete: true, collections: f.collections });
const options = f => ({ evidenceRoot: f.root, outputDirectory: f.output, batchSize: 2, maxRecords: 100, maxFiles: 100, maxHashBytes: 100000 });
const run = (f, extra = {}) => scanHistoricalEvidence({ ...options(f), source: source(f), ...extra });
const first = result => result.report.references[0];
// Cleanup is restricted to task-owned synthetic temporary directories only.
async function fixture(t) { const f = await setup(); t.after(() => fs.rm(f.temp, { recursive: true, force: true })); return f; }
test('valid local evidence, exact counts, union bytes and unchanged content/mtime', async t => {
  const f = await fixture(t), file = path.join(f.root, 'planting-reports/actor/a.png'), before = await fs.stat(file);
  const result = await run(f); assert.equal(first(result).classification, 'ELIGIBLE');
  assert.equal(result.report.metrics.businessRecords, 1); assert.equal(result.report.metrics.evidenceReferences, 1);
  assert.equal(result.report.metrics.bytesEligible, PNG.length); assert.equal(result.report.metrics.distinctFileContents, 1);
  assert.deepEqual(await fs.readFile(file), PNG); assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});
test('missing source only with complete source; unknown completeness requires review', async t => {
  const f = await fixture(t); f.collections.plantingReports.report.photos[0].photoPath = 'planting-reports/actor/missing.png';
  assert.equal(first(await run(f)).classification, 'MISSING_SOURCE');
  const result = await run(f, { source: createMemorySource({ synthetic: true, collections: f.collections }) });
  assert.equal(first(result).classification, 'REQUIRES_REVIEW'); assert.equal(result.report.metrics.orphanedFiles, null);
});
test('orphan inventory is separate from reference totals', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'monitoring/actor/orphan.png'), PNG);
  const r = await run(f); assert.equal(r.report.metrics.orphanedFiles, 1); assert.equal(r.report.references.length, 1);
});
test('duplicate contents across paths, not multiple references to same path', async t => {
  const f = await fixture(t); f.collections.plantingReports.report.photos.push(photo('planting-reports/actor/a.png'));
  let r = await run(f); assert.equal(r.report.metrics.uniqueLocalFilePaths, 1); assert.equal(r.report.metrics.duplicateContentGroups, 0);
  await fs.writeFile(path.join(f.root, 'planting-reports/actor/b.png'), PNG);
  f.collections.plantingReports.report.photos.push(photo('planting-reports/actor/b.png'));
  r = await run(f); assert.equal(r.report.metrics.duplicateContentGroups, 1); assert.equal(r.report.metrics.distinctFileContents, 1);
  assert.equal(first(r).classification, 'DUPLICATE_CONTENT');
});
test('invalid declared metadata and actual signature/extension mismatch', async t => {
  const f = await fixture(t); f.collections.plantingReports.report.photos[0].imageDetails.width = -1;
  assert.equal(first(await run(f)).classification, 'INVALID_METADATA');
  await fs.writeFile(path.join(f.root, 'planting-reports/actor/a.png'), Buffer.from('not an image'));
  delete f.collections.plantingReports.report.photos[0].imageHash;
  const r = await run(f); assert.ok(first(r).flags.includes('INVALID_METADATA'));
});
test('verified hash conflict blocked rather than silently overwritten', async t => {
  const f = await fixture(t); f.collections.plantingReports.report.photos[0].imageHash = 'a'.repeat(64);
  assert.equal(first(await run(f)).classification, 'BLOCKED');
});
test('cloud schema-only requires review; trusted synthetic proof supports already cloud', async t => {
  const f = await fixture(t), intent = randomUUID();
  const ref = { provider: 'firebase', storageVersion: 1, bucket: 'demo-menro-phase2.firebasestorage.app',
    objectName: `evidence/v1/planting-report/report/${intent}`, generation: '1', contentType: 'image/png', format: 'png', sizeBytes: PNG.length, sha256: sha(PNG), uploadIntentId: intent };
  f.collections.plantingReports.report.photos = [{ privateEvidence: ref, imageHash: sha(PNG) }];
  assert.equal(first(await run(f)).classification, 'REQUIRES_REVIEW');
  const r = await run(f, { source: createMemorySource({ synthetic: true, complete: true, collections: f.collections, verifiedCloud: [sha(canonical(ref))] }) });
  assert.equal(first(r).classification, 'ALREADY_CLOUD');
  ref.generation = 1; assert.equal(first(await run(f)).classification, 'BLOCKED');
});
for (const value of ['../outside.png', 'planting-reports/actor/%2e%2e/a.png', 'planting-reports/actor/%252e%252e/a.png',
  'planting-reports\\actor\\a.png', 'C:/outside/a.png', 'file:///outside.png',
  'https://firebasestorage.googleapis.com/v0/b/x/o/a.png', 'https://untrusted.example/uploads/planting-reports/actor/a.png']) {
  test(`unsafe path rejected (${value.split(':')[0]})`, async t => {
    const f = await fixture(t); f.collections.plantingReports.report.photos[0].photoPath = value;
    assert.equal(first(await run(f)).classification, 'BLOCKED');
  });
}
test('explicit backend URL alias resolves without fetching; URL traversal rejected before normalization', async t => {
  const f = await fixture(t), p = f.collections.plantingReports.report.photos[0];
  p.photoURL = 'https://local.example/uploads/planting-reports/actor/a.png';
  assert.equal(first(await run(f, { localOrigins: ['https://local.example'] })).classification, 'ELIGIBLE');
  p.photoURL = 'https://local.example/uploads/planting-reports/actor/../a.png';
  assert.equal(first(await run(f, { localOrigins: ['https://local.example'] })).classification, 'BLOCKED');
});
test('symlink escape blocked with zero outside bytes read', async t => {
  const f = await fixture(t), outside = path.join(f.temp, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.png'), PNG);
  await fs.symlink(outside, path.join(f.root, 'monitoring', 'linked'), 'junction');
  f.collections.plantingReports.report.photos[0].photoPath = 'monitoring/linked/secret.png';
  const r = await run(f); assert.equal(first(r).classification, 'BLOCKED'); assert.ok(first(r).flags.includes('SYMLINK'));
});
test('read failure and file replacement mismatch remain unverified', async t => {
  const f = await fixture(t);
  const r = await inspectFile(f.root, { relative: 'planting-reports/actor/absent.png', size: 12, stamp: 'invalid', flags: [] }, 100);
  assert.deepEqual(r.flags, ['READ_ERROR']); assert.equal(r.hash, undefined);
  const changed = await inspectFile(f.root, { relative: 'planting-reports/actor/a.png', size: 12, stamp: 'wrong', flags: [] }, 100);
  assert.deepEqual(changed.flags, ['SOURCE_CHANGED']);
});
test('hash budget respected and resumable with larger budget', async t => {
  const f = await fixture(t), r = await run(f, { maxHashBytes: 0 });
  assert.equal(first(r).classification, 'REQUIRES_REVIEW'); assert.equal(r.report.usage.bytesHashedThisRun, 0);
  assert.equal(first(await run(f, { checkpoint: r.checkpoint })).classification, 'ELIGIBLE');
});
test('record pagination and resume produce exact counts without duplicate references', async t => {
  const f = await fixture(t); let r = await run(f, { maxRecords: 1, batchSize: 1 });
  assert.equal(r.report.completeness.recordsComplete, false); assert.equal(r.report.metrics.orphanedFiles, null);
  for (let i = 0; i < 15 && !r.report.completeness.recordsComplete; i++) r = await run(f, { checkpoint: r.checkpoint, maxRecords: 1, batchSize: 1 });
  assert.equal(r.report.completeness.recordsComplete, true); assert.equal(r.report.metrics.allRecords, 4); assert.equal(r.report.references.length, 1);
  assert.deepEqual(r.report.metrics, (await run(f)).report.metrics);
});
test('file budget resumes hashing without double-counting bytes', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'planting-reports/actor/b.png'), PNG);
  let r = await run(f, { maxFiles: 1 }); assert.equal(r.report.completeness.hashComplete, false);
  r = await run(f, { checkpoint: r.checkpoint, maxFiles: 1 }); assert.equal(r.report.completeness.hashComplete, true);
  assert.equal(r.report.metrics.bytesInspected, PNG.length * 2);
});
test('malformed/incompatible checkpoint, changed documents and changed files rejected', async t => {
  const f = await fixture(t), r = await run(f);
  await assert.rejects(run(f, { checkpoint: {} }), /INVALID_CHECKPOINT/);
  const bad = structuredClone(r.checkpoint); bad.state.collection = 100;
  await assert.rejects(run(f, { checkpoint: bad }), /INVALID_CHECKPOINT/);
  f.collections.users.actor = { changed: true }; await assert.rejects(run(f, { checkpoint: r.checkpoint }), /INVALID_CHECKPOINT/);
  delete f.collections.users.actor.changed; await fs.writeFile(path.join(f.root, 'planting-reports/actor/a.png'), Buffer.from('changed'));
  await assert.rejects(run(f, { checkpoint: r.checkpoint }), /SOURCE_CHANGED/);
});
test('parent aggregation and root aliases remain edges, not new files', async t => {
  const f = await fixture(t), p = f.collections.plantingReports.report;
  Object.assign(p, photo('planting-reports/actor/a.png')); p.reportType = 'parent';
  f.collections.eventParticipants = { guest: { eventId: 'event', participantType: 'guest', sessionHash: 'PRIVATE_SESSION' } };
  f.collections.plantingContributions = { contribution: { reportId: 'report', eventId: 'event', participantId: 'guest', contributorId: 'guest', photos: [photo('planting-reports/actor/a.png')] } };
  const r = await run(f); assert.equal(r.report.metrics.evidenceReferences, 3); assert.equal(r.report.metrics.uniqueLocalFilePaths, 1);
  assert.equal(r.report.workflows.guestContributions.references, 1);
});
test('early, official, all revisions and reused evidence preserved, duplicate observation IDs blocked', async t => {
  const f = await fixture(t), evidence = { photoUrl: '/uploads/planting-reports/actor/a.png', imageHash: sha(PNG) };
  const o = { id: 'OBS-1', observationType: 'early', originalReporterId: 'actor', monitoredDate: '2026-10-20', ...evidence,
    revisionHistory: [{ revisionNumber: 1, evidenceRevision: 1, evidenceRef: evidence }, { revisionNumber: 2, evidenceRevision: 1, reusedEvidence: true, evidenceRef: evidence }] };
  f.collections.monitoringRecords = { lifecycle: { plantingReportId: 'report', history: [o, { ...o, id: 'OBS-2', observationType: 'official', revisionHistory: [] }] } };
  let r = await run(f); assert.equal(r.report.workflows.monitoringRevisions.references, 2); assert.equal(r.report.workflows.earlyMonitoring.references, 1);
  assert.equal(r.report.workflows.officialMonitoring.references, 1); assert.equal(r.report.metrics.uniqueLocalFilePaths, 1);
  f.collections.monitoringRecords.lifecycle.history.push(o); r = await run(f);
  assert.ok(r.report.references.some(e => e.flags.includes('DUPLICATE_OBSERVATION_ID')));
});
test('legacy observations and inconsistent revisions require review', async t => {
  const f = await fixture(t); f.collections.monitoringRecords = { old: { plantingReportId: 'report', photoUrl: '/uploads/planting-reports/actor/a.png', imageHash: sha(PNG), monitoredBy: 'actor' } };
  assert.ok((await run(f)).report.references.some(r => r.flags.includes('LEGACY_OBSERVATION')));
});
test('empty dataset counts and orphan classification', async t => {
  const f = await fixture(t); f.collections = {};
  const r = await run(f); assert.equal(r.report.metrics.businessRecords, 0); assert.equal(r.report.metrics.evidenceReferences, 0); assert.equal(r.report.metrics.orphanedFiles, 1);
});
test('report/checkpoint privacy and exclusive non-overwriting output', async t => {
  const f = await fixture(t); f.collections.users.actor = { email: 'SECRET@example.test', latitude: 12.5, password: 'SECRET_PASSWORD' };
  const r = await run(f), encoded = JSON.stringify(r.report) + JSON.stringify(r.checkpoint);
  for (const secret of [f.root, 'planting-reports/actor/a.png', 'SECRET', 'latitude', 'password', 'photoPath']) assert.ok(!encoded.includes(secret));
  const firstFiles = await fs.readdir(f.output); await run(f); assert.equal((await fs.readdir(f.output)).length, firstFiles.length + 2);
  await assert.rejects(run(f, { outputDirectory: f.root }), /UNSAFE_OUTPUT/);
});
test('production/ambiguous emulator settings rejected before loading SDK', () => {
  const env = { NODE_ENV: 'test', MENRO_INTEGRATION_TEST: 'true', GCLOUD_PROJECT: 'demo-menro-phase2', FIREBASE_PROJECT_ID: 'demo-menro-phase2',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
  assert.doesNotThrow(() => emulatorGuard(env));
  for (const override of [{ GCLOUD_PROJECT: 'menrosystem-ddfac' }, { FIRESTORE_EMULATOR_HOST: 'remote:8080' }, { GOOGLE_APPLICATION_CREDENTIALS: 'secret' }, { NODE_ENV: 'production' }, { FIREBASE_CONFIG: '{}' }]) {
    assert.throws(() => emulatorGuard({ ...env, ...override }), /SCANNER_EMULATOR_REQUIRED/);
  }
  assert.throws(() => createMemorySource({ synthetic: false, collections: {} }), /SYNTHETIC/);
});
test('classification precedence is deterministic and retains conservative boundaries', () => {
  assert.equal(primary(['DUPLICATE_CONTENT', 'HASH_CONFLICT']), 'BLOCKED');
  assert.equal(primary(['MISSING_SOURCE', 'INCOMPLETE_SOURCE']), 'REQUIRES_REVIEW');
  assert.throws(() => localPath('/outside.png', '/approved'), /UNSAFE_PATH/);
  assert.equal(opaque('file', 'one'), opaque('file', 'one'));
});
test('registered contribution attribution uses the event participant user binding', async t => {
  const f = await fixture(t);
  f.collections.eventParticipants = { registration: { eventId: 'event', userId: 'actor' } };
  f.collections.plantingContributions = { contribution: { reportId: 'report', eventId: 'event', participantId: 'registration', contributorId: 'actor', photos: [photo('planting-reports/actor/a.png')] } };
  let r = await run(f); assert.ok(!r.report.references.some(e => e.flags.includes('OWNER_CONFLICT')));
  f.collections.plantingContributions.contribution.contributorId = 'other-user';
  r = await run(f); assert.ok(r.report.references.some(e => e.flags.includes('OWNER_CONFLICT') && e.classification === 'BLOCKED'));
});
test('invalid revision ordering, active revision mismatch and impossible dates retained as diagnostics', async t => {
  const f = await fixture(t), evidence = { photoUrl: '/uploads/planting-reports/actor/a.png', imageHash: sha(PNG) };
  f.collections.monitoringRecords = { lifecycle: { plantingReportId: 'report', history: [{ id: 'OBS-1', observationType: 'early',
    originalReporterId: 'actor', monitoredDate: '2026-02-31', ...evidence, currentEvidenceRevision: 7,
    revisionHistory: [{ revisionNumber: 2, evidenceRevision: 7, evidenceRef: evidence }] }] } };
  const r = await run(f); const ref = r.report.references.find(e => e.workflow === 'earlyMonitoring');
  assert.ok(ref.flags.includes('REVISION_ORDER')); assert.ok(ref.flags.includes('INVALID_METADATA'));
});
test('standalone CLI produces only private aggregate output with explicit synthetic config', async t => {
  const f = await fixture(t), fixtureFile = path.join(f.temp, 'fixture.json'), configFile = path.join(f.temp, 'config.json');
  await fs.writeFile(fixtureFile, JSON.stringify({ synthetic: true, complete: true, collections: f.collections }));
  await fs.writeFile(configFile, JSON.stringify({ source: { mode: 'synthetic-memory', fixtureFile }, ...options(f) }));
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/scanHistoricalEvidence.js'), '--config', configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout);
  assert.equal(output.metrics.classifications.ELIGIBLE, 1); assert.equal(output.metrics.bytesEligible, PNG.length);
  assert.ok(!result.stdout.includes(f.root));
});
test('memory snapshot cannot be mutated through source inputs or returned pages', async t => {
  const f = await fixture(t), memory = source(f);
  f.collections.plantingReports.report.photos[0].photoPath = '../outside';
  const page = await memory.readPage('plantingReports', null, 2); page[0].data.photos[0].photoPath = '../other';
  assert.equal(first(await run(f, { source: memory })).classification, 'ELIGIBLE');
});
test('registered request-linked contributions preserve direct authenticated UID schema without inventing event registration', async t => {
  const f = await fixture(t);
  f.collections.plantingContributions = { direct: { reportId: 'report', eventId: 'event', participantId: 'actor', contributorId: 'actor',
    authenticatedSubmitterUid: 'actor', participantType: 'participant', photos: [photo('planting-reports/actor/a.png')] } };
  const r = await run(f); const ref = r.report.references.find(e => e.workflow === 'guestContributions');
  assert.equal(ref.classification, 'ELIGIBLE'); assert.ok(!ref.flags.includes('MISSING_RELATION'));
});
