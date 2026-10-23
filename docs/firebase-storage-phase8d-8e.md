# Phase 8D-8E - keyless acceptance readiness and security hardening

Latest consolidated preflight: [Phase 8F](firebase-storage-phase8f.md). It verifies
local CLI/ADC metadata and resolves the two date-dependent test fixtures using
test-scoped clocks. Counts below remain historical; production and live operations
are still not authorized by either report.

21 October 2026. **Offline preparation completed; live acceptance and production
activation remain BLOCKED pending the manual checks/approvals below.** This is the
consolidated Phase 8D and 8E report, superseding Phase 8C's key-only requirement.
No real GCS/Firebase/Render requests, IAM/credential/environment changes, dependency
installation, migration, original-file changes, frontend changes or Git writes.

## Implemented boundary

The standalone acceptance CLI now supports `--adc-file PATH` in addition to the
previous explicit key mode. It does NOT auto-discover ADC or use metadata servers,
connected plugins, application credentials or GOOGLE_APPLICATION_CREDENTIALS.
Only a deliberately supplied local Google ADC JSON file is read, AFTER exact target
validation AND both execution gates. Config-only/default invocations do not read
credentials, import Google SDKs, acquire tokens or construct a cloud transport.

Accepted ADC forms: authorized_user, or impersonated_service_account with an
authorized_user source and the exact approved IAM Credentials URL. Both are rebuilt
as explicit UserRefreshClient -> Impersonated clients for ONLY:

| Setting | Pinned value |
| --- | --- |
| Project | menrosystem-ddfac |
| Bucket | menro-gcs-acceptance-20261021-6f8c2d91 |
| Effective service account | menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com |
| Bucket location/class | asia-southeast1 / STANDARD |
| Object | menro-acceptance/<fresh lowercase UUID>/synthetic.png |
| Impersonation endpoint | https://iamcredentials.googleapis.com |
| Requested token lifetime | 300 seconds |
| Token scopes | devstorage.read_write and userinfo.email (full Google URLs in code) |

No delegates, external-account executables, service-account keys in ADC mode,
arbitrary credential endpoints/universes, mismatched quota projects or unknown
credential options. A Google ADC refresh token is STILL a secret, although it is
not a downloaded service-account private key. Protect its ACLs and never commit,
print or paste it. File existence/authentication was not checked on this machine.

Before ANY GCS operation, tokeninfo over Google's fixed HTTPS endpoint verifies
the minted token's exact email, verified-email flag, expiry and required scopes.
Missing/wrong/expired tokens fail closed. Storage receives ONLY the introspected
access token, not the user refresh token or impersonation source. That token cannot
auto-refresh; expiry requires a separately authorized same-prefix rerun. No fallback
to a user token, default bucket or latest generation. OAuth scopes are not IAM grants.
The auth library is resolved from the installed Storage dependency; no package change.

Source-principal identity is NOT inferred from an untrusted ADC account string.
Effective identity is verified by Google only during a future authorized live run.
The caller allowed to impersonate must be independently reviewed in IAM. Unit tests
mock OAuth/IAM/tokeninfo and do not constitute live proof of that identity.

## Security probes, errors and cleanup

- Bucket metadata must match exact name/location/class, uniform bucket-level access
  enabled and public access prevention explicitly enforced. Inherited-only PAP is
  intentionally not accepted. Project ownership/projectNumber needs separate operator
  verification against the approved project; Storage's projectId option alone is
  NOT proof of bucket ownership. No Resource Manager call was added to the harness.
- One fixed never-written `.../missing.png` metadata probe must return 404 before
  uploading; 200/401/403/500/unknown fail. Only test-prefix names are used.
- Original create-only/CRC32C, different-byte collision requiring 412, exact uint64
  generation strings, response-generation equality, SHA-256/size/type/private metadata
  and anonymous denial checks remain. A 403 is not substituted for a collision 412.
- Distinct safe codes identify malformed/missing ADC, incorrect effective identity,
  invalid token/credentials, impersonation versus tokeninfo denial, bucket metadata
  permission denial, missing bucket, bucket identity/config/privacy failure and
  unavailable verification. The CLI never prints SDK errors, credential paths,
  token contents, stack traces or arbitrary provider diagnostics.
