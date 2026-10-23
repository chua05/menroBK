// Pure offline inspection of operator-provided snapshots, NOT live IAM attestation.
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
function validateProjectAncestry(response, project, target) {
  // Caller supplies the body of a fresh projects.get for the already allowlisted
  // target. Do not infer identity from ancestry alone or coerce int64 IDs to Number.
  if (!plain(target) || typeof target.projectId !== 'string' || !plain(project) ||
      !Object.hasOwn(project, 'projectId') || project.projectId !== target.projectId) fail('PROJECT_IDENTITY_MISMATCH');
  if (!Object.hasOwn(project, 'projectNumber') || typeof project.projectNumber !== 'string' ||
      !/^[1-9]\d{0,18}$/.test(project.projectNumber) || BigInt(project.projectNumber) > 9223372036854775807n ||
      !Object.hasOwn(project, 'lifecycleState') || project.lifecycleState !== 'ACTIVE') fail('PROJECT_METADATA_INVALID');
  // This approval covers the previously reviewed project-only hierarchy, NOT new
  // folder/org inheritance. Even a contradictory projects.get parent must stop it.
  if (project.parent !== undefined) fail('ANCESTRY_REVIEW_REQUIRED');
  if (!plain(response) || !Object.hasOwn(response, 'ancestor') || !Array.isArray(response.ancestor) ||
      !response.ancestor.length || response.ancestor.length > 100) fail('ANCESTRY_RESPONSE_INVALID');
  for (const entry of response.ancestor) {
    if (!plain(entry) || !Object.hasOwn(entry, 'resourceId') || !plain(entry.resourceId) ||
        !Object.hasOwn(entry.resourceId, 'type') || !['project', 'folder', 'organization'].includes(entry.resourceId.type) ||
        !Object.hasOwn(entry.resourceId, 'id') || typeof entry.resourceId.id !== 'string' ||
        !/^[A-Za-z0-9-]{1,63}$/.test(entry.resourceId.id)) fail('ANCESTRY_RESPONSE_INVALID');
  }
  const first = response.ancestor[0].resourceId;
  // ResourceId.id is type-specific, not guaranteed to be the numeric projectNumber.
  // Both exact aliases must come from the same verified, allowlisted project body.
  const reference = first.id === project.projectId ? 'projectId' : first.id === project.projectNumber ? 'projectNumber' : null;
  if (first.type !== 'project' || !reference) fail('ANCESTRY_PROJECT_MISMATCH');
  if (response.ancestor.length !== 1) fail('ANCESTRY_REVIEW_REQUIRED');
  return Object.freeze({ projectMatches: true, projectOnly: true, ancestorCount: 1,
    ancestorTypes: Object.freeze(['project']), projectReference: reference });
}
function validateBucketMetadata(metadata, target) {
  if (metadata?.name !== target.bucket) fail('BUCKET_IDENTITY_MISMATCH');
  if (metadata.location?.toLowerCase() !== 'asia-southeast1' || metadata.storageClass !== 'STANDARD') fail('BUCKET_CONFIGURATION_MISMATCH');
  if (metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
      metadata.iamConfiguration?.publicAccessPrevention !== 'enforced') fail('BUCKET_PRIVACY_NOT_VERIFIED');
}
function reviewIamSnapshot(snapshot, target) {
  if (!snapshot || snapshot.projectId !== target.projectId || snapshot.bucket !== target.bucket ||
      snapshot.serviceAccountEmail !== target.serviceAccountEmail || !Array.isArray(snapshot.bindings) ||
      snapshot.bindings.length > 1000) fail('IAM_SNAPSHOT_INVALID');
  const issues = new Set(), actor = `serviceAccount:${target.serviceAccountEmail}`;
  let objectRole = false, metadataRole = false;
  // Phase 8G verified the live role ID; retain the earlier proposal for snapshot compatibility.
  const metadataRoles = [`projects/${target.projectId}/roles/menroGcsBucketMetadataReader`,
    `projects/${target.projectId}/roles/menroAcceptanceBucketMetadata`];
  for (const b of snapshot.bindings) {
    if (!b || !['bucket', 'project', 'folder', 'organization', 'serviceAccount'].includes(b.scope) ||
        typeof b.role !== 'string' || !Array.isArray(b.members) || b.members.length > 1000 ||
        b.members.some(m => typeof m !== 'string')) fail('IAM_SNAPSHOT_INVALID');
    if (b.members.some(m => ['allUsers', 'allAuthenticatedUsers'].includes(m))) issues.add('PUBLIC_BINDING');
    if (b.members.some(m => m.startsWith('group:') || m.startsWith('domain:') || m.startsWith('principalSet:'))) issues.add('INDIRECT_MEMBERSHIP_REVIEW_REQUIRED');
    if (b.condition) issues.add('CONDITIONAL_BINDING_REVIEW_REQUIRED');
    if (!b.members.includes(actor)) continue;
    if (b.scope !== 'bucket') issues.add('INHERITED_OR_NONBUCKET_ACCESS');
    else if (!b.condition && b.role === 'roles/storage.objectUser') {
      objectRole = true; issues.add('OBJECT_USER_EXCEEDS_PROBE_PERMISSIONS');
    } else if (!b.condition && metadataRoles.includes(b.role)) metadataRole = true;
    else issues.add('UNEXPECTED_ROLE');
  }
  if (!objectRole) issues.add('OBJECT_ROLE_NOT_CONFIRMED');
  const permissions = snapshot.metadataRolePermissions;
  if (!metadataRole || !Array.isArray(permissions) || permissions.length !== 1 || permissions[0] !== 'storage.buckets.get') {
    issues.add('BUCKET_METADATA_PERMISSION_NOT_CONFIRMED');
  }
  return { liveVerified: false, complete: false, manualReviewRequired: true, issues: [...issues].sort() };
}
function validateDenialPlan(plan, target, approvedIdentities = []) {
  // Preparation only. No second identity is approved by default; no CLI execution path.
  if (!plan || plan.projectId !== target.projectId || plan.bucket !== target.bucket ||
      plan.objectName !== target.prefix + 'synthetic.png' ||
      typeof plan.generation !== 'string' || !/^[1-9]\d{0,19}$/.test(plan.generation) ||
      BigInt(plan.generation) > 18446744073709551615n) fail('DENIAL_TARGET_INVALID');
  if (plan.serviceAccountEmail === target.serviceAccountEmail ||
      !approvedIdentities.includes(plan.serviceAccountEmail)) fail('SECOND_IDENTITY_APPROVAL_REQUIRED');
  return { readOnly: true, maxObjectRequests: 1, requiresExecutionAuthorization: true };
}
module.exports = { validateBucketMetadata, reviewIamSnapshot, validateDenialPlan, validateProjectAncestry };
