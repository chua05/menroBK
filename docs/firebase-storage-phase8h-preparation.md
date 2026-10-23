# Phase 8H preparation - one bounded synthetic GCS acceptance run

21 October 2026. **Execution: BLOCKED pending the explicit approvals below.**
Technical recommendation: conditional GO under a one-run shared-project trust
exception. Strict administrative isolation is NOT established and is NOT a property
this synthetic Storage contract test can prove. No live acceptance was performed.

Phase 8G and 8F were reviewed and reused. This phase performed offline source,
identity-metadata and dependency review, two scoped offline corrections and
mock regressions only. No new customer-cloud API requests or token issuance, GCS
object operations, IAM/bucket/credential/environment-file changes, production-data
access, migration, scheduler activation, deployment or Git write.

## 1. Exact principals, scope and dependency evidence

| Principal | Phase 8G live binding/evidence | Risk |
| --- | --- | --- |
| chuakyla21@gmail.com | roles/owner on menrosystem-ddfac; direct roles/iam.serviceAccountTokenCreator on acceptance SA | Operator credentials have broader production-sensitive authority than the probe needs |
| firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com | Project-wide roles/storage.admin AND roles/iam.serviceAccountTokenCreator; additional Firebase SDK/Auth roles | Broad bucket administration and inherited project-SA impersonation, including acceptance identity |
| menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com | Bucket-scoped roles/storage.objectUser and projects/menrosystem-ddfac/roles/menroGcsBucketMetadataReader; no direct project role observed | Object User permits update/delete/list beyond this probe's needs; harness does not exercise those powers |

The formerly pseudonymized serviceAccount#aabdd014ba was identified OFFLINE: the
local Admin credential's client_email matches that exact Phase 8G principal hash
and its project_id matches menrosystem-ddfac. Only identity metadata was extracted;
no private key or credential contents were printed/saved. This is correlation with
the earlier live policy, not a fresh IAM query or verification of the deployed
Render identity. No principal name was guessed from a naming convention.

Dependency review before considering role removal:

- src/config/firebase.js uses the local service-account credential in nonproduction,
  and FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY in production, initializing shared
  Auth and Firestore clients. The actual deployed environment was not inspected.
- src/services/auth.service.js uses createUser/deleteUser/getUser and Firestore
  profiles; auth middleware uses verifyIdToken with revocation checks. Notifications,
  inventory, requests, planting and monitoring services share that Firestore client.
- Current src search found no direct createCustomToken/signBlob/signJwt/getSignedUrl
  use. The application's real cloud Storage accessor remains demo-gated. These facts
  do NOT prove project-wide grants are unused by other deployments, Firebase-managed
  services, signing paths or administration. Their custody/delegation was not audited.

**Do not remove or narrow any existing role for this test.** A separate dependency
and effective-permission review would be required before proposing an IAM change.
An absence of direct signing calls in this repository is not sufficient justification.
The bucket's legacy project Owner/Editor/Viewer convenience grants and other trusted
project administrators remain part of the shared-project boundary.

## 2. Isolation decision and defensible exception

Strict isolation from project administrators is unnecessary for THIS narrowly defined
contract probe, provided the user explicitly trusts the existing administrators and
accepts the exception. The probe contains no personal data, real evidence, business
IDs or production references; uses only the fixed test bucket and impersonated test
SA; is one invocation with one object name; and cannot mutate IAM or Firestore.

The unmodified reviewed harness rejects both production bucket names, other project/
bucket/identity tuples, raw paths/URLs and unapproved config fields. Code dispatch
uses no application Firebase/Firestore initialization. The Storage client receives
only an introspected short-lived acceptance-SA token, not the Owner's refresh token.
These controls reduce accidental reach, but are NOT an IAM sandbox against a
malicious operator, changed code, compromised project admin or compromised credentials.
Administrators can affect the test bucket or impersonate the acceptance SA; the run
cannot prove tamper-resistance against those administrators or universal IAM denial.

Exception is defensible ONLY for synthetic create/read/precondition/integrity behavior.
It does not authorize sensitive uploads, historical migration, production activation,
second-identity testing, application authorization claims or recurring tests.