- A pure offline IAM snapshot reviewer detects public bindings, non-bucket inherited
  grants to the test SA, unexpected roles, group/domain/principalSet membership,
  conditions and missing/overbroad metadata roles. Object User's excess update/delete/
  list capabilities are flagged, not silently removed. Snapshots are operator claims,
  not complete IAM analysis: result ALWAYS says manual review required/liveVerified
  false/complete false. No source caller, group membership or deny/conditional policy
  can be proven safe from these projections alone.
- Second-identity denial planning defaults to NO approved additional identity. Pure
  validation pins the same project/bucket/prefix/name/exact generation, rejects the
  primary identity and requires a separately approved exact second identity. There
  is no live second-identity CLI executor and no widened primary allowlist. Later
  approval must identify the principal and permit ONLY one metadata probe of the
  known synthetic generation, expecting Storage 403. An impersonation failure does
  not count as Storage denial. Anonymous 401/403 is a separate, already prepared test.
- Cleanup remains DISABLED: no deletion, listing, recursive traversal or automatic
  lifecycle changes in the harness. Preserve an operator manifest with exact tuple,
  prefix, object name, generation, SHA-256, synthetic marker and run authorization.
  No cleanup of missing.png (never created), unknown names or any historical object.

One normal probe is at most nine explicit Storage operations: bucket metadata,
missing-object metadata, two saves (second must fail), two metadata and two bounded
media reads, one anonymous probe. The fixed tiny PNG is the only successful object.
SDK Storage automatic retries remain off; OAuth/IAM libraries can have their own
bounded internal retries, so this is NOT an exact total/billing guarantee. No loops,
no durable global spend cap and no migration/participant quota bypass: harness is
a separate bounded contract probe with no Firestore client. Approve ONE prefix/run,
cost owner and retention/cleanup plan; uncertain response requires SAME prefix.
Shared project billing, egress, soft-delete/retained versions and repeated runs can
cost money. Budgets/alerts are not hard spend limits. No billing settings were read.

## Required IAM configuration - manual, NOT APPLIED

Keep the user-approved `roles/storage.objectUser` binding scoped ONLY to the
acceptance bucket. Do not grant it on the project. It has more capabilities than the
probe needs; do not use those capabilities to bypass preconditions or delete objects.

The **minimum additional bucket permission is storage.buckets.get**. Object User
does not include it. Safest addition: custom role with exactly that permission,
DEFINED in this project but BOUND only to the acceptance bucket and test SA.

Google Cloud Console (future explicit operator approval required):

1. Select menrosystem-ddfac; IAM & Admin -> Roles -> Create role.
   ID `menroAcceptanceBucketMetadata`; stage GA; add ONLY `storage.buckets.get`.
2. Cloud Storage -> Buckets -> exact acceptance bucket -> Permissions -> Grant
   access. Principal is the exact acceptance SA; select that custom role. Verify
   this is a bucket grant, not project IAM. Leave existing production bindings alone.
3. IAM & Admin -> Service Accounts -> exact acceptance SA -> Permissions.
   Give ONLY the named approved operator authority to mint access tokens ON THIS
   SA. Minimum permission is `iam.serviceAccounts.getAccessToken`; a separately
   defined custom `menroAcceptanceTokenMinter` role with only that permission is
   narrower than Service Account Token Creator. Bind at service-account scope.
   Token Creator is an alternative only with separate approval of its signing/ID
   token powers; never grant it project-wide. No service-account key creation.
4. Verify IAM Credentials API enabled; enablement is a project mutation requiring
   separate approval. Check org restrictions, deny policies and conditional bindings.
5. Review project/folder/org IAM, groups and impersonation paths for both operator
   and test SA. Broad existing grants are a blocker, not proof that setup is done.

Equivalent FUTURE setup commands, NOT run/authorized by this document:

```powershell
gcloud iam roles create menroAcceptanceBucketMetadata --project=menrosystem-ddfac --title="MENRO acceptance bucket metadata" --permissions=storage.buckets.get --stage=GA
gcloud storage buckets add-iam-policy-binding gs://menro-gcs-acceptance-20261021-6f8c2d91 --member=serviceAccount:menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com --role=projects/menrosystem-ddfac/roles/menroAcceptanceBucketMetadata --project=menrosystem-ddfac
gcloud iam roles create menroAcceptanceTokenMinter --project=menrosystem-ddfac --title="MENRO acceptance token minter" --permissions=iam.serviceAccounts.getAccessToken --stage=GA
# Replace APPROVED_OPERATOR only after principal approval:
gcloud iam service-accounts add-iam-policy-binding menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com --member=user:APPROVED_OPERATOR --role=projects/menrosystem-ddfac/roles/menroAcceptanceTokenMinter --project=menrosystem-ddfac
```

