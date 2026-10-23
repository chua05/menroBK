const test = require('node:test'), assert = require('node:assert/strict');
const { validateBucketMetadata, reviewIamSnapshot, validateDenialPlan, validateProjectAncestry } = require('../src/services/nonproductionStorageAcceptancePolicy.service');
const { PROPOSED_SAME_PROJECT_TARGET: target } = require('../src/services/nonproductionStorageAcceptance.service');
const metadata = () => ({ name: target.bucket, location: 'ASIA-SOUTHEAST1', storageClass: 'STANDARD',
  iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' } });
test('exact bucket region, class, uniform access and enforced public prevention pass offline', () => {
  assert.equal(validateBucketMetadata(metadata(), target), undefined);
});
for (const [name, mutate, code] of [
  ['production bucket', m => { m.name = 'menrosystem-ddfac.firebasestorage.app'; }, 'BUCKET_IDENTITY_MISMATCH'],
  ['wrong region', m => { m.location = 'US'; }, 'BUCKET_CONFIGURATION_MISMATCH'],
  ['wrong class', m => { m.storageClass = 'NEARLINE'; }, 'BUCKET_CONFIGURATION_MISMATCH'],
  ['missing uniform', m => { m.iamConfiguration.uniformBucketLevelAccess = {}; }, 'BUCKET_PRIVACY_NOT_VERIFIED'],
  ['public prevention inherited', m => { m.iamConfiguration.publicAccessPrevention = 'inherited'; }, 'BUCKET_PRIVACY_NOT_VERIFIED'],
]) test(`bucket snapshot rejects ${name}`, () => { const m = metadata(); mutate(m); assert.throws(() => validateBucketMetadata(m, target), { code }); });
const actor = `serviceAccount:${target.serviceAccountEmail}`;
const snapshot = () => ({ ...target, metadataRolePermissions: ['storage.buckets.get'], bindings: [
  { scope: 'bucket', role: 'roles/storage.objectUser', members: [actor] },
  { scope: 'bucket', role: `projects/${target.projectId}/roles/menroAcceptanceBucketMetadata`, members: [actor] },
] });
test('offline IAM projection does not pretend to verify complete inheritance', () => {
  const result = reviewIamSnapshot(snapshot(), target);
  assert.deepEqual(result.issues, ['OBJECT_USER_EXCEEDS_PROBE_PERMISSIONS']);
  assert.equal(result.liveVerified, false); assert.equal(result.complete, false); assert.equal(result.manualReviewRequired, true);
});
for (const [name, binding, issue] of [
  ['public', { scope: 'bucket', role: 'roles/storage.objectViewer', members: ['allUsers'] }, 'PUBLIC_BINDING'],
  ['inherited owner', { scope: 'project', role: 'roles/owner', members: [actor] }, 'INHERITED_OR_NONBUCKET_ACCESS'],
  ['organization', { scope: 'organization', role: 'roles/storage.admin', members: [actor] }, 'INHERITED_OR_NONBUCKET_ACCESS'],
  ['unknown role', { scope: 'bucket', role: 'roles/storage.admin', members: [actor] }, 'UNEXPECTED_ROLE'],
  ['group', { scope: 'project', role: 'roles/viewer', members: ['group:synthetic@example.com'] }, 'INDIRECT_MEMBERSHIP_REVIEW_REQUIRED'],
  ['condition', { scope: 'bucket', role: 'roles/storage.objectViewer', members: [actor], condition: {} }, 'CONDITIONAL_BINDING_REVIEW_REQUIRED'],
]) test(`IAM snapshot reports ${name}`, () => { const s = snapshot(); s.bindings.push(binding); assert.ok(reviewIamSnapshot(s, target).issues.includes(issue)); });
test('Object User alone does not prove bucket metadata permission', () => {
  const s = snapshot(); s.bindings.pop(); assert.ok(reviewIamSnapshot(s, target).issues.includes('BUCKET_METADATA_PERMISSION_NOT_CONFIRMED'));
});
test('overbroad custom metadata role is not accepted as narrow permission', () => {
  const s = snapshot(); s.metadataRolePermissions.push('storage.buckets.update');
  assert.ok(reviewIamSnapshot(s, target).issues.includes('BUCKET_METADATA_PERMISSION_NOT_CONFIRMED'));
});
test('Phase 8G actual role ID is recognized only with the exact bucket-scoped metadata permission', () => {
  const s = snapshot();
  s.bindings[1].role = `projects/${target.projectId}/roles/menroGcsBucketMetadataReader`;
  assert.deepEqual(reviewIamSnapshot(s, target).issues, ['OBJECT_USER_EXCEEDS_PROBE_PERMISSIONS']);
  s.metadataRolePermissions.push('storage.buckets.update');
  assert.ok(reviewIamSnapshot(s, target).issues.includes('BUCKET_METADATA_PERMISSION_NOT_CONFIRMED'));
});
test('an arbitrary custom role name cannot claim the approved metadata grant', () => {
  const s = snapshot(); s.bindings[1].role = `projects/${target.projectId}/roles/unapprovedRole`;
  const result = reviewIamSnapshot(s, target);
  assert.ok(result.issues.includes('UNEXPECTED_ROLE'));
  assert.ok(result.issues.includes('BUCKET_METADATA_PERMISSION_NOT_CONFIRMED'));
});
test('wrong project and oversized or malformed IAM snapshots are rejected', () => {
  for (const s of [{ ...snapshot(), projectId: 'other-project' }, { ...snapshot(), bindings: Array(1001).fill({}) },
    { ...snapshot(), bindings: [{ scope: 'unknown' }] }]) assert.throws(() => reviewIamSnapshot(s, target), /IAM_SNAPSHOT_INVALID/);
});
const context = { ...target, prefix: 'menro-acceptance/00000000-0000-4000-8000-000000000000/' };
const deniedPlan = { projectId: target.projectId, bucket: target.bucket, objectName: context.prefix + 'synthetic.png',
  generation: '18446744073709551615', serviceAccountEmail: 'synthetic-denied@menrosystem-ddfac.iam.gserviceaccount.com' };
test('second-identity plan is blocked until an exact additional identity is separately approved', () => {
  assert.throws(() => validateDenialPlan(deniedPlan, context), /SECOND_IDENTITY_APPROVAL_REQUIRED/);
  assert.deepEqual(validateDenialPlan(deniedPlan, context, [deniedPlan.serviceAccountEmail]),
    { readOnly: true, maxObjectRequests: 1, requiresExecutionAuthorization: true });
});
test('second-identity planning cannot select production, other objects, rounded generations or the primary identity', () => {
  for (const changes of [{ bucket: 'menrosystem-ddfac.firebasestorage.app' }, { objectName: 'historical/evidence' },
    { generation: 18446744073709551615 }, { serviceAccountEmail: target.serviceAccountEmail }]) {
    const plan = { ...deniedPlan, ...changes };
    assert.throws(() => validateDenialPlan(plan, context, [plan.serviceAccountEmail]));
  }
});

// Synthetic API fixtures, NOT the discarded body of the previous live response.
const project = () => ({ projectId: target.projectId, projectNumber: '123456789012', lifecycleState: 'ACTIVE' });
const ancestor = (id = target.projectId, type = 'project') => ({ resourceId: { type, id } });
const ancestry = id => ({ ancestor: [ancestor(id)] });
test('project-ID ancestry reproduces the old numeric-only false rejection and passes exact identity validation', () => {
  const p = project(), response = ancestry();
  const oldPredicate = response.ancestor?.length === 1 && response.ancestor[0].resourceId?.type === 'project' &&
    String(response.ancestor[0].resourceId?.id) === String(p.projectNumber);
  assert.equal(oldPredicate, false);
  assert.deepEqual(validateProjectAncestry(response, p, target), {
    projectMatches: true, projectOnly: true, ancestorCount: 1, ancestorTypes: ['project'], projectReference: 'projectId',
  });
});
test('exact verified project-number ancestry is accepted as a string, not coerced', () => {
  const p = project();
  assert.equal(validateProjectAncestry(ancestry(p.projectNumber), p, target).projectReference, 'projectNumber');
});
test('large project numbers retain exact precision and cannot match a rounded number', () => {
  const p = { ...project(), projectNumber: '9007199254740993' };
  assert.equal(validateProjectAncestry(ancestry(p.projectNumber), p, target).projectReference, 'projectNumber');
  assert.throws(() => validateProjectAncestry(ancestry('9007199254740992'), p, target), { code: 'ANCESTRY_PROJECT_MISMATCH' });
});
test('ancestry summary is immutable and exposes only safe match/shape information', () => {
  const result = validateProjectAncestry(ancestry(), project(), target);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.ancestorTypes));
  assert.equal(JSON.stringify(result).includes(target.projectId), false);
  assert.equal(JSON.stringify(result).includes(project().projectNumber), false);
});
for (const [name, response] of [
  ['missing response', undefined], ['null response', null], ['primitive response', 'sensitive-response'],
  ['array response', []], ['missing ancestor', {}], ['plural ancestors', { ancestors: [ancestor()] }],
  ['unwrapped HTTP response expected', { data: ancestry() }], ['null ancestor', { ancestor: null }],
  ['nonarray ancestor', { ancestor: ancestor() }], ['empty ancestor', { ancestor: [] }],
  ['oversized ancestor', { ancestor: Array(101).fill(ancestor()) }], ['sparse ancestor', { ancestor: Array(1) }],
  ['null entry', { ancestor: [null] }], ['primitive entry', { ancestor: ['sensitive-entry'] }],
  ['missing resourceId', { ancestor: [{}] }], ['null resourceId', { ancestor: [{ resourceId: null }] }],
  ['primitive resourceId', { ancestor: [{ resourceId: target.projectId }] }],
  ['missing type', { ancestor: [{ resourceId: { id: target.projectId } }] }],
  ['unknown type', { ancestor: [ancestor(target.projectId, 'bucket')] }],
  ['missing id', { ancestor: [{ resourceId: { type: 'project' } }] }],
  ['empty id', ancestry('')], ['numeric id', ancestry(123456789012)], ['whitespace id', ancestry(` ${target.projectId}`)],
  ['URL id', ancestry('https://invalid.example/private')], ['oversized id', ancestry('a'.repeat(64))],
  ['inherited ancestor', Object.create({ ancestor: [ancestor()] })],
]) test(`ancestry fails closed on ${name}`, () => {
  assert.throws(() => validateProjectAncestry(response, project(), target), e => {
    assert.equal(e.code, 'ANCESTRY_RESPONSE_INVALID'); assert.equal(e.message, e.code); return true;
  });
});
for (const [name, response] of [
  ['other project ID', ancestry('other-project')], ['other project number', ancestry('987654321012')],
  ['suffix match', ancestry(`${target.projectId}-other`)], ['case folding', ancestry(target.projectId.toUpperCase())],
  ['folder first', { ancestor: [ancestor('123', 'folder')] }],
  ['organization first', { ancestor: [ancestor('456', 'organization')] }],
]) test(`ancestry rejects ${name}`, () => {
  assert.throws(() => validateProjectAncestry(response, project(), target), { code: 'ANCESTRY_PROJECT_MISMATCH' });
});
for (const [name, extra] of [
  ['folder', ancestor('123', 'folder')], ['organization', ancestor('456', 'organization')],
  ['duplicate project', ancestor()],
]) test(`unapproved ${name} ancestor is not silently ignored`, () => {
  assert.throws(() => validateProjectAncestry({ ancestor: [ancestor(), extra] }, project(), target), { code: 'ANCESTRY_REVIEW_REQUIRED' });
});
for (const [name, changes] of [
  ['missing project number', { projectNumber: undefined }], ['numeric project number', { projectNumber: 123456789012 }],
  ['leading-zero project number', { projectNumber: '0123456789012' }],
  ['out-of-int64 project number', { projectNumber: '9223372036854775808' }],
  ['inactive project', { lifecycleState: 'DELETE_REQUESTED' }], ['missing lifecycle state', { lifecycleState: undefined }],
]) test(`ancestry requires verified project metadata: ${name}`, () => {
  assert.throws(() => validateProjectAncestry(ancestry(), { ...project(), ...changes }, target), { code: 'PROJECT_METADATA_INVALID' });
});
test('a parent in project metadata cannot be hidden by a project-only ancestry response', () => {
  assert.throws(() => validateProjectAncestry(ancestry(), { ...project(), parent: { type: 'folder', id: '123' } }, target),
    { code: 'ANCESTRY_REVIEW_REQUIRED' });
});
test('unverified, missing or mismatched project/target identity is rejected', () => {
  for (const [p, t] of [[undefined, target], [{}, target], [{ ...project(), projectId: 'other-project' }, target],
    [project(), undefined], [project(), { projectId: 'other-project' }]]) {
    assert.throws(() => validateProjectAncestry(ancestry(), p, t), { code: 'PROJECT_IDENTITY_MISMATCH' });
  }
});