If administrator separation or adversarial IAM isolation is an acceptance requirement,
this plan is NO-GO: request a separately authorized isolated-project/identity design.
Do not attempt to manufacture isolation by removing production roles or weakening
MENRO authentication/Storage safeguards. User approval, not this recommendation,
must settle the exception.

## 3. Exact synthetic and cost boundaries

| Boundary | Limit |
| --- | --- |
| Project/bucket | menrosystem-ddfac / menro-gcs-acceptance-20261021-6f8c2d91 ONLY |
| Effective identity | menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com via existing keyless ADC |
| Runs | ONE foreground invocation; no loops, scheduler or automatic reruns |
| Prefix | menro-acceptance/<one recorded fresh lowercase UUID>/; keep same config for any separately approved recovery |
| Writable object name | <prefix>synthetic.png ONLY; one name, normally one successful generation |
| Positive image | Fixed synthetic 2x2 PNG, exactly 95 bytes; no filesystem/client image input |
| Positive SHA-256 | c6237b04a3bc02f90c02786681d5a4df51e1703d11c9c6a85feeb8a4775787f4 |
| Negative overwrite body | Fixed 29-byte synthetic-overwrite-must-fail string, same name, ifGenerationMatch=0; MUST receive 412 |
| Total attempted object payload | 124 bytes (95 + 29), well below a 1 KiB payload allowance; metadata/TLS/auth overhead excluded |
| Maximum normal successful objects | ONE name / ONE generation / 95 payload bytes |
| Abnormal precondition failure | At most TWO successful saves to the SAME name, potentially 2 generation/soft-delete states totaling 124 payload bytes; then FAIL immediately |
| Other name touched | <prefix>missing.png: metadata GET ONLY, expected 404; never created |
| Normal explicit Storage requests | At most 9: bucket metadata, missing metadata, two save attempts, two object metadata reads, two bounded generation reads, one anonymous probe |
| Authenticated media bytes | At most two successful 95-byte image reads; request headers/metadata/error overhead additional |
| Forbidden | Production buckets/objects, lists, user evidence, database links, extra prefixes/names, second identity, deletes, restores and cloud config changes |

The worst-case generation allowance is disclosure of what a BROKEN server
precondition could do, not permission to retry or accept overwrites. Normal result
must have one successful create, collision 412 and unchanged original bytes/generation.
If first invocation unexpectedly reports resumed=true, do not certify a fresh-object
test: investigate ownership using the retained manifest under separate approval.

Storage SDK automatic retry is disabled. Auth SDKs can have bounded internal retries;
the 9 requests are an application-level Storage limit, not an exact network/billing
cap. Same-prefix recovery support is not authorization for a second invocation.

Phase 8G found: Standard class, versioning disabled, no bucket retention policy,
no default event-based hold, zero lifecycle rules, and soft-delete duration 604800
seconds (7 days). Billing is linked/enabled. These are historical preflight facts,
not rechecked in this offline phase; unexpected changes must stop the later run.

Soft delete can retain deleted/overwritten bytes and continue storage charges for
seven days after deletion. It does not automatically delete a live test object after
seven days. Until cleanup is separately approved, the live object remains billable
indefinitely. Ordinary cleanup is not immediate physical erasure and cannot shorten
an already soft-deleted object's retention. Do not change bucket policy or restore
objects to bypass this behavior. Requests/metadata/egress also may be charged.
The payload limits above are NOT billable-byte or currency caps; metadata, pricing,
taxes, account terms, alerts and billing-wide caps were not verified. No zero-cost
promise. For one tiny object, accepting the existing seven-day policy is more
proportionate than changing production-project settings solely for this test.
An explicitly named cost/recovery owner must accept those charges and retained bytes.