Do not overwrite whole IAM policies. Operators need their own separately approved
permissions to define roles/bind policies; those are NOT harness permissions.
Read-only auditors may need storage.buckets.getIamPolicy, project/ancestor IAM read,
role-definition read and service-account IAM read; do not add them to the test SA
for convenience. Narrow production application IAM remains a separate later decision.

## Read-only live verification plan - NOT RUN

After separate read-only inspection approval, a trusted auditor (not broadened test
SA) may run these. Keep output privately, do not paste project policies or credentials.
No object listing/download, Firestore query or production-bucket probe is needed.

```powershell
gcloud projects describe menrosystem-ddfac --format="json(projectId,projectNumber)"
gcloud storage buckets describe gs://menro-gcs-acceptance-20261021-6f8c2d91 --project=menrosystem-ddfac --format=json
gcloud storage buckets get-iam-policy gs://menro-gcs-acceptance-20261021-6f8c2d91 --project=menrosystem-ddfac --format=json
gcloud projects get-iam-policy menrosystem-ddfac --format=json
gcloud projects get-ancestors menrosystem-ddfac --format=json
gcloud iam service-accounts describe menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com --project=menrosystem-ddfac --format=json
gcloud iam service-accounts get-iam-policy menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com --project=menrosystem-ddfac --format=json
gcloud iam roles describe menroAcceptanceBucketMetadata --project=menrosystem-ddfac --format=json
gcloud iam roles describe menroAcceptanceTokenMinter --project=menrosystem-ddfac --format=json
# ONLY returned ancestor IDs, with explicit inspection authority:
gcloud resource-manager folders get-iam-policy APPROVED_FOLDER_ID --format=json
gcloud organizations get-iam-policy APPROVED_ORGANIZATION_ID --format=json
```

Confirm bucket name/project number, region/class, enforced PAP, uniform access,
retention/version/soft-delete policies and actual test-SA binding. Bucket CLI IAM
does NOT include inherited project permissions; inspect every ancestor, groups,
conditions, deny policies and all principals able to impersonate the SA. Missing
visibility means BLOCKED. No production object access is necessary to check policy.
If gcloud's default formatting normalizes fields, use full JSON/Console; the harness
validates raw GCS JSON fields. Local gcloud is not on PATH; command execution/version
compatibility is NOT VERIFIED here. Do not install it as part of this phase.

## Exact future keyless setup and acceptance commands - NOT RUN

Use a dedicated private operator session/profile. Do not replace active shared ADC
or change another process's environment. Login writes local OAuth credentials and
contacts Google: requires separate explicit authorization, despite being keyless.

```powershell
gcloud auth application-default login --impersonate-service-account=menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com --project=menrosystem-ddfac
```

Use the resulting approved local ADC path (normally
`$env:APPDATA/gcloud/application_default_credentials.json`; custom gcloud profiles
can differ). A pre-existing authorized_user ADC can also be explicitly selected:
the adapter always impersonates the same pinned SA rather than accessing GCS as
that user. Do not create/edit a JSON credential by hand. Unrecognized ADC layouts,
different quota projects or source types fail closed and require review, not bypass.
ADC file must stay outside the repository. No need to set GOOGLE_APPLICATION_CREDENTIALS;
it remains forbidden. API scopes do not confer broad project IAM privileges.

Keep Phase 8C's exact four-field non-secret config and a new recorded lowercase UUID.
Fresh dedicated shell only, no application/ADC selector/DEBUG/emulator/read/write/
migration environment flags. Set these process-local markers:

