# Phase 8F - consolidated GCS preflight and acceptance readiness

21 October 2026. **READY FOR APPROVAL of staged live verification, not permission to
run it.** The offline implementation has no remaining confirmed blocker. Live
acceptance is BLOCKED until the separate security/cost/execution approvals below;
production activation remains BLOCKED. This report supersedes earlier local-setup
and SCHEDULE_STALE fixture limitations, not their historical results.

No live Google Cloud/GCS/Firebase/Render request, credential login or modification,
real token generation/output, upload, deletion, migration, scheduler, dependency
installation, frontend change, deployment or Git write occurred. ADC was inspected
ONLY using file metadata; its contents were not read or validated against Google.

## Local evidence versus reported cloud settings

| Check | Status | Actual evidence / limit |
| --- | --- | --- |
| Dedicated tuple allowlist | PASS | Exact project/bucket/SA frozen in standalone harness |
| SDK installed | PASS | Local SDK VERSION file = 590.0.0; gcloud.cmd exists |
| CLI available on this process PATH | BLOCKED | Get-Command gcloud found nothing; use explicit verified path below, no installation needed |
| Local configured project/account | PASS | Active default INI core.project = menrosystem-ddfac; core.account = chuakyla21@gmail.com |
| Local selector overrides | PASS | No CLOUDSDK_CONFIG/ACTIVE_CONFIG_NAME/CORE_PROJECT/CORE_ACCOUNT/AUTH_IMPERSONATE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS override present |
| Standard Windows ADC file exists | PASS | C:/Users/chuak/AppData/Roaming/gcloud/application_default_credentials.json; 402 bytes; last-write 21 October 2026 12:40:59 local |
| ADC credential validity/operator identity | NOT VERIFIED | Existence and CLI account do not prove refresh validity, ADC ownership or effective identity |
| Bucket Object User + custom metadata grant | NOT VERIFIED | User-confirmed setup; no local exported policy/role definition or live verification available |
| Operator Token Creator on acceptance SA | NOT VERIFIED | User-confirmed setup; effective binding, conditions and inheritance not inspected |
| Actual bucket project number/region/class | NOT VERIFIED | Approved names/asia-southeast1/Standard checked by code; live ownership/config not inspected |
| Actual PAP/uniform access | NOT VERIFIED | Harness requires enforced PAP and uniform access; live values unknown |
| Retention/soft delete/versioning/billing | NOT VERIFIED | Requires approved Console/API inspection and cost owner acceptance |
| Effective project/org/group/impersonation isolation | NOT VERIFIED | Offline policy checks cannot establish complete effective IAM |
| Clean isolated acceptance runtime | PASS | Node 22.14.0; locked Admin 14.5.0, Storage 8.4.0, auth library 11.3.1; package/lock hashes match repository |
| Repository node_modules as acceptance runtime | BLOCKED | Stale Admin 11.11.1, Storage 6.12.0, auth library 8.9.0; do NOT use for this live run |
| Default disablement/authorization gates | PASS | Default CLI reports zero network requests and execution authorization required |
| Keyless failure/identity/scope/expiry checks | PASS | Fresh synthetic offline tests, not actual token verification |
| Synthetic create-only/integrity/missing/privacy guards | PASS | Mock contracts; real GCS behavior NOT VERIFIED |
| Negative second identity and cleanup execution | BLOCKED | No approved second identity; harness has no cleanup executor |
| Read-preserving rollback/local/revision compatibility | PASS | Current source and fresh offline regression; previous emulator results are historical |
| Migration quota/isolation safeguards | PASS | Unchanged, no emulator/migration operation performed; current counter not queried |
| Production local provider | NOT VERIFIED | User confirms local; default/source guards verified, deployed environment not inspected |
| Production cloud activation | BLOCKED | Existing application gates remain demo-only; acceptance allowlist cannot enable business Storage |
| Render evidence durability/backups/reconciliation | NOT VERIFIED | No deployed path/disk/source inventory or isolated restore inspected |

No gcloud executable was invoked: version/account/project came from non-secret
local installation/configuration metadata, avoiding update checks/credential use.
No login database, credential contents, token files, IAM cache or private object was
read. This also means current login validity and ADC format remain NOT VERIFIED.

