// Pure scanner policy. Never import application initialization or storage clients.
const path = require('node:path');
const { createHash } = require('node:crypto');
const POLICY = 'historical-evidence-6b-v1';
const COLLECTIONS = ['plantingReports', 'plantingContributions', 'monitoringRecords',
  'events', 'sites', 'users', 'eventParticipants', 'distributions', 'seedlingRequests',
  'plantingEvidenceHashes', 'monitoringEvidenceHashes'];
const CLASSES = ['BLOCKED', 'REQUIRES_REVIEW', 'ALREADY_CLOUD', 'MISSING_SOURCE',
  'INVALID_METADATA', 'DUPLICATE_CONTENT', 'ELIGIBLE'];
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k =>
    `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const opaque = (kind, value) => sha(`${POLICY}:${kind}:${value}`);
const inside = (root, target) => { const r = path.relative(root, target); return !r || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
function localPath(value, root, origins = []) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\\x00-\x1f%?#]/.test(value)) throw Error('UNSAFE_PATH');
  let candidate = value;
  // Reject traversal BEFORE URL parsing can normalize it away.
  if (candidate.split('/').some(p => p === '..' || p === '.')) throw Error('UNSAFE_PATH');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        !origins.includes(url.origin) || !url.pathname.startsWith('/uploads/')) throw Error('UNSUPPORTED_URL');
    candidate = url.pathname;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !path.isAbsolute(candidate)) throw Error('UNSAFE_PATH');
  if (candidate.startsWith('/uploads/')) candidate = candidate.slice(9);
  const target = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  if (!inside(root, target) || target === root) throw Error('UNSAFE_PATH');
  const relative = path.relative(root, target).split(path.sep).join('/');
  if (!/^(planting-reports|monitoring)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(relative) || relative.includes('..')) throw Error('UNSAFE_PATH');
  return { relative, key: opaque('file', relative) };
}
function signature(bytes) {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function cloudValid(ref, type, recordId) {
  const keys = ['provider', 'storageVersion', 'bucket', 'objectName', 'generation', 'contentType', 'format', 'sizeBytes', 'sha256', 'uploadIntentId', 'uploadedAt'];
  if (!ref || typeof ref !== 'object' || Object.keys(ref).some(k => !keys.includes(k))) return false;
  return ref.provider === 'firebase' && ref.storageVersion === 1 && ref.bucket === 'demo-menro-phase2.firebasestorage.app' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(recordId || '') && !recordId.includes('..') &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.uploadIntentId || '') &&
    ref.objectName === `evidence/v1/${type}/${recordId}/${ref.uploadIntentId}` &&
    typeof ref.generation === 'string' && /^[1-9]\d{0,19}$/.test(ref.generation) && BigInt(ref.generation) <= 18446744073709551615n &&
    ['jpeg', 'png', 'webp'].includes(ref.format) && ref.contentType === ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[ref.format] &&
    Number.isSafeInteger(ref.sizeBytes) && ref.sizeBytes > 0 && ref.sizeBytes <= 10485760 && /^[a-f0-9]{64}$/.test(ref.sha256 || '') &&
    (ref.uploadedAt == null || (typeof ref.uploadedAt === 'string' && ref.uploadedAt.length <= 64 && Number.isFinite(Date.parse(ref.uploadedAt))));
}
function primary(flags) {
  if (flags.some(f => ['UNSAFE_PATH', 'UNSUPPORTED_URL', 'SYMLINK', 'SOURCE_CHANGED', 'HASH_CONFLICT', 'DUPLICATE_OBSERVATION_ID', 'CONFLICTING_REFERENCES', 'INVALID_CLOUD', 'OWNER_CONFLICT'].includes(f))) return 'BLOCKED';
  if (flags.some(f => ['INCOMPLETE_SOURCE', 'MISSING_RELATION', 'UNKNOWN_METADATA', 'UNKNOWN_OWNER', 'LEGACY_OBSERVATION', 'REVISION_ORDER', 'UNVERIFIED_CLOUD', 'NOT_HASHED', 'READ_ERROR', 'PARENT_AGGREGATE', 'ALIAS_AMBIGUITY', 'LIVE_SOURCE'].includes(f))) return 'REQUIRES_REVIEW';
  if (flags.includes('VERIFIED_CLOUD')) return 'ALREADY_CLOUD';
  if (flags.includes('MISSING_SOURCE')) return 'MISSING_SOURCE';
  if (flags.includes('INVALID_METADATA')) return 'INVALID_METADATA';
  if (flags.includes('DUPLICATE_CONTENT')) return 'DUPLICATE_CONTENT';
  return 'ELIGIBLE';
}

function normalizeDocument(collection, id, data, config) {
  const docKey = opaque(collection, id), links = [], refs = [], observations = [];
  const link = (field, target, required = false) => {
    if (typeof data[field] === 'string' && data[field]) links.push(opaque(target, data[field]));
    else if (required) links.push('missing');
  };
  if (collection === 'plantingReports') { link('siteId', 'sites'); link('eventId', 'events'); link('participantId', 'users', true); link('distributionId', 'distributions'); link('requestId', 'seedlingRequests'); }
  if (collection === 'plantingContributions') {
    link('reportId', 'plantingReports', true); link('eventId', 'events', true);
    // Registered request-linked reports store UID directly; guest/allocation
    // contributions store an eventParticipants document ID. Both are real schemas.
    if (data.authenticatedSubmitterUid) link('authenticatedSubmitterUid', 'users', true);
    else link('participantId', 'eventParticipants', true);
  }
  if (collection === 'monitoringRecords') { link('plantingReportId', 'plantingReports', true); link('siteId', 'sites'); link('eventId', 'events'); }
  const add = (photo, pointer, workflow, type, target, flags = [], actor) => {
    if (!photo || typeof photo !== 'object') return;
    const paths = [photo.photoPath, photo.photoURL, photo.photoUrl].filter(v => v !== undefined && v !== null && v !== '');
    if (!paths.length && !photo.privateEvidence) return;
    const keys = [];
    for (const value of paths) { try { keys.push(localPath(value, config.root, config.origins).key); } catch (e) { flags.push(e.message === 'UNSUPPORTED_URL' ? e.message : 'UNSAFE_PATH'); } }
    if (new Set(keys).size > 1 || (keys.length && photo.privateEvidence)) flags.push('CONFLICTING_REFERENCES');
    if (!actor) flags.push('UNKNOWN_OWNER');
    const hash = photo.imageHash;
    if (hash === undefined || hash === null || hash === '') flags.push('UNKNOWN_METADATA');
    else if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) flags.push('INVALID_METADATA');
    const format = photo.imageDetails?.format;
    if (paths.length && !format) flags.push('UNKNOWN_METADATA');
    if (format !== undefined && !['jpeg', 'png', 'webp'].includes(format)) flags.push('INVALID_METADATA');
    for (const dim of ['width', 'height']) if (photo.imageDetails?.[dim] !== undefined &&
      (!Number.isSafeInteger(photo.imageDetails[dim]) || photo.imageDetails[dim] < 1)) flags.push('INVALID_METADATA');
    if (photo.photoSize !== undefined && (!Number.isSafeInteger(photo.photoSize) || photo.photoSize < 1)) flags.push('INVALID_METADATA');
    if (photo.privateEvidence) {
      if (!cloudValid(photo.privateEvidence, type, target)) flags.push('INVALID_CLOUD');
      else {
        if (hash && hash !== photo.privateEvidence.sha256) flags.push('HASH_CONFLICT');
        if ((format && format !== photo.privateEvidence.format) || (photo.photoSize && photo.photoSize !== photo.privateEvidence.sizeBytes)) flags.push('INVALID_METADATA');
        if (config.verifiedCloud.includes(sha(canonical(photo.privateEvidence)))) flags.push('VERIFIED_CLOUD');
        else flags.push('UNVERIFIED_CLOUD');
      }
    }
    refs.push({ id: opaque('edge', `${collection}/${id}/${pointer}`), workflow, pathKeys: [...new Set(keys)],
      flags: [...new Set(flags)], hash: typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) ? hash : null,
      format: ['jpeg', 'png', 'webp'].includes(format) ? format : null,
      size: Number.isSafeInteger(photo.photoSize) ? photo.photoSize : null,
      actor: actor ? opaque('actor', actor) : null,
      reporterKey: workflow.includes('Monitoring') || workflow === 'monitoringRevisions' ? (actor ? opaque('users', actor) : 'missing') : null,
      observation: target ? opaque('observation', target) : null });
  };
  if (collection === 'plantingReports' || collection === 'plantingContributions') {
    const parent = data.reportType === 'parent', contribution = collection === 'plantingContributions';
    const workflow = contribution ? 'guestContributions' : 'plantingReports';
    const type = contribution ? 'planting-contribution' : 'planting-report';
    const flags = parent ? ['PARENT_AGGREGATE'] : [];
    (Array.isArray(data.photos) ? data.photos : []).forEach((p, i) => add(p, `photos/${i}`, workflow, type, id, [...flags], data.contributorId || data.participantId));
    const photoEdges = refs.length;
    add(data, 'root-alias', workflow, type, id, [...flags], data.contributorId || data.participantId);
    if (photoEdges && refs.length > photoEdges && canonical(refs[0].pathKeys) !== canonical(refs.at(-1).pathKeys)) refs.at(-1).flags.push('ALIAS_AMBIGUITY');
  }
  if (collection === 'monitoringRecords') {
    const history = Array.isArray(data.history) ? data.history : [data];
    history.forEach((o, i) => {
      const legacy = !Array.isArray(data.history) || !o.id;
      const flags = legacy ? ['LEGACY_OBSERVATION'] : [];
      const obsKey = o.id ? opaque('observation', o.id) : null;
      if (obsKey) observations.push(obsKey);
      const workflow = o.observationType === 'early' ? 'earlyMonitoring' : 'officialMonitoring';
      if (!['early', 'official'].includes(o.observationType)) flags.push('LEGACY_OBSERVATION');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.monitoredDate || '') || !Number.isFinite(Date.parse(o.monitoredDate)) ||
          new Date(o.monitoredDate).toISOString().slice(0, 10) !== o.monitoredDate) flags.push('INVALID_METADATA');
      const revisions = Array.isArray(o.revisionHistory) ? o.revisionHistory : [];
      if (revisions.some((r, j) => !Number.isInteger(r.revisionNumber) || r.revisionNumber !== j + 1 ||
        !Number.isInteger(r.evidenceRevision) || r.evidenceRevision < 1 || r.evidenceRevision > r.revisionNumber)) flags.push('REVISION_ORDER');
      const active = revisions.findLast(r => r.evidenceRevision === o.currentEvidenceRevision)?.evidenceRef;
      const evidenceIdentity = p => p?.privateEvidence ? sha(canonical(p.privateEvidence)) : p?.photoUrl;
      if (revisions.length && (!active || evidenceIdentity(active) !== evidenceIdentity(o))) flags.push('REVISION_ORDER');
      const type = `monitoring-${o.observationType}`, reporter = o.originalReporterId || o.monitoredBy;
      add(o, `history/${i}`, workflow, type, o.id, [...flags], reporter);
      revisions.forEach((r, j) => add(r.evidenceRef, `history/${i}/revisions/${j}`, 'monitoringRevisions', type, o.id, [...flags], reporter));
    });
  }
  return { key: docKey, links, refs, observations, rawDigest: sha(canonical(data)),
    // Relationship checks use only pseudonymous bindings, never contact/session data.
    event: data.eventId ? opaque('events', data.eventId) : null,
    parent: data.reportId ? opaque('plantingReports', data.reportId) : null,
    participant: data.participantId ? opaque('eventParticipants', data.participantId) : null,
    contributor: data.contributorId ? opaque('actor', data.contributorId) : null,
    directActor: data.authenticatedSubmitterUid ? opaque('actor', data.authenticatedSubmitterUid) : null,
    participantClaim: data.participantId ? opaque('actor', data.participantId) : null,
    participantActor: collection === 'eventParticipants' ? opaque('actor', id) : null,
    participantUserActor: collection === 'eventParticipants' && data.userId ? opaque('actor', data.userId) : null };
}
module.exports = { POLICY, COLLECTIONS, CLASSES, sha, canonical, opaque, inside, localPath, signature, primary, normalizeDocument };