```powershell
$env:NODE_ENV='test'
$env:MENRO_GCS_ACCEPTANCE_ENV='same-project-test-bucket'
$env:EVIDENCE_STORAGE_PROVIDER='local'
# OFFLINE config-only validation; no credentials are read:
node scripts/acceptNonproductionEvidenceStorage.js --config C:/private/menro-gcs-acceptance.json
# LIVE, only after all checklist gates and separate execution approval:
$env:MENRO_GCS_ACCEPTANCE_EXECUTE='AUTHORIZED_NONPRODUCTION_SYNTHETIC_ONLY'
node scripts/acceptNonproductionEvidenceStorage.js --config C:/private/menro-gcs-acceptance.json --execute-authorized --adc-file "$env:APPDATA/gcloud/application_default_credentials.json"
```

The old `--credentials` mode is retained for compatibility, not recommended or
authorized for this phase. No token, key, signed URL or ADC contents go in reports.
Successful transport assertions STILL return realServiceVerified=false: collect
sanitized outcome and operator IAM/provenance attestation before accepting live proof.

Second-identity follow-up: obtain exact principal/cost/one-object approval first;
verify its token identity separately, then perform ONLY an exact-generation metadata
request to the known synthetic object, expecting a Storage 403. No second identity
has been approved, created, configured or used; current CLI cannot run that probe.

Cleanup is separate approval, after verifying ownership/hash/generation and absence
of business references. Example future single-object conditional deletion ONLY:

```powershell
# Replace recorded UUID and GENERATION only after verifying manifest and approval:
gcloud storage rm gs://menro-gcs-acceptance-20261021-6f8c2d91/menro-acceptance/RECORDED_UUID/synthetic.png --if-generation-match=RECORDED_GENERATION --impersonate-service-account=menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com --project=menrosystem-ddfac
```

Never add recursive/all-versions/wildcard flags. A mismatch must stop cleanup.
Soft-delete/retention can preserve costs after a successful conditional deletion.

## Compatibility, readiness and staged rollout

Phase 8B runtime files and business flows are unchanged. Saved reference dispatch,
record authorization, local/root-only planting, guest contribution context, early/
official monitoring and revision isolation remain in existing paths. Offline
retrieval/resolver/workflow/config tests verify local uploads plus enabled cloud
reads and no silent fallback. This phase does not repeat authenticated API/emulator
acceptance; prior demo results are historical, not real-service proof.

| Area | Current evidence | Outstanding requirement |
| --- | --- | --- |
| Keyless adapter/effective identity | OFFLINE VERIFIED | Actual ADC/IAM/tokeninfo with approved principal |
| Exact target/prod denial/default disablement | OFFLINE VERIFIED | Operator project-number/ownership attestation |
| Privacy/region/class/IAM snapshot validation | OFFLINE VERIFIED | Complete live IAM/ancestor/group/deny review |
| Create-only/generation/hash/missing/anonymous probes | OFFLINE VERIFIED | Separately authorized real GCS execution |
| Second identity | PREPARED / BLOCKED | Named principal, authentication, exact-object approval/executor |
| Cleanup | DISABLED / MANUAL PLAN | Captured synthetic manifest and separate delete approval |
| Read-preserving rollback | OFFLINE VERIFIED; prior demo result | Real-runtime mixed/revision and authorization acceptance |
| Production reads/writes | BLOCKED BY SOURCE | Separate code-target/config/acceptance/activation approvals |
| Quotas/ledgers/migration | EXISTING DEMO GUARDS UNCHANGED | Separate production accounting/source policy and acceptance |
| Render evidence persistence | NOT VERIFIED | Approved deployed path/mount/disk and Linux runtime inspection |
| Historical references/backups | NOT VERIFIED | Complete authorized source inventory and isolated restore proof |
| Production readiness | BLOCKED | All above plus deployment/rollout authorization |

Staging order:

1. Authorize read-only target/IAM inspection; resolve findings and separately approve
   narrowly scoped grants, credential login and one-run billing/retention custody.
2. Review this offline change and authorize ONE synthetic real-GCS probe. Resolve any
   real 412/generation/privacy failure without weakening guards. Reuse prefix on
   uncertain outcomes; no automatic migration or cleanup.
3. Separately authorize named second-identity denial and application-level authorized
   evidence retrieval tests. Keep existing Auth/Firestore production data untouched.
4. Complete approved Render persistence inspection and historical evidence inventory:
   exact deployed CWD/uploads mount, durable source bytes, photos[] and root aliases,
   guest contributions, observation/current/revision references, missing files and
   ambiguous/duplicate references. Do not infer recovery from URL existence.