## Review of existing harness - reused, not rebuilt

`nonproductionStorageAcceptance.service.js`, Auth and Policy siblings and the CLI
were inspected. No runtime change was necessary:

- Exact tuple remains project `menrosystem-ddfac`, bucket
  `menro-gcs-acceptance-20261021-6f8c2d91`, and service account
  `menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com`. Both production
  bucket names and other same-project identities fail even with permissive injected
  test policies. No Firestore client or application startup import in this harness.
- ADC mode accepts only the reviewed explicit local ADC formats, sanitizes source
  fields, impersonates ONLY the approved SA with no delegates and a requested
  300-second lifetime. It verifies exact effective email, verified-email flag,
  required devstorage.read_write + userinfo.email scopes and >=30 seconds remaining
  before Storage access. Storage receives only that introspected, non-refreshable
  token. No ambient ADC, metadata-server, user-token or alternate-bucket fallback.
- Config/default mode does not read credentials or initialize auth/Storage. Execution
  needs both CLI --execute-authorized and its separate exact environment marker.
  Source/operator claims are not accepted as proof of effective Google identity.
- One prefix-scoped tiny PNG, no user image input; first save uses ifGenerationMatch=0,
  second different-byte create must fail 412. Both metadata/generation-specific media
  reads verify exact uint64 strings, hash/size/type/privacy and unchanged generation.
  The never-created missing.png must return 404; denial is not treated as absence.
- Bucket identity/region/class, explicit enforced PAP and uniform access are checked
  before upload. Anonymous access must return 401/403. Metadata/media/integrity errors
  cannot silently pass or fall back to local evidence. CLI errors remain sanitized.
- At most nine explicit Storage operations for a normal probe, fixed bounded media,
  timeouts and Storage automatic retry off. Authentication libraries may perform
  their own bounded retries. This is not a hard billing cap or global run ledger.
- Negative second-identity planning defaults to no approved identities; there is no
  live second-identity CLI path. No listing, delete method, wildcard cleanup or real
  evidence selector. Cleanup stays separate, exact manifest/generation-bound.
- Phase 8B persisted-reference dispatch and record authorization remain unchanged;
  upload-disabled cloud reads require the existing explicit demo read gate. Legacy
  local/root planting, contribution context, early/official observations and
  revisions remain in their existing paths. Production cloud reads/writes remain
  blocked. No migration quota was reset, read, charged or bypassed.

## Confirmed corrections and fresh tests

Two original connectedWorkflow success cases seeded release 2026-10-19 / planting
2026-10-20 but approval uses the actual Manila date. On 21 October the existing
`validateFuturePlantingSchedule` correctly rejects them with SCHEDULE_STALE.
Reproduced BEFORE correction in the complete isolated source snapshot: 24 cases,
22 passed / 2 failed. These are expired success fixtures, not a broken business rule.

Only those two tests now use TestContext-owned Date mocks at
2026-10-18T00:00:00Z, automatically restored after each test. Original dates,
assertions, approval/inventory/ownership behavior and expired-schedule rejection
remain. No production scheduling function was changed, no assertion skipped and no
moving far-future dates substituted. Node 22 emits its existing experimental
MockTimers API warning; this is test-tooling risk, not a production defect.

Four additional offline auth regressions prove missing/null/empty/oversized minted
token results fail BEFORE tokeninfo or Storage and never create a pinned client.
Existing wrong identity, invalid/unauthorized ADC, expired token, insufficient scope,
credential endpoint substitution and tokeninfo-denial cases also pass.

| Final executed suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Focused security/auth/isolation/rollback, 10 files | 185 | 0 | 0 |
| Connected workflows + schedule validation, 2 files | 30 | 0 | 0 |
| Full backend root regression | 474 | 0 | 0 |

Both modified JavaScript tests pass syntax checks; all four Phase 8F files pass
explicit whitespace checks and git diff --check passes (existing LF/CRLF warnings
only). Nothing staged; branch remains fix/validated-survival-analytics. ADC size and
last-write metadata were unchanged at final inspection.