Public reference: [GCS soft delete and pricing implications](https://docs.cloud.google.com/storage/docs/soft-delete).

## 4. Harness review and confirmed offline correction

Preserved: frozen exact tuple, production-bucket negatives, config allow-keys and
UUID prefix, independent CLI/environment execution gates, no dotenv/ADC discovery,
explicit keyless ADC selection, fixed impersonation endpoint/SA/scopes/lifetime,
Google tokeninfo identity/expiry checks, fixed-token Storage client with no source
credential fallback, bucket name/region/class/PAP/uniform-access validation,
create-only CRC32C uploads, generation strings/no numeric truncation, SHA-256 and
size/private metadata checks, no public download token, missing/anonymous failure
handling, bounded streaming/timeouts, sanitized CLI failures, no list/delete API.
Both production bucket names remain rejected even by injected permissive test policy.
Any failed cloud read cannot fall back to a local file. Existing application evidence,
local storage, revisions, schedules and migration accounting are untouched.

Confirmed correction: the pure offline reviewIamSnapshot helper recognized only
the proposed menroAcceptanceBucketMetadata role ID. Phase 8G actually verified
menroGcsBucketMetadataReader with exactly storage.buckets.get. The helper now accepts
these TWO exact same-project role IDs for snapshot compatibility, still requiring
the exact one-permission definition, unconditional bucket binding and correct target.
No arbitrary role, additional permission, live IAM change or execution allowlist
expansion. It still ALWAYS returns manualReviewRequired=true/liveVerified=false and
cannot certify complete effective IAM. This helper is not an upload authorization path.

Second confirmed defect: installed Storage SDK 8.4.0 file.js:_File_validateIntegrity
automatically calls this.delete() after CRC32C validation fails. The acceptance
bucket's Object User permission could allow that unapproved cleanup. The acceptance
save adapter now puts an immutable rejecting delete method ONLY on each acceptance
upload's File handle. CRC32C validation remains enabled; mismatch still fails and
leaves an uncertain object for later authorized reconciliation. No global prototype,
SDK dependency or unrelated MENRO upload service was modified. The SDK error stays
behind the existing sanitized CLI failure path. This is not a checksum bypass.

Tests added for the live role ID/overbroad-permission rejection, arbitrary custom
role rejection, per-file immutable no-delete behavior and ACTUAL SDK corrupt-CRC
handling against an isolated loopback stub. The stub persisted the synthetic request
and returned a wrong CRC; the upload failed, bytes remained, and the ONLY HTTP method
observed was POST, never DELETE. Other File handles retained their original methods.

Final focused offline harness/auth/policy/config/retrieval/resolver/workflow/readiness/
init/isolation plus SDK transport suite: **190 passed, 0 failed, 0 skipped**.
Includes 106 harness/auth/policy and 2 SDK loopback cases. Existing clean-lockfile temp install reused,
Node 22.14.0; package/lock hashes match repository. No installation or replacement of
repository node_modules, which remains stale and must NOT be used for the live run.
No full-root/emulator rerun this phase; Phase 8F 474/474 remains historical. Known
Storage Emulator precondition limitation remains visible, not weakened or retested.
All five changed JavaScript files pass syntax checks; all six scoped files pass
whitespace checks; git diff --check passes with existing LF/CRLF warnings only.
Staging remains empty and branch remains fix/validated-survival-analytics.

Diagnostic progression: the role-checker-only focused run passed 187/187. The first
expanded CRC/no-delete run passed 189/190: a unit test detected that replacing an
already-owned method without explicit descriptors preserves writability. The guard
was made explicitly non-writable/non-configurable; final 190/190 passed. No failed
case was skipped or weakened. All diagnostic network traffic was loopback only.

Files changed:

- src/services/nonproductionStorageAcceptance.service.js
- src/services/nonproductionStorageAcceptancePolicy.service.js
- tests/nonproductionStorageAcceptance.test.js
- tests/nonproductionStorageAcceptancePolicy.test.js
- tests/firebaseStorageTransport.test.js
- docs/firebase-storage-phase8h-preparation.md

Focused command from the existing isolated copy, Node 22.14.0:

```powershell
node --test --test-reporter=spec tests/nonproductionStorageAcceptance.test.js tests/nonproductionStorageAcceptanceAuth.test.js tests/nonproductionStorageAcceptancePolicy.test.js tests/firebaseStorageTransport.test.js tests/evidenceStorageConfig.test.js tests/firebaseEvidenceRetrieval.test.js tests/evidenceRetrievalResolver.test.js tests/evidenceWorkflow.test.js tests/evidenceProductionReadiness.test.js tests/storageInitialization.test.js tests/integrationEnvironment.test.js
```

## 5. Required user decisions - no self-approval

- [ ] Accept the named shared-project administrator/impersonation trust boundary
      for this synthetic contract probe only; do not describe it as strict isolation.
- [ ] Confirm a cost/recovery owner (proposed: chuakyla21@gmail.com) and accept the
      95-byte normal / 124-byte abnormal payload, metadata/request/egress costs,
      retained live object until cleanup approval and seven-day post-delete charges.
- [ ] Approve ONE execution with the exact tuple, reviewed code/dependencies and ONE
      recorded prefix. This includes the two save attempts, authorized generation
      reads, missing-object and anonymous probes, not just uploading one file.
- [ ] Approve fresh in-memory keyless authentication under existing safeguards.
      No login, new key, credential edit, token print/save or application activation.
- [ ] Keep retries, second-identity testing and cleanup separately blocked.

Suggested explicit response, if the user agrees:

> I accept the documented shared-project trust exception for the one synthetic
> Phase 8H run, including the existing operator/Firebase Admin privileges. I accept
> the stated bounded payload/operation costs and seven-day soft-delete implications,
> designate [owner], and authorize one run against the exact acceptance bucket and
> acceptance service account. No cleanup, second identity, production activation or
> automatic retry is authorized.

Do not infer this consent from the current preparation request. If any decision is
declined, execution remains blocked; no IAM changes are required or proposed here.

## 6. Copy-ready commands for AFTER explicit approval - NOT RUN

Use a dedicated operator shell, not a production backend process. The previously
verified clean copy contains the tested locked SDKs; no install/login is needed.
Create only a private NON-SECRET run config/manifest folder outside Git. Its prefix
must be recorded for the one authorized run. Reject any changed source snapshot.

```powershell
$repo = Join-Path $env:USERPROFILE 'Desktop/menrobackend'
$acceptanceRoot = Join-Path $env:LOCALAPPDATA 'Temp/menro-storage-phase2-e4bcb0495c8b42229e36b348b9faa90b'
$node = Join-Path $env:APPDATA 'fnm/node-versions/v22.14.0/installation/node.exe'
$adc = Join-Path $env:APPDATA 'gcloud/application_default_credentials.json'
foreach ($p in @($acceptanceRoot,$node,$adc)) {
  if (!(Test-Path -LiteralPath $p)) { throw 'Approved runtime or ADC missing; stop.' }
}
foreach ($p in @('package.json','package-lock.json','scripts/acceptNonproductionEvidenceStorage.js',
  'src/services/nonproductionStorageAcceptance.service.js','src/services/nonproductionStorageAcceptanceAuth.service.js',
  'src/services/nonproductionStorageAcceptancePolicy.service.js')) {
  if ((Get-FileHash -LiteralPath (Join-Path $repo $p)).Hash -ne
      (Get-FileHash -LiteralPath (Join-Path $acceptanceRoot $p)).Hash) { throw 'Snapshot changed; repeat offline verification.' }
}
$blocked = @('FIREBASE_CONFIG','GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_PRIVATE_KEY','FIREBASE_CLIENT_EMAIL',
  'FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','STORAGE_EMULATOR_HOST',
  'MENRO_INTEGRATION_TEST','EVIDENCE_CLOUD_WORKFLOW_ENABLED','EVIDENCE_CLOUD_READ_ENABLED',
  'MENRO_HISTORICAL_MIGRATION','FIREBASE_STORAGE_BUCKET','MENRO_GCS_ACCEPTANCE_EXECUTE')
if (@($blocked | Where-Object { Test-Path "Env:$_" }).Count) { throw 'Use a fresh dedicated shell; do not edit application config.' }
$env:NODE_ENV='test'
$env:MENRO_GCS_ACCEPTANCE_ENV='same-project-test-bucket'
$env:EVIDENCE_STORAGE_PROVIDER='local'
Set-Location -LiteralPath $acceptanceRoot
$runId = [guid]::NewGuid().ToString().ToLowerInvariant()
$runFolder = Join-Path $env:LOCALAPPDATA "MENRO/GcsAcceptance/$runId"
New-Item -ItemType Directory -Path $runFolder -ErrorAction Stop | Out-Null
$config = Join-Path $runFolder 'acceptance.json'
@{ projectId='menrosystem-ddfac'; bucket='menro-gcs-acceptance-20261021-6f8c2d91';
   serviceAccountEmail='menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com';
   prefix="menro-acceptance/$runId/" } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding ascii
# Reuse the unchanged CLI. Exclude inherited SDK DEBUG only inside this Node child:
$runner = @'
delete process.env.DEBUG;
const {main,safeFailure}=require('./scripts/acceptNonproductionEvidenceStorage');
main().then(r=>console.log(JSON.stringify(r))).catch(e=>{
  console.error(JSON.stringify(safeFailure(e)));process.exitCode=1;
});
'@
# OFFLINE configuration validation, no credential reads or cloud calls:
$runner | & $node - --config $config
if ($LASTEXITCODE -ne 0) { throw 'Config rejected; stop.' }
# STOP. Record this prefix/config and confirm the explicit ONE-RUN approval before continuing.
$env:MENRO_GCS_ACCEPTANCE_EXECUTE='AUTHORIZED_NONPRODUCTION_SYNTHETIC_ONLY'
try {
  $runner | & $node - --config $config --execute-authorized --adc-file $adc
  if ($LASTEXITCODE -ne 0) { throw 'Failed or uncertain: preserve SAME config/prefix. No automatic retry or cleanup.' }
} finally { Remove-Item Env:MENRO_GCS_ACCEPTANCE_EXECUTE -ErrorAction SilentlyContinue }
```

The wrapper only excludes child DEBUG and delegates to the existing CLI; it does
not bypass target/environment/auth guards or alter shared environment/credentials.
Expected initial result: mode acceptance, resumed=false, createOnly/integrity/
anonymousDenied/missingObject true, generation STRING, cleanupAllowed=false.
realServiceVerified stays false until operator IAM/target/provenance attestation.
Retain sanitized result and config in the private manifest; never save tokens/ADC.
An unexpected result or changed privacy/identity requires STOP, not guard relaxation.

## 7. Failure, rollback and separately authorized cleanup

On 401/403/404/integrity/generation/precondition failure or timeout: stop, preserve
the run's exact config/name and sanitized result. Timeout is not proof of no upload.
Do not start another prefix, clear ledgers/quotas, silently choose local evidence,
retry automatically or delete an uncertain object. A future recovery decision may
authorize the SAME config/prefix only after reconciling what happened.

No application rollback is needed: this standalone run never switches production
provider, changes Firestore records, links evidence or replaces local uploads.
Rollback of the TEST means end the child process, remove its execution admission
marker and leave existing production/local state unchanged. Keep any test object
private pending a separate cleanup decision. Do not change IAM, bucket retention,
historical references or global environment to make a failing test appear successful.
Actual deployment rollback remains the Phase 8B read-preserving procedure, outside
this synthetic test and still subject to separate production acceptance.

Cleanup procedure, NOT authorized now:

1. Approve only the captured test bucket/prefix/synthetic.png, synthetic marker,
   expected hash and exact STRING generation; verify no business/ledger references.
2. Inspect only that owned object under cleanup approval. On ownership/generation
   mismatch or uncertainty, stop. Do not list a bucket to find candidates.
3. Perform one generation-conditioned deletion using the reviewed exact-object
   pattern in Phase 8D-8E. Never use wildcards, recursive/all-version deletes or
   lifecycle changes; missing.png was never created and must not be deleted.
4. Record that soft-deleted bytes may persist/be charged for seven days. Do not
   restore, repeatedly delete or alter retention in an attempt to erase them early.

Second-identity testing remains disabled: no principal or live executor is approved.
Neither the one-run exception nor later cleanup grants that authority.

## Final disposition

**BLOCKED for execution solely pending explicit user decisions/authorization above.**
Conditional technical GO for ONE non-sensitive contract run is defensible without
changing production IAM. No recommendation to remove roles is made. If strict
administrator isolation is required, no exception applies and a separately scoped
isolation design is needed. Production activation, migration and ordinary MENRO
workflows remain untouched and unapproved. Stop before the live synthetic test.