5. Before any production change, encrypted consistent record+byte backups and an
   isolated restore must preserve generations, revisions, audit and newer writes.
   Review IAM/Rules, quota ledgers, billing, native/temp capacity and incident owner.
6. Only later authorize production-target gates/canary activation. Rollback requires
   a read-compatible release: disable NEW cloud writes, retain authorized saved-
   reference reads and original local bytes, drain/reconcile in-flight operations,
   never erase ledgers or silently fall back. Phase 7C/8A/8B runbooks still apply.

## Tests and files

Existing clean-lockfile temporary install is reused with Node 22.14.0; package/lock hashes
match the repository. No dependency install or replacement of repository node_modules.

| Final run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Focused security/rollback/isolation (10 files) | 181 | 0 | 0 |
| Full root backend regression (470 cases) | 468 | 2 | 0 |

Counts overlap; do not add as unique tests. The two final failures are the existing
connectedWorkflow.test.js:124 and :211 hardcoded past-release SCHEDULE_STALE cases,
not new harness failures. All 99 harness/auth/policy cases pass within these runs.
Seven changed JavaScript files pass syntax checks; all 11 scoped files pass explicit
whitespace checks and git diff --check passes (existing LF/CRLF warnings only).
Default CLI returns zero network requests and EXECUTION_AUTHORIZATION_REQUIRED.
Staging is empty; branch remains fix/validated-survival-analytics.

```powershell
node --test --test-reporter=spec tests/nonproductionStorageAcceptance.test.js tests/nonproductionStorageAcceptanceAuth.test.js tests/nonproductionStorageAcceptancePolicy.test.js tests/evidenceStorageConfig.test.js tests/firebaseEvidenceRetrieval.test.js tests/evidenceRetrievalResolver.test.js tests/evidenceWorkflow.test.js tests/evidenceProductionReadiness.test.js tests/storageInitialization.test.js tests/integrationEnvironment.test.js
node --test --test-reporter=spec tests/*.test.js
git diff --check
```

Initial diagnostic root run used an incomplete temporary source snapshot and exposed
missing-module errors; it is not accepted regression evidence. The new CLI test also
needed a wholly synthetic child-test environment rather than inherited selectors;
no runtime isolation guard was relaxed. After syncing the source snapshot, root
regressions returned only the known SCHEDULE_STALE fixtures. The constructor test
also caught the auth library ignoring a zero refresh-threshold option; 1ms preserves
the pinned short-lived token. Its Storage wrapper assertion was corrected to check
the cached client rather than assuming the wrapper object itself was that client.
All diagnostic failures were offline; none performed cloud acceptance.

No emulator suites run: the changed code is standalone only and mocks cover it.
No shared service stopped/restarted, no migration quota consumed/reset/bypassed.
Known native Storage Emulator ifGenerationMatch=0 failure remains visible and
unchanged; real GCS must prove that contract, not inherit an emulator PASS claim.
The two hardcoded past-release SCHEDULE_STALE regressions are not fixed or skipped.

Exact changed files:

- src/services/nonproductionStorageAcceptance.service.js
- src/services/nonproductionStorageAcceptanceAuth.service.js (new)
- src/services/nonproductionStorageAcceptancePolicy.service.js (new)
- scripts/acceptNonproductionEvidenceStorage.js
- tests/nonproductionStorageAcceptance.test.js
- tests/nonproductionStorageAcceptanceAuth.test.js (new)
- tests/nonproductionStorageAcceptancePolicy.test.js (new)
- docs/firebase-storage-phase8d-8e.md (new)
- docs/firebase-storage-phase7b.md
- docs/firebase-storage-phase8a.md
- docs/firebase-storage-phase8c.md

No runtime
evidence/config/Firebase/business modules, frontend, dependencies or real .env edits.

References consulted (public documentation, not customer cloud data):
[impersonated ADC](https://docs.cloud.google.com/docs/authentication/use-service-account-impersonation),
[tokeninfo identity/scopes](https://docs.cloud.google.com/docs/authentication/token-types),
[GCS roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles),
[inherited IAM visibility](https://docs.cloud.google.com/storage/docs/access-control/iam),
[generation preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions),
[conditional cleanup flag](https://docs.cloud.google.com/sdk/gcloud/reference/storage/rm).

**Stop before live requests, login, IAM changes, production activation or deployment.**