Counts overlap, not additive. 103 harness/auth/policy cases are included in the full
and focused suites. Tests ran in the existing clean-lockfile temporary copy using
Node 22.14.0, in-memory mocks, synthetic files and loopback HTTP stubs only. Repository
node_modules was not replaced. The first diagnostic copy lacked recordNumber.util;
after syncing source/data/root tests/helpers, the unmodified failures reproduced as
above. That startup error is not accepted product evidence. No .env in the test copy.
No authenticated emulator acceptance was rerun: changed code is test-only, the shared
migration quota remains untouched and the known native Storage Emulator condition-zero
failure is unchanged/NOT VERIFIED afresh. Offline green tests do not resolve it or
prove real GCS generation preconditions. No browser or Linux acceptance claimed.

Commands executed from the clean copy (no gcloud invocation):

```powershell
node --test --test-reporter=spec tests/nonproductionStorageAcceptance.test.js tests/nonproductionStorageAcceptanceAuth.test.js tests/nonproductionStorageAcceptancePolicy.test.js tests/evidenceStorageConfig.test.js tests/firebaseEvidenceRetrieval.test.js tests/evidenceRetrievalResolver.test.js tests/evidenceWorkflow.test.js tests/evidenceProductionReadiness.test.js tests/storageInitialization.test.js tests/integrationEnvironment.test.js
node --test --test-reporter=spec tests/connectedWorkflow.test.js tests/seedlingRequestSchedule.test.js
node --test --test-reporter=spec tests/*.test.js
```

Exact changes in Phase 8F:

1. tests/connectedWorkflow.test.js - scoped clocks for the two success fixtures.
2. tests/nonproductionStorageAcceptanceAuth.test.js - four invalid-token regressions.
3. docs/firebase-storage-phase8f.md - this consolidated report and approval/runbook.
4. docs/firebase-storage-phase8d-8e.md - short superseding link, historical counts kept.

No harness/service/API/config/dependency/environment/business/frontend source change.

## IAM/privacy/cost checklist - settings still need live confirmation

User-reported grants meet the intended functional permissions IF their definitions
and scopes are as stated: Object User only on the acceptance bucket; custom metadata
role has ONLY storage.buckets.get, likewise bucket-bound; Token Creator for
chuakyla21@gmail.com only on the acceptance SA. Object User includes delete/update/
list beyond this harness's needs; Token Creator includes signing/ID-token authority
beyond access-token minting. These are reported approved grants, NOT evidence to
broaden or automatically replace them. No IAM modifications are necessary in this
phase. The actual custom role ID/definition has not been independently verified.

Before accepting a live run, a trusted auditor must confirm:

- Bucket projectNumber equals menrosystem-ddfac's numeric project number; exact
  bucket, asia-southeast1 and Standard, uniform access enabled and PAP enforced.
- Effective IAM: bucket plus project, EVERY folder/org ancestor, group/domain/
  principalSet memberships, conditions/deny policies and who can impersonate BOTH
  the caller and test SA. Bucket CLI policy alone excludes inherited project roles.
  No unintended production-bucket or Firestore access path. Do not test this by
  touching production data. Missing visibility must remain NOT VERIFIED/BLOCKED.
- IAM Credentials API availability and the reported exact-SA operator binding.
  CLI account metadata is not proof of the ADC caller. Tokeninfo checks effective
  SA only during future authorized execution; current ADC validity is unknown.
- Retention/holds, soft-delete duration, versioning and lifecycle do not cause an
  unapproved cleanup or storage-cost commitment. No lifecycle auto-deletion added.
- Billing account/cost owner, egress/request charges, one-run allowance and alerts.
  Shared project budgets are not hard caps. Approve one prefix/one run; retry needs
  the SAME prefix and a separate explicit retry decision after uncertain outcomes.
- A private manifest and secure ADC ACL/custody, with no credentials/tokens in Git,
  reports or console output. No new login, key or IAM setup is authorized here.

## Future Stage A - read-only live preflight, NOT EXECUTED

Requires separate authorization for project/bucket/IAM metadata access. No token
print/generation command is supplied; gcloud may itself authenticate/refresh tokens
when these future live commands are run. Use the existing login, not a new login.
Run in a private operator session; retain IAM outputs privately, not pasted into
public logs. Absolute CLI path avoids this process's stale PATH:

