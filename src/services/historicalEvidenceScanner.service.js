// Explicit offline/emulator dry run only. Never imported by application startup.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { POLICY, COLLECTIONS, CLASSES, canonical, sha, opaque, inside, signature, primary, normalizeDocument } = require('../utils/historicalEvidenceClassification.util');
const HARD_RECORDS = 10000, HARD_FILES = 10000, HARD_EDGES = 50000, HARD_ENTRIES = 20000;
function integer(value, max, zero = false) { if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > max) throw Error('INVALID_SCAN_LIMIT'); return value; }
async function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw Error('SYMLINK');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
// Windows lstat reports dev=0 while fstat reports the volume serial. Inode/file-ID
// and both modification clocks remain comparable across the two calls.
const stamp = stat => [process.platform === 'win32' ? 0 : stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
async function inventory(root) {
  const files = [], stack = ['planting-reports', 'monitoring']; let entries = 0, complete = true;
  while (stack.length) {
    const rel = stack.pop(), absolute = path.join(root, rel);
    let stat;
    try { stat = await fs.lstat(absolute); } catch (e) { if (e.code !== 'ENOENT') complete = false; continue; }
    if (++entries > HARD_ENTRIES || files.length >= HARD_FILES) { complete = false; break; }
    const key = opaque('file', rel.split(path.sep).join('/'));
    if (stat.isSymbolicLink()) { files.push({ key, relative: rel, flags: ['SYMLINK'], stamp: stamp(stat), size: 0 }); continue; }
    if (stat.isDirectory()) {
      // opendir prevents one huge directory from allocating an unbounded listing.
      try {
        await noLinks(absolute);
        if (!inside(root, await fs.realpath(absolute))) { complete = false; continue; }
        const dir = await fs.opendir(absolute);
        for await (const entry of dir) {
          if (++entries > HARD_ENTRIES) { complete = false; break; }
          stack.push(path.join(rel, entry.name));
        }
      } catch { complete = false; }
    } else if (stat.isFile()) files.push({ key, relative: rel, flags: [], stamp: stamp(stat), size: stat.size });
    else files.push({ key, relative: rel, flags: ['UNSAFE_PATH'], stamp: stamp(stat), size: 0 });
  }
  files.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  return { files, complete, entries, digest: sha(canonical(files.map(f => [f.key, f.stamp, f.flags]))) };
}
async function inspectFile(root, file, byteBudget) {
  if (file.flags.length) return { flags: file.flags, stamp: file.stamp, size: file.size, bytesRead: 0 };
  if (file.size > byteBudget) return { flags: ['NOT_HASHED'], stamp: file.stamp, size: file.size, bytesRead: 0 };
  let handle, bytesRead = 0;
  try {
    const absolute = path.join(root, file.relative);
    await noLinks(absolute);
    if (!inside(root, await fs.realpath(absolute))) return { flags: ['SYMLINK'], bytesRead };
    handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile() || stamp(before) !== file.stamp) return { flags: ['SOURCE_CHANGED'], bytesRead };
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let header = Buffer.alloc(0);
    // Read exactly the preflight size: a growing source cannot exceed the budget.
    while (bytesRead < before.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - bytesRead), null);
      if (!result.bytesRead) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      if (!header.length) header = Buffer.from(chunk.subarray(0, 12));
      hash.update(chunk); bytesRead += result.bytesRead;
    }
    const after = await handle.stat(), current = await fs.lstat(absolute);
    await noLinks(absolute);
    if (stamp(after) !== file.stamp || stamp(current) !== file.stamp || bytesRead !== before.size ||
        !inside(root, await fs.realpath(absolute))) return { flags: ['SOURCE_CHANGED'], bytesRead };
    const format = signature(header), extension = path.extname(file.relative).toLowerCase();
    const matches = { jpeg: ['.jpg', '.jpeg'], png: ['.png'], webp: ['.webp'] };
    return { hash: hash.digest('hex'), format, size: before.size, stamp: file.stamp, bytesRead,
      flags: format && matches[format].includes(extension) ? [] : ['INVALID_METADATA'] };
  } catch (e) { return { flags: [e.message === 'SYMLINK' || e.code === 'ELOOP' ? 'SYMLINK' : 'READ_ERROR'], bytesRead, stamp: file.stamp, size: file.size }; }
  finally { if (handle) await handle.close(); }
}
function checkpointState(input, fingerprint) {
  if (!input) return { fingerprint, collection: 0, cursors: {}, docs: [], hashes: {}, inventoryDigest: null };
  if (Buffer.byteLength(JSON.stringify(input)) > 32 * 1024 * 1024 || input.policy !== POLICY || !input.state ||
      input.checksum !== sha(canonical(input.state)) || input.state.fingerprint !== fingerprint) throw Error('INVALID_CHECKPOINT');
  const s = input.state;
  if (!Number.isInteger(s.collection) || s.collection < 0 || s.collection > COLLECTIONS.length || !Array.isArray(s.docs) || s.docs.length > HARD_RECORDS ||
      !s.cursors || !s.hashes || Object.keys(s.hashes).length > HARD_FILES || s.docs.reduce((n, d) => n + (d.record?.refs?.length || 0), 0) > HARD_EDGES ||
      s.docs.some(d => !COLLECTIONS.includes(d.collection) || typeof d.id !== 'string' || !d.record || !Array.isArray(d.record.refs) ||
        !Array.isArray(d.record.links) || !Array.isArray(d.record.observations) || !/^[a-f0-9]{64}$/.test(d.record.rawDigest))) throw Error('INVALID_CHECKPOINT');
  return structuredClone(s);
}
async function publish(output, name, value) {
  // Publish a fully synced artifact by exclusive hard-link creation. Both names
  // are scanner-owned output artifacts, never source files. No overwrite/rename.
  const file = path.join(output, name), pending = path.join(output, `scan-${randomUUID()}.pending`);
  const handle = await fs.open(pending, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fs.link(pending, file);
  await fs.unlink(pending);
  return name;
}
async function scanHistoricalEvidence({ source, evidenceRoot, outputDirectory, batchSize, maxRecords, maxFiles, maxHashBytes,
  checkpoint, localOrigins = [], writeReport = true } = {}) {
  if (!source || !['synthetic-memory', 'firestore-emulator'].includes(source.mode) || typeof source.readPage !== 'function' ||
      (source.mode === 'firestore-emulator' && source.projectId !== 'demo-menro-phase2') ||
      !path.isAbsolute(evidenceRoot || '') || !path.isAbsolute(outputDirectory || '')) throw Error('EXPLICIT_SCAN_INPUTS_REQUIRED');
  integer(batchSize, 500); integer(maxRecords, HARD_RECORDS); integer(maxFiles, HARD_FILES); integer(maxHashBytes, 1024 * 1024 * 1024, true);
  if (!Array.isArray(localOrigins) || localOrigins.some(o => { try { return new URL(o).origin !== o || !/^https?:/.test(o); } catch { return true; } })) throw Error('INVALID_LOCAL_ORIGINS');
  await noLinks(evidenceRoot);
  const root = await fs.realpath(evidenceRoot), output = path.resolve(outputDirectory);
  if ([path.parse(root).root, path.resolve(os.homedir()), path.resolve(process.cwd())].includes(root)) throw Error('DEDICATED_EVIDENCE_ROOT_REQUIRED');
  if (inside(root, output) || inside(output, root)) throw Error('UNSAFE_OUTPUT_DIRECTORY');
  // The operator supplies an existing private output directory, never auto-mkdir through aliases.
  await noLinks(output);
  if (!((await fs.stat(root)).isDirectory() && (await fs.stat(output)).isDirectory())) throw Error('DIRECTORY_REQUIRED');
  const origins = [...localOrigins].sort(), verifiedCloud = source.mode === 'synthetic-memory' ? source.verifiedCloud || [] : [];
  const fingerprint = sha(canonical({ policy: POLICY, root, output, origins, source: source.identity, mode: source.mode,
    complete: source.complete, verifiedCloud }));
  const state = checkpointState(checkpoint, fingerprint), config = { root, origins, verifiedCloud };
  let replayReads = 0, newRecords = 0, newFiles = 0, bytesRead = 0;
  // Verify every previously scanned prefix, not just individual old documents:
  // this also catches insertion/deletion before an existing cursor.
  if (checkpoint) for (let c = 0; c < COLLECTIONS.length; c++) {
    const collection = COLLECTIONS[c], expected = state.docs.filter(d => d.collection === collection);
    if (!expected.length && c >= state.collection) continue;
    let after = null, index = 0;
    while (index < expected.length || c < state.collection) {
      const rows = await source.readPage(collection, after, Math.min(batchSize, Math.max(1, expected.length - index)));
      replayReads += rows.length;
      if (replayReads > HARD_RECORDS || rows.some(row => {
        const old = expected[index++]; return !old || old.id !== row.id ||
          canonical(old.record) !== canonical(normalizeDocument(collection, row.id, row.data, config));
      })) throw Error('SOURCE_CHANGED');
      if (!rows.length) { if (index !== expected.length) throw Error('SOURCE_CHANGED'); break; }
      after = rows[rows.length - 1].id;
      if (index === expected.length && c >= state.collection) break;
    }
  }
  while (state.collection < COLLECTIONS.length && newRecords < maxRecords && state.docs.length < HARD_RECORDS) {
    const collection = COLLECTIONS[state.collection], after = state.cursors[collection] || null;
    const limit = Math.min(batchSize, maxRecords - newRecords, HARD_RECORDS - state.docs.length);
    const rows = await source.readPage(collection, after, limit);
    if (!Array.isArray(rows) || rows.length > limit || rows.some((r, i) => typeof r.id !== 'string' || (i ? r.id <= rows[i - 1].id : after && r.id <= after))) throw Error('INVALID_SOURCE_PAGE');
    for (const row of rows) {
      const record = normalizeDocument(collection, row.id, row.data, config);
      if (state.docs.reduce((n, d) => n + d.record.refs.length, 0) + record.refs.length > HARD_EDGES) throw Error('REFERENCE_LIMIT');
      state.docs.push({ collection, id: row.id, record }); state.cursors[collection] = row.id; newRecords++;
    }
    if (rows.length < limit) state.collection++;
  }
  const inv = await inventory(root);
  if (state.inventoryDigest && state.inventoryDigest !== inv.digest) throw Error('SOURCE_CHANGED');
  state.inventoryDigest = inv.digest;
  for (const file of inv.files) {
    if (state.hashes[file.key]?.hash || file.flags.length && state.hashes[file.key]) continue;
    if (newFiles >= maxFiles) break;
    const result = await inspectFile(root, file, maxHashBytes - bytesRead);
    state.hashes[file.key] = result; bytesRead += result.bytesRead; newFiles++;
  }
  const recordsComplete = state.collection === COLLECTIONS.length;
  const complete = recordsComplete && source.complete === true && inv.complete;
  const orphanProven = complete && source.mode === 'synthetic-memory';
  const byDoc = new Map(state.docs.map(d => [d.record.key, d.record]));
  const observationCounts = new Map();
  for (const d of state.docs) for (const id of d.record.observations) observationCounts.set(id, (observationCounts.get(id) || 0) + 1);
  const byFile = new Map(inv.files.map(f => [f.key, f])), contents = new Map();
  for (const [key, result] of Object.entries(state.hashes)) if (result.hash) {
    const group = contents.get(result.hash) || []; group.push(key); contents.set(result.hash, group);
  }
  const duplicateKeys = new Set([...contents.values()].filter(g => g.length > 1).flat());
  const references = [], linked = new Set();
  for (const { record, collection } of state.docs) for (const ref of record.refs) {
    const flags = [...ref.flags];
    if (!complete) flags.push('INCOMPLETE_SOURCE');
    if (source.mode === 'firestore-emulator') flags.push('LIVE_SOURCE');
    if (record.links.some(key => !byDoc.has(key))) flags.push('MISSING_RELATION');
    if (ref.reporterKey && !byDoc.has(ref.reporterKey)) flags.push('MISSING_RELATION');
    if (collection === 'plantingContributions') {
      const parent = byDoc.get(record.parent), participant = byDoc.get(record.participant);
      if (!parent || parent.event !== record.event || (!record.directActor && (!participant || participant.event !== record.event))) flags.push('MISSING_RELATION');
      if (record.directActor) {
        if (record.participantClaim !== record.directActor || record.contributor !== record.directActor) flags.push('OWNER_CONFLICT');
      } else if (record.contributor && participant && ![participant.participantActor, participant.participantUserActor].includes(record.contributor)) flags.push('OWNER_CONFLICT');
    }
    if (ref.observation && observationCounts.get(ref.observation) > 1) flags.push('DUPLICATE_OBSERVATION_ID');
    for (const key of ref.pathKeys) {
      linked.add(key);
      const file = byFile.get(key), result = state.hashes[key];
      if (!file) {
        // A symlinked directory may hide the descendant, never classify it missing.
        if (inv.files.some(f => f.flags.includes('SYMLINK'))) flags.push('SYMLINK');
        else flags.push(complete ? 'MISSING_SOURCE' : 'INCOMPLETE_SOURCE');
      } else if (!result) flags.push('NOT_HASHED');
      else {
        flags.push(...result.flags);
        if (ref.hash && result.hash && ref.hash !== result.hash) flags.push('HASH_CONFLICT');
        if ((ref.format && result.format && ref.format !== result.format) || (ref.size && result.size !== ref.size)) flags.push('INVALID_METADATA');
        if (duplicateKeys.has(key)) flags.push('DUPLICATE_CONTENT');
      }
    }
    references.push({ id: ref.id, workflow: ref.workflow, fileIds: ref.pathKeys, classification: primary(flags), flags: [...new Set(flags)].sort() });
  }
  const counts = Object.fromEntries(CLASSES.map(c => [c, references.filter(r => r.classification === c).length]));
  const eligible = new Set(references.filter(r => r.classification === 'ELIGIBLE').flatMap(r => r.fileIds));
  const fileFindings = inv.files.map(f => ({ id: f.key, classification: f.flags.length ? 'BLOCKED' : linked.has(f.key) ? 'LINKED_FILE' : orphanProven ? 'ORPHANED_FILE' : 'REQUIRES_REVIEW' }));
  const hashComplete = inv.files.every(f => state.hashes[f.key]?.hash || f.flags.length);
  const report = { policy: POLICY, mode: 'read-only-dry-run', sourceType: source.mode, projectId: source.projectId,
    evidenceRootId: opaque('root', root), batchSize, limits: { maxRecords, maxFiles, maxHashBytes, hardRecords: HARD_RECORDS, hardFiles: HARD_FILES, hardDirectoryEntries: HARD_ENTRIES },
    usage: { newRecords, replayVerificationReads: replayReads, newFiles, bytesHashedThisRun: bytesRead, directoryEntries: inv.entries },
    completeness: { recordsComplete, assertedSourceComplete: source.complete === true, inventoryComplete: inv.complete, hashComplete,
      truncated: !recordsComplete || !inv.complete || !hashComplete, snapshot: source.mode === 'synthetic-memory' ? 'immutable-synthetic' : 'live-non-point-in-time' },
    metrics: { businessRecords: state.docs.filter(d => ['plantingReports', 'plantingContributions', 'monitoringRecords'].includes(d.collection)).length,
      allRecords: state.docs.length, evidenceReferences: references.length, uniqueLocalFilePaths: inv.files.length,
      referencedLocalFilePaths: new Set(references.flatMap(r => r.fileIds)).size,
      distinctFileContents: contents.size, bytesInspected: Object.values(state.hashes).reduce((n, r) => n + (r.hash ? r.size : 0), 0),
      bytesEligible: [...eligible].reduce((n, key) => n + (state.hashes[key]?.size || 0), 0),
      orphanedFiles: orphanProven ? fileFindings.filter(f => f.classification === 'ORPHANED_FILE').length : null,
      duplicateContentGroups: [...contents.values()].filter(g => g.length > 1).length, classifications: counts },
    workflows: Object.fromEntries(['plantingReports', 'guestContributions', 'earlyMonitoring', 'officialMonitoring', 'monitoringRevisions'].map(w => [w,
      { references: references.filter(r => r.workflow === w).length, classifications: Object.fromEntries(CLASSES.map(c => [c, references.filter(r => r.workflow === w && r.classification === c).length])) }])),
    references, fileFindings, duplicateGroups: [...contents.values()].filter(g => g.length > 1).map(g => g.sort()),
    checkpoint: { resumed: Boolean(checkpoint), resumable: state.docs.length < HARD_RECORDS || recordsComplete },
    limitations: ['No migration, mutation, Storage I/O or remote URL fetch.', 'Signature/hash checks are not image decode, EXIF authenticity or official verification.',
      'Local source completeness is operator asserted, not production certification.', 'Live emulator pagination is not a point-in-time snapshot.',
      'Read operations may update OS-managed access times; original bytes are never written.'] };
  const nextCheckpoint = { policy: POLICY, state, checksum: sha(canonical(state)) };
  if (Buffer.byteLength(JSON.stringify(nextCheckpoint)) > 32 * 1024 * 1024) throw Error('CHECKPOINT_LIMIT');
  if ((await inventory(root)).digest !== inv.digest) throw Error('SOURCE_CHANGED');
  if (writeReport) {
    await noLinks(output); if (await fs.realpath(output) !== output) throw Error('UNSAFE_OUTPUT_DIRECTORY');
    const runId = randomUUID();
    report.artifacts = { checkpoint: `scan-${runId}.checkpoint.json`, report: `scan-${runId}.report.json` };
    await publish(output, report.artifacts.checkpoint, nextCheckpoint);
    await publish(output, report.artifacts.report, report);
  }
  return { report, checkpoint: nextCheckpoint };
}
module.exports = { scanHistoricalEvidence, inspectFile };
