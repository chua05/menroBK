// Synthetic temporary files + loopback demo ONLY. No startup/route registration.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { constants } = require('node:fs');
const { Writable } = require('node:stream');
const { createHash } = require('node:crypto');
const { emulatorGuard, createEmulatorSource, createMemorySource } = require('./historicalEvidenceSource.service');
const { scanHistoricalEvidence } = require('./historicalEvidenceScanner.service');
const { COLLECTIONS, POLICY, opaque, localPath, inside, sha, canonical, signature } = require('../utils/historicalEvidenceClassification.util');
const { createMigrationLedger } = require('./historicalEvidenceMigrationLedger.service');
const base = node => { const copy = { ...node }; delete copy.privateEvidence; delete copy.revisionHistory; return copy; };
const bindings = data => Object.fromEntries(['participantId', 'contributorId', 'authenticatedSubmitterUid', 'participantType', 'userId',
  'siteId', 'plantingSiteId', 'eventId', 'plantingReportId', 'reportId', 'requestId', 'distributionId']
  .filter(k => data?.[k] !== undefined).map(k => [k, data[k]]));
function select(data, target) {
  if (target.kind === 'root') return Object.fromEntries(['photoPath', 'photoURL', 'imageHash', 'imageDetails', 'photoSize', 'privateEvidence']
    .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
  if (target.kind === 'photo') return data.photos?.[target.index];
  const observations = (data.history || []).filter(o => o.id === target.observationId);
  if (observations.length !== 1) throw Error('MIGRATION_OBSERVATION_CONFLICT');
  if (target.kind === 'observation') return observations[0];
  const revisions = (observations[0].revisionHistory || []).filter(r => r.revisionNumber === target.revisionNumber);
  if (revisions.length !== 1) throw Error('MIGRATION_REVISION_CONFLICT');
  return revisions[0].evidenceRef;
}
function link(data, target, reference) {
  if (target.kind === 'root') return { ...data, privateEvidence: reference };
  if (target.kind === 'photo') return { ...data, photos: data.photos.map((p, i) => i === target.index ? { ...p, privateEvidence: reference } : p) };
  return { ...data, history: data.history.map(o => o.id !== target.observationId ? o : target.kind === 'observation'
    ? { ...o, privateEvidence: reference } : { ...o, revisionHistory: o.revisionHistory.map(r => r.revisionNumber !== target.revisionNumber ? r : { ...r, evidenceRef: { ...r.evidenceRef, privateEvidence: reference } }) }) };
}
async function readSource(root, relative, expected) {
  const absolute = path.join(root, relative);
  if (!inside(root, absolute) || absolute === root) throw Error('MIGRATION_UNSAFE_PATH');
  for (let current = absolute;; current = path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) throw Error('MIGRATION_UNSAFE_PATH');
    if (current === root) break;
    if (!inside(root, current) || path.dirname(current) === current) throw Error('MIGRATION_UNSAFE_PATH');
  }
  if (!inside(root, await fs.realpath(absolute))) throw Error('MIGRATION_UNSAFE_PATH');
  const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expected.size || before.size > 10485760) throw Error('MIGRATION_SOURCE_CHANGED');
    const buffer = Buffer.alloc(before.size); let offset = 0;
    while (offset < buffer.length) { const r = await handle.read(buffer, offset, Math.min(65536, buffer.length - offset), null); if (!r.bytesRead) break; offset += r.bytesRead; }
    const after = await handle.stat(), current = await fs.lstat(absolute);
    if (offset !== buffer.length || before.ino !== current.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.size !== after.size || current.isSymbolicLink() || sha(buffer) !== expected.hash || signature(buffer) !== expected.format) throw Error('MIGRATION_SOURCE_CHANGED');
    return buffer;
  } finally { await handle.close(); }
}
function createHistoricalEvidenceMigration({ db, getBucket, namespace, evidenceRoot, outputDirectory, clock, fault = async () => {} }) {
  const guard = () => {
    emulatorGuard(process.env);
    if (process.env.MENRO_HISTORICAL_MIGRATION !== 'true' || db?.projectId !== 'demo-menro-phase2' ||
        process.env.FIREBASE_STORAGE_EMULATOR_HOST !== '127.0.0.1:9199' || process.env.FIREBASE_STORAGE_BUCKET !== 'demo-menro-phase2.firebasestorage.app' ||
        !/^scan6b-[a-f0-9]{8}-[a-f0-9-]{27}-$/.test(namespace || '') ||
        !path.isAbsolute(evidenceRoot || '') || !inside(os.tmpdir(), evidenceRoot) || evidenceRoot === os.tmpdir() ||
        !path.basename(evidenceRoot).startsWith('menro-migration-')) throw Error('MIGRATION_EMULATOR_REQUIRED');
  };
  guard();
  const ledger = createMigrationLedger({ db, guard });
  function validatePlan(plan) {
    const allowed = ['plantingReports', 'plantingContributions', 'monitoringRecords'];
    const key = `${plan.collection}/${plan.recordId}/${plan.context}/${opaque('file', plan.relative)}`;
    if (plan.namespace !== namespace || plan.policy !== POLICY || !allowed.includes(plan.collection) ||
        !plan.recordId?.startsWith(namespace) || !plan.cloudRecordId?.startsWith(namespace) ||
        !/^[a-f0-9]{64}$/.test(plan.expected?.hash || '') || !['jpeg', 'png', 'webp'].includes(plan.expected?.format) ||
        !Number.isSafeInteger(plan.expected.size) || plan.expected.size < 1 || plan.expected.size > 10485760 ||
        plan.id !== sha(canonical(['historical-migration-v1', key, plan.expected.hash])) ||
        !Array.isArray(plan.targets) || !plan.targets.length || plan.targets.length > 100 ||
        !Array.isArray(plan.relations) || plan.relations.length > 16 || plan.relations.some(r =>
          !COLLECTIONS.includes(r.collection) || !r.id?.startsWith(namespace)) ||
        (plan.collection !== 'monitoringRecords' && (plan.cloudRecordId !== plan.recordId ||
          plan.type !== (plan.collection === 'plantingReports' ? 'planting-report' : 'planting-contribution'))) ||
        (plan.collection === 'monitoringRecords' && (!['monitoring-early', 'monitoring-official'].includes(plan.type) ||
          plan.targets.some(t => t.observationId !== plan.cloudRecordId))) ||
        plan.targets.some(t => !['root', 'photo', 'observation', 'revision'].includes(t.kind) ||
          (t.observationId && !t.observationId.startsWith(namespace)))) throw Error('INVALID_MIGRATION_PLAN');
    localPath(plan.relative, evidenceRoot);
  }
  let storage, retrieval;
  const adapters = () => {
    storage ||= require('./firebaseEvidenceStorage.service').createFirebaseEvidenceStorage({ db, getBucket, clock, log() {} });
    retrieval ||= require('./firebaseEvidenceRetrieval.service').createFirebaseEvidenceRetrieval({ getBucket, log() {} });
  };
  async function prepare() {
    guard();
    const reader = createEmulatorSource({ namespace, complete: true }), collections = {}; let count = 0;
    try {
      for (const collection of COLLECTIONS) {
        collections[collection] = {}; let after = null;
        for (;;) {
          const rows = await reader.readPage(collection, after, 100);
          for (const row of rows) { if (++count > 1000) throw Error('MIGRATION_RECORD_BUDGET'); collections[collection][row.id] = row.data; }
          if (rows.length < 100) break; after = rows.at(-1).id;
        }
      }
    } finally { await reader.close(); }
    const { report } = await scanHistoricalEvidence({ source: createMemorySource({ synthetic: true, complete: true, collections }),
      evidenceRoot, outputDirectory, batchSize: 100, maxRecords: 1001, maxFiles: 1000, maxHashBytes: 200 * 1024 * 1024, writeReport: false });
    if (report.completeness.truncated) throw Error('MIGRATION_SCAN_INCOMPLETE');
    const edges = new Map(report.references.map(r => [r.id, r])), groups = new Map();
    function add(collection, id, data, node, pointer, target, context, type, recordId) {
      if (!node) return;
      const edge = edges.get(opaque('edge', `${collection}/${id}/${pointer}`));
      if (!edge) return;
      if (target.kind === 'root') node = select(data, target);
      const original = node.photoPath || node.photoURL || node.photoUrl;
      let resolved; try { resolved = localPath(original, evidenceRoot); } catch { return; }
      const key = `${collection}/${id}/${context}/${resolved.key}`;
      const group = groups.get(key) || { collection, recordId: id, context, relative: resolved.relative, type, cloudRecordId: recordId,
        expected: { hash: node.imageHash, size: null, format: node.imageDetails?.format }, targets: [], eligible: true,
        bindings: bindings(data), relations: [] };
      if (!group.relations.length) {
        const refs = [['siteId', 'sites'], ['eventId', 'events'], ['plantingReportId', 'plantingReports'], ['reportId', 'plantingReports'],
          ['distributionId', 'distributions'], ['requestId', 'seedlingRequests']];
        if (collection === 'plantingReports') refs.push(['participantId', 'users']);
        if (collection === 'plantingContributions') refs.push(data.authenticatedSubmitterUid ? ['authenticatedSubmitterUid', 'users'] : ['participantId', 'eventParticipants']);
        for (const [field, relatedCollection] of refs) if (data[field]) group.relations.push({ collection: relatedCollection, id: data[field], bindings: bindings(collections[relatedCollection][data[field]]) });
      }
      group.eligible &&= edge.classification === 'ELIGIBLE';
      group.targets.push({ ...target, originalDigest: sha(canonical(base(node))), original: base(node) }); groups.set(key, group);
    }
    for (const collection of ['plantingReports', 'plantingContributions', 'monitoringRecords']) for (const [id, data] of Object.entries(collections[collection])) {
      if (collection !== 'monitoringRecords') {
        if (data.reportType === 'parent') continue;
        const type = collection === 'plantingReports' ? 'planting-report' : 'planting-contribution';
        (data.photos || []).forEach((node, index) => add(collection, id, data, node, `photos/${index}`, { kind: 'photo', index }, 'photos', type, id));
        add(collection, id, data, data, 'root-alias', { kind: 'root' }, 'photos', type, id);
      } else (data.history || []).forEach((o, i) => {
        const type = `monitoring-${o.observationType}`;
        add(collection, id, data, o, `history/${i}`, { kind: 'observation', observationId: o.id }, `${o.id}/${o.currentEvidenceRevision}`, type, o.id);
        (o.revisionHistory || []).forEach((r, j) => add(collection, id, data, r.evidenceRef, `history/${i}/revisions/${j}`,
          { kind: 'revision', observationId: o.id, revisionNumber: r.revisionNumber }, `${o.id}/${r.evidenceRevision}`, type, o.id));
      });
    }
    const plans = [];
    for (const [key, group] of groups) if (group.eligible) {
      group.expected.size = (await fs.stat(path.join(evidenceRoot, group.relative))).size;
      plans.push({ ...group, id: sha(canonical(['historical-migration-v1', key, group.expected.hash])), namespace, policy: POLICY });
    }
    return { plans, report };
  }
  async function verifyRow(saved) {
    guard(); adapters();
    const plan = saved.plan;
    validatePlan(plan);
    await readSource(evidenceRoot, plan.relative, plan.expected);
    const data = (await db.collection(plan.collection).doc(plan.recordId).get()).data();
    if (!saved.reference || !data || !['LINKED', 'VERIFIED'].includes(saved.status)) throw Error('MIGRATION_LINKAGE_UNCONFIRMED');
    if (canonical(bindings(data)) !== canonical(plan.bindings)) throw Error('MIGRATION_RELATION_CHANGED');
    for (const r of plan.relations) {
      const doc = await db.collection(r.collection).doc(r.id).get();
      if (!doc.exists || canonical(bindings(doc.data())) !== canonical(r.bindings)) throw Error('MIGRATION_RELATION_CHANGED');
    }
    for (const target of plan.targets) {
      const node = select(data, target);
      if (!node || canonical(node.privateEvidence) !== canonical(saved.reference) || sha(canonical(base(node))) !== target.originalDigest) throw Error('MIGRATION_LINKAGE_CHANGED');
    }
    const hash = createHash('sha256'); let size = 0;
    const sink = new Writable({ write(chunk, encoding, done) { hash.update(chunk); size += chunk.length; done(); } });
    sink.setHeader = () => {}; sink.headersSent = false;
    await retrieval.streamTo(retrieval.serverResolvedEvidence({ reference: saved.reference, evidenceType: plan.type, recordId: plan.cloudRecordId }), sink);
    if (size !== plan.expected.size || hash.digest('hex') !== plan.expected.hash) throw Error('MIGRATION_OBJECT_CHANGED');
    return { id: plan.id, status: saved.status, verified: true, rollback: 'MANUAL_APPROVAL_REQUIRED', sourcePreserved: true };
  }
  async function markVerified(operation, reference) {
    guard();
    await db.runTransaction(async tx => {
      const row = (await tx.get(operation.ref)).data();
      if (!['LINKED', 'VERIFIED'].includes(row?.status) || canonical(row.reference) !== canonical(reference)) throw Error('MIGRATION_LINKAGE_CHANGED');
      const data = (await tx.get(db.collection(row.plan.collection).doc(row.plan.recordId))).data();
      if (canonical(bindings(data)) !== canonical(row.plan.bindings)) throw Error('MIGRATION_RELATION_CHANGED');
      for (const r of row.plan.relations) {
        const related = await tx.get(db.collection(r.collection).doc(r.id));
        if (!related.exists || canonical(bindings(related.data())) !== canonical(r.bindings)) throw Error('MIGRATION_RELATION_CHANGED');
      }
      for (const target of row.plan.targets) if (canonical(select(data, target)?.privateEvidence) !== canonical(reference)) throw Error('MIGRATION_LINKAGE_CHANGED');
      if (row.status !== 'VERIFIED') tx.update(operation.ref, { status: 'VERIFIED', updatedAt: ledger.now(), audit: [...row.audit, { action: 'VERIFIED', at: ledger.now() }] });
    });
  }
  async function execute({ executeEmulator = false, reconcileOnly = false, maxOperations = 10 } = {}) {
    guard(); if (!executeEmulator) { const p = await prepare(); return { mode: 'dry-run', eligibleOperations: p.plans.length, writes: 0 }; }
    if (!Number.isInteger(maxOperations) || maxOperations < 1 || maxOperations > 50) throw Error('MIGRATION_BUDGET');
    adapters();
    const prepared = reconcileOnly ? { plans: [] } : await prepare(), plans = new Map(prepared.plans.map(p => [p.id, p]));
    const prior = await ledger.records.where('namespace', '==', namespace).limit(51).get();
    if (prior.size > 50) throw Error('MIGRATION_BUDGET');
    const locations = p => p.targets.map(({ original, originalDigest, ...selector }) => {
      void original; void originalDigest; return canonical([p.collection, p.recordId, selector]);
    });
    // A changed checksum/path at an already reserved logical evidence location
    // is a conflict, not permission to create a fresh operation/object.
    for (const p of prepared.plans) for (const doc of prior.docs) if (p.id !== doc.id &&
      locations(p).some(location => locations(doc.data().plan).includes(location))) throw Error('MIGRATION_SOURCE_CONFLICT');
    for (const doc of prior.docs) plans.set(doc.id, doc.data().plan);
    if (plans.size > 50) throw Error('MIGRATION_NAMESPACE_BUDGET');
    const previous = new Map(prior.docs.map(d => [d.id, d.data()])), results = [];
    const completed = p => ['LINKED', 'VERIFIED'].includes(previous.get(p.id)?.status);
    const exhausted = [...plans.values()].filter(p => !completed(p) && previous.get(p.id)?.attempts >= 3);
    for (const p of exhausted) results.push({ id: p.id, status: 'RECONCILIATION_REQUIRED', code: 'MIGRATION_ATTEMPT_BUDGET', verified: false });
    const active = [...plans.values()].filter(p => !exhausted.includes(p)).sort((a, b) => Number(completed(a)) - Number(completed(b)) || a.id.localeCompare(b.id));
    for (const plan of active.slice(0, maxOperations)) {
      let operation;
      try {
        validatePlan(plan);
        const bytes = await readSource(evidenceRoot, plan.relative, plan.expected);
        operation = await ledger.reserve(plan);
        if (['LINKED', 'VERIFIED'].includes(operation.row.status)) {
          await verifyRow(operation.row); await markVerified(operation, operation.row.reference);
          results.push({ id: plan.id, status: 'VERIFIED', verified: true }); continue;
        }
        // Recheck current source target before reserving any cloud bytes/quota.
        const current = (await db.collection(plan.collection).doc(plan.recordId).get()).data();
        if (canonical(bindings(current)) !== canonical(plan.bindings)) throw Error('MIGRATION_RELATION_CHANGED');
        for (const target of plan.targets) if (!current || sha(canonical(base(select(current, target)))) !== target.originalDigest || select(current, target).privateEvidence) throw Error('MIGRATION_SOURCE_CHANGED');
        const context = storage.serverContext({ actor: { migrationScope: 'historical-evidence-v1' }, evidenceType: plan.type, recordId: plan.cloudRecordId });
        const image = { buffer: bytes, contentType: { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[plan.expected.format], sha256: plan.expected.hash };
        await storage.reserve(context, image, operation.row.intentId);
        await ledger.transition(operation, 'UPLOADING');
        const reference = await storage.upload(context, operation.row.intentId, image);
        await ledger.transition(operation, 'UPLOADED', { reference }); await fault('afterUpload', plan);
        await readSource(evidenceRoot, plan.relative, plan.expected);
        await db.runTransaction(async tx => {
          const saved = (await tx.get(operation.ref)).data(); ledger.fence(saved, operation);
          const intentRef = db.collection('evidenceUploadIntents').doc(saved.intentId), intent = (await tx.get(intentRef)).data();
          const businessRef = db.collection(plan.collection).doc(plan.recordId), document = await tx.get(businessRef);
          let updated = document.data();
          if (canonical(bindings(updated)) !== canonical(plan.bindings)) throw Error('MIGRATION_RELATION_CHANGED');
          for (const r of plan.relations) {
            const related = await tx.get(db.collection(r.collection).doc(r.id));
            if (!related.exists || canonical(bindings(related.data())) !== canonical(r.bindings)) throw Error('MIGRATION_RELATION_CHANGED');
          }
          if (!intent || intent.status !== 'UPLOADED' || canonical(intent.reference) !== canonical(reference) || !document.exists) throw Error('MIGRATION_LINKAGE_CONFLICT');
          for (const target of plan.targets) {
            const node = select(updated, target);
            if (!node || node.privateEvidence || sha(canonical(base(node))) !== target.originalDigest) throw Error('MIGRATION_SOURCE_CHANGED');
          }
          for (const target of plan.targets) updated = link(updated, target, reference);
          // Fresh transaction snapshot preserves unknown fields and concurrent actions.
          tx.set(businessRef, updated);
          tx.update(intentRef, { status: 'LINKED', linkedTo: { migrationId: plan.id }, linkedAt: new Date() });
          tx.update(operation.ref, { status: 'LINKED', reference, leaseUntil: 0, updatedAt: ledger.now(), audit: [...saved.audit, { action: 'LINKED', at: ledger.now() }] });
        }, { maxAttempts: 5 });
        await fault('afterLink', plan);
        const saved = (await operation.ref.get()).data(); await verifyRow(saved);
        await markVerified(operation, reference);
        results.push({ id: plan.id, status: 'VERIFIED', verified: true });
      } catch (error) {
        const code = /^[A-Z_]+$/.test(error.code || '') ? error.code : /^[A-Z_]+$/.test(error.message) ? error.message : 'MIGRATION_FAILED';
        if (operation) await ledger.fail(operation, code === 'EVIDENCE_DAILY_QUOTA_EXCEEDED');
        results.push({ id: plan.id, status: 'RECONCILIATION_REQUIRED', code, verified: false });
      }
    }
    return { mode: reconcileOnly ? 'reconcile-emulator' : 'execute-emulator', results, remaining: active.slice(maxOperations).filter(p => !completed(p)).length,
      paused: results.some(r => r.code === 'EVIDENCE_DAILY_QUOTA_EXCEEDED') };
  }
  async function verify() {
    guard(); const docs = await ledger.records.where('namespace', '==', namespace).limit(51).get();
    if (docs.size > 50) throw Error('MIGRATION_BUDGET');
    const results = [];
    for (const doc of docs.docs) { try { results.push(await verifyRow(doc.data())); } catch { results.push({ id: doc.id, verified: false, status: 'RECONCILIATION_REQUIRED' }); } }
    return { mode: 'verify-emulator', results, writes: 0 };
  }
  return { prepare, execute, verify, rollbackAssessment: verify };
}
module.exports = { createHistoricalEvidenceMigration, select, link, readSource };