```powershell
$gcloud = Join-Path $env:LOCALAPPDATA 'Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd'
if (!(Test-Path -LiteralPath $gcloud)) { throw 'Approved gcloud executable missing.' }
& $gcloud projects describe menrosystem-ddfac --account=chuakyla21@gmail.com --format="json(projectId,projectNumber)"
& $gcloud storage buckets describe gs://menro-gcs-acceptance-20261021-6f8c2d91 --project=menrosystem-ddfac --account=chuakyla21@gmail.com --format=json
& $gcloud storage buckets get-iam-policy gs://menro-gcs-acceptance-20261021-6f8c2d91 --project=menrosystem-ddfac --account=chuakyla21@gmail.com --format=json
& $gcloud projects get-iam-policy menrosystem-ddfac --account=chuakyla21@gmail.com --format=json
& $gcloud projects get-ancestors menrosystem-ddfac --account=chuakyla21@gmail.com --format=json
& $gcloud iam service-accounts get-iam-policy menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com --project=menrosystem-ddfac --account=chuakyla21@gmail.com --format=json
```

Use returned custom-role and ancestor IDs for the remaining read-only role and
ancestor policy commands in Phase 8D-8E. Do not guess them or broaden privileges
after a 403. No production bucket/object, Auth, Firestore or Render command is needed.
Expected result: signed-off checklist above, NOT a synthetic upload or IAM change.

## Future Stage B - one bounded synthetic acceptance run, NOT EXECUTED

Prerequisites: Stage A passed/attested; approved unchanged code/runtime snapshot,
ADC format/custody, effective caller and exact-SA impersonation; bucket privacy,
retention/billing reviewed; one-run authorization with assigned prefix/owner.
Do NOT run this block merely because offline tests pass. No login/setup command is
needed; do not print/export access tokens or edit the existing ADC.

Use the TESTED clean copy, not the stale repository node_modules. It already exists;
no installation is authorized. Before approval, compare package/lock and the four
harness source files to the reviewed repository version; if they differ, stop and
rerun offline verification. Fresh dedicated PowerShell session only:

```powershell
$repo = Join-Path $env:USERPROFILE 'Desktop/menrobackend'
$acceptanceRoot = Join-Path $env:LOCALAPPDATA 'Temp/menro-storage-phase2-e4bcb0495c8b42229e36b348b9faa90b'
$node = Join-Path $env:APPDATA 'fnm/node-versions/v22.14.0/installation/node.exe'
$adc = Join-Path $env:APPDATA 'gcloud/application_default_credentials.json'
foreach ($p in @($acceptanceRoot, $node, $adc)) {
  if (!(Test-Path -LiteralPath $p)) { throw 'Approved runtime or ADC missing; stop.' }
}
foreach ($relative in @('package.json','package-lock.json','scripts/acceptNonproductionEvidenceStorage.js',
  'src/services/nonproductionStorageAcceptance.service.js','src/services/nonproductionStorageAcceptanceAuth.service.js',
  'src/services/nonproductionStorageAcceptancePolicy.service.js')) {
  if ((Get-FileHash -LiteralPath (Join-Path $repo $relative)).Hash -ne
      (Get-FileHash -LiteralPath (Join-Path $acceptanceRoot $relative)).Hash) { throw 'Snapshot changed; stop.' }
}
$blocked = @('FIREBASE_CONFIG','GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_PRIVATE_KEY','FIREBASE_CLIENT_EMAIL',
  'FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','STORAGE_EMULATOR_HOST',
  'MENRO_INTEGRATION_TEST','EVIDENCE_CLOUD_WORKFLOW_ENABLED','EVIDENCE_CLOUD_READ_ENABLED',
  'MENRO_HISTORICAL_MIGRATION','FIREBASE_STORAGE_BUCKET','DEBUG','MENRO_GCS_ACCEPTANCE_EXECUTE')
if (@($blocked | Where-Object { Test-Path "Env:$_" }).Count) { throw 'Use a fresh isolated shell; do not clear shared config.' }
$env:NODE_ENV='test'
$env:MENRO_GCS_ACCEPTANCE_ENV='same-project-test-bucket'
$env:EVIDENCE_STORAGE_PROVIDER='local'
Set-Location -LiteralPath $acceptanceRoot
# New config/manifest folder only for this approved run, outside Git; keep it for recovery:
$runId = [guid]::NewGuid().ToString().ToLowerInvariant()
$runFolder = Join-Path $env:LOCALAPPDATA "MENRO/GcsAcceptance/$runId"
New-Item -ItemType Directory -Path $runFolder -ErrorAction Stop | Out-Null
$config = Join-Path $runFolder 'acceptance.json'
@{ projectId='menrosystem-ddfac'; bucket='menro-gcs-acceptance-20261021-6f8c2d91';
   serviceAccountEmail='menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com';
   prefix="menro-acceptance/$runId/" } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding ascii
# Config-only, offline. Expected mode prepare/networkRequests 0; no credentials read:
& $node scripts/acceptNonproductionEvidenceStorage.js --config $config
if ($LASTEXITCODE -ne 0) { throw 'Configuration rejected; stop.' }
# STOP HERE unless the assigned prefix and ONE live run have explicit execution approval.
$env:MENRO_GCS_ACCEPTANCE_EXECUTE='AUTHORIZED_NONPRODUCTION_SYNTHETIC_ONLY'
try {
  & $node scripts/acceptNonproductionEvidenceStorage.js --config $config --execute-authorized --adc-file $adc
  if ($LASTEXITCODE -ne 0) { throw 'Acceptance failed/uncertain; preserve this config and prefix. No automatic retry.' }
} finally { Remove-Item Env:MENRO_GCS_ACCEPTANCE_EXECUTE -ErrorAction SilentlyContinue }
```

Expected successful assertions: mode acceptance; createOnly/integrity/anonymousDenied/
missingObject true; exact generation STRING; cleanupAllowed false. realServiceVerified
intentionally stays false until operator target/IAM/provenance attestation. Capture
only sanitized output plus private run manifest. Failure/timeout is not proof nothing
was uploaded; do not generate another prefix, silently fall back or auto-delete.
This shell's local provider setting does NOT change production configuration.

## Separate approval checklists

**A/B - live preflight and bounded synthetic run**

- [ ] Authorize read-only metadata/IAM inspection; confirm complete isolation checklist.
- [ ] Approve exact reviewed runtime, operator, ADC custody and target tuple.
- [ ] Approve one prefix/run, <=1 tiny successful object, request/egress/retention costs.
- [ ] Assign manifest/recovery owner; explicitly approve actual execution after A passes.
- [ ] Accept that this does not prove MENRO authenticated browser/API production access.

**C - second-identity negative test (still disabled)**

- [ ] Name and separately approve the exact second principal and authentication method.
- [ ] Approve ONLY one exact synthetic object/generation metadata probe; first prove
      that authentication/impersonation succeeded, then require an actual Storage 403.
- [ ] Approve an isolated executor; do not widen the primary tuple allowlist, use
      production evidence or count an impersonation error as Storage authorization proof.

**D - cleanup (still disabled)**

- [ ] Approve exact manifest bucket/name/generation/hash and synthetic ownership.
- [ ] Prove absence of business/ledger/revision references; preserve uncertain objects.
- [ ] Approve single conditional deletion and retained soft-delete/version costs.
      Use only the Phase 8D-8E exact-object generation-conditioned pattern after review;
      no wildcards, recursive flags, all-version deletion or bucket lifecycle changes.

## Final recommendation

**READY FOR APPROVAL** of the staged checks above. Local dependencies are available
in the tested isolated copy, local CLI/account/project/ADC existence is confirmed,
all current offline tests pass and no further application change is justified.

This is NOT unconditional readiness for immediate live uploads or production.
Effective IAM, live bucket privacy/ownership, retention/billing/caller validity and
explicit execution approvals are still required. Missing visibility or an unexpected
setting blocks Stage B. Production activation, Render durability, historical source
inventory/reconciliation and encrypted backup/isolated restore remain separate future
work under Phase 7C/8A/8B runbooks. Do not activate or migrate to close this checklist.
