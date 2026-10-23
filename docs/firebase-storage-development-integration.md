# Consolidated Firebase Storage development integration

Date: 2026-10-23 (Asia/Manila). **BLOCKED — resource approval/setup and separately
authorized real-cloud workflow activation remain outstanding.** The safe local
implementation is complete; no additional implementation phase is proposed.
Nothing in this report authorizes a cloud request or activates a provider.

## Decision and remaining approvals

Do **not** reuse the acceptance bucket or acceptance identity for ongoing application
development. Phase 8H approved one standalone probe, not continuous evidence writes,
business linkage, larger quotas, or permanent development custody. Its existing
95-byte object, generation `1792597882862915`, was not accessed or changed here.
The production bucket `menrosystem-ddfac.firebasestorage.app` is never an allowed
development target.

Proposed exact development tuple (not created, availability/existence NOT VERIFIED):

| Setting | Proposed value |
| --- | --- |
| GCS project | `menrosystem-ddfac` |
| Bucket | `menro-evidence-dev-20261022-a4c8e912` |
| Impersonated identity | `menro-evidence-development@menrosystem-ddfac.iam.gserviceaccount.com` |
| Location / class | `asia-southeast1` / Standard |
| Object namespace | `menro-development/<one stable lowercase UUID>/evidence/v1/...` |
| Auth and Firestore project | **Only `demo-menro-phase2`** |
| Auth / Firestore | `127.0.0.1:9099` / `127.0.0.1:8080` |

Minimum next actions, in order:

1. Approve the proposed development tuple, an ongoing-development shared-project
   trust exception, synthetic test budget, retention, and custody/backup plan.
   If names must change, revise the single server allowlist and its tests first;
   never substitute an arbitrary bucket through environment variables.
2. An authorized administrator manually creates that bucket and identity, verifies
   billing, and supplies the scoped permissions below. No resources were created
   or inspected live during this task.
3. Verify effective IAM/privacy and approve actual local application GCS operations
   separately. Then use the startup and smoke-test procedure below. No repeat of
   the completed Phase 8H acceptance probe is needed or authorized.

### Manual resource requirements — do not execute under this task

In Google Cloud Console, select the exact approved project before every operation.
Create the proposed service account **without project-wide roles**. Create the
dedicated regional bucket with uniform bucket-level access (UBLA) and enforced
public access prevention (PAP). No public principals, download tokens, Firebase
Rules changes, CORS exposure, production bindings, or service-account keys.

Use a custom role containing exactly `storage.buckets.get`,
`storage.objects.create`, and `storage.objects.get`, bound to the development
identity on **this bucket only**. The acceptance identity's Object User role is
not reused; object delete/update/list are unnecessary for application evidence.
Grant the approved operator Service Account Token Creator on **this service
account only**, not the project. Review dependencies before changing any existing
roles; this task recommends no production-role removals.

Verify bucket project number/ownership, location, Standard class, PAP, UBLA,
retention, versioning, soft delete, inherited IAM, and billing in Console before
activation. The runtime checks bucket name/location/class/PAP/UBLA; those checks
are not an attestation of bucket ownership, effective IAM, billing, or retention.

Earlier Phase 8G findings remain relevant but were not refreshed: the operator
has project Owner access; `firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com`
has project-wide Storage Admin/Token Creator and other Firebase roles. A separate
bucket/identity does not remove those inherited access paths. Exact application
allowlists are not a sandbox against a compromised administrator or workstation.
If that shared-project trust is unacceptable, use a separate nonproduction project
instead; that requires an approved allowlist revision, not bypassing these guards.

Costs include object bytes, requests, egress and any retained versions/soft-deleted
bytes. Seven-day soft delete in the acceptance bucket is historical evidence, not
proof of the new bucket's policy. Soft delete does not expire live objects. No
automatic lifecycle deletion or cleanup is implemented/authorized. Begin with one
synthetic actor and a handful of small generated evidence images. Existing quotas
are per actor/day: 50 files and 200 MiB (Asia/Manila); the 1 GiB global threshold is
an **alert, not a hard project-wide spending cap**. Approve a total run budget and
monitor billing manually; do not claim billing budgets stop spending.

## Architecture and implemented corrections

Browser -> loopback Express -> demo Auth/Firestore -> existing workflow ledger,
upload intents and quotas -> a separate keyless GCS transport for the approved
development bucket. Private evidence GET -> existing record authorization ->
persisted reference validation -> generation-specific verified streaming.

- New `gcs` runtime selection is explicit, development/test-only, and requires the
  existing integration gate, exact demo project/loopback hosts, an approval marker,
  exact target tuple, explicit standard-format ADC path and UUID namespace.
- Production/default remains `local`. No `.env`, credential, deployed setting,
  frontend environment, provider selection or real resource was changed.
- Opt-in development startup skips automatic `.env` loading in server/Admin
  initialization. This avoids inadvertently importing adjacent production keys.
  Forbidden credential/SDK-discovery/Storage-emulator/debug selectors fail closed.
- Admin Auth/Firestore are initialized for the demo project **without GCS ADC or
  a real bucket**. A separate lazy Storage client uses existing ADC, keyless
  impersonation, exact introspected identity, verified scopes and short expiry.
  Tokens remain in memory, are not returned/logged, and refreshes are revalidated.
- The backend binds to `127.0.0.1`; a socket-origin guard rejects nonloopback
  requests, ignoring spoofed forwarded headers. Existing rate limits remain active
  for real-cloud development, rather than inheriting the test-only bypass.
- Existing upload/retrieval adapters, transactions, leases, quotas, validated hashes,
  generation strings, revision history and protected routes are reused. No Storage
  I/O occurs inside Firestore transactions. No dependency or business-rule changes.
- New object names have the development prefix. Old authorized development namespace
  references remain readable after a namespace change. Acceptance/production names,
  paths, identities and buckets are rejected. Reference schema stays version 1 with
  `provider: "firebase"`; `gcs` is a runtime selector, not a record migration.
- Added the SDK CRC-error deletion guard to application uploads: unexpected checksum
  failure cannot invoke the SDK's automatic object deletion. CRC checks themselves
  remain enabled. Ambiguous uploads retain durable reconciliation state.
- Real-GCS development requires an explicit valid `Idempotency-Key` (8–128 ASCII
  letters/digits/underscore/hyphen). Existing emulator/local no-key behavior remains
  unchanged. Actor/workflow/target/payload + validated image hashes bind each key;
  changed payload -> 409; concurrent operation -> safe 202; linkage must be durable
  before success. Ledger entries have no unsafe replay-enabling TTL.
- Minimal opt-in frontend support retains a key for each open form intent, including
  its 401 retry and uncertain response retry. A 202 cannot close/reset the form or
  display success. Guest evidence reuses its contribution key; recovery remains
  possible if its own reservation consumed the final allocation. Guest quantity/item
  remain locked during that development recovery. UI/CSS are not redesigned.
- Frontend GCS opt-in rejects production builds/Auth configuration **before Firebase
  initialization**. No bucket, ADC or service-account credentials enter frontend code.
- Cloud reads are independent of writes. Switching uploads to local with explicit
  cloud reads retained preserves authorized cloud previews, old local files, root-only
  planting evidence and monitoring revisions. Cloud failures never fall back to a
  different local file or report a local write as a successful cloud write.

The Firebase Auth/Firestore skill checks informed fail-closed emulator routing and
credential separation. Live database discovery/provisioning was deliberately not
performed because this task forbids production/cloud operations.

## Files changed in this task

Backend (previous unrelated changes in these and other files were retained):

- `.env.gcs-development.example`
- `src/config/developmentGcs.js`, `src/config/evidenceStorage.js`, `src/config/firebase.js`
- `src/app.js`, `src/server.js`, `src/middleware/rateLimiter.middleware.js`
- `src/services/developmentGcs.service.js`, `src/services/evidenceWorkflow.service.js`
- `src/services/evidenceUploadQuota.service.js`
- `src/services/firebaseEvidenceStorage.service.js`, `src/services/firebaseEvidenceRetrieval.service.js`
- `tests/developmentGcs.test.js`, `tests/helpers/developmentGcsFixture.js`
- `tests/storageInitialization.test.js`, this document

Frontend:

- `.env.integration.example`, `src/config/integrationEnvironment.js`
- `src/utils/evidenceAttempt.js`
- `src/pages/PlantingPage.jsx`, `src/pages/MonitoringPage.jsx`, `src/pages/GuestEventPage.jsx`
- `tests/evidenceAttempt.test.mjs`, `tests/integrationEnvironment.test.mjs`

The frontend's required `AGENTS.md` Graphify query/update was run: generated
`graphify-out` graphs/cache/backups were refreshed, not cleaned or staged. Existing
Graphify changes, unrelated source work and generated files were preserved. Build
output is ignored. No source/package/lockfile outside this scope was deliberately
changed. Temporary test snapshots/runners are outside Git and contain synthetic
configuration only; no credentials or existing uploads were copied. The final
snapshot included the integration directory's existing synthetic fixtures, but
the rerun generated its own UUID-scoped actors/images rather than using them.

## Compatibility and readiness matrix

| Area | Result / evidence |
| --- | --- |
| Default local, production cloud blocking | PASS — offline configuration and initialization tests |
| New GCS config, identity, privacy checks | PASS — injected offline clients; actual new resources NOT VERIFIED |
| Planting Reports / geotagged verification | PASS — emulator authenticated API + development GCS saga mocks |
| Guest contributions | PASS — emulator API/RBAC + GCS saga mocks; frontend retry source/unit checks |
| Early and official monitoring | PASS — emulator API + development GCS saga mocks |
| Retained/replacement evidence corrections | PASS — emulator API/revision checks + GCS saga mocks |
| Private retrieval, unauthorized/malformed/missing refs | PASS — adapter mocks + emulator API |
| Local root-only evidence and revisions | PASS — resolver/local/rollback tests |
| Upload disabled / local rollback / cloud reads | PASS — development GCS mock bytes + emulator rollback |
| Native Storage Emulator `ifGenerationMatch=0` | FAIL — known capability limitation, not bypassed |
| Actual GCS precondition/private integrity contract | Historical Phase 8H PASS; NOT rerun here |
| New development resource existence/effective IAM/billing | NOT VERIFIED — no live access authorized |
| Authenticated browser workflows against real development GCS | NOT VERIFIED — activation not authorized |
| Production cloud activation, migration and schedulers | BLOCKED / not authorized |

## Verification results

Use counts per run; suites overlap and must not be summed as independent coverage.
The current workspace was revalidated on 2026-10-23 after `npm ci` restored the
dependencies already pinned by `package-lock.json` (the prior `node_modules` tree
contained older packages). No manifest or lockfile dependency was added or upgraded
by this revalidation. The initialization test now clears inherited Firebase, GCS,
Google, MENRO, evidence-storage and `DEBUG` selectors before each isolated load, so
a developer shell cannot silently choose or contaminate its test environment.

| Run | Result |
| --- | --- |
| Final backend root regression, `node --test tests/*.test.js` | **589/589**, no skips |
| Current frontend integration-environment safety test | **3/3**, no skips |
| Current targeted frontend ESLint (`src`, `tests`, Vite/ESLint config) | PASS, no diagnostics |
| Current frontend `npm run build` | PASS; existing >500 kB chunk warning remains |
| Focused config/upload/retrieval/workflow/initialization + integration safety | 131/131 before the last rate-limit test; final development suite 46/46 |
| Storage/quota/private retrieval/config Emulator batch | 35 passed / 36; one known native precondition failure |
| Authenticated evidence workflow Emulator API | 13/13; final-source rerun also 13/13 |
| Read-preserving rollback Emulator API | 13/13; final-source rerun also 13/13 |
| Emulator total (three batches, no skips) | **61 passed / 62; 1 known failure** |
| Final frontend root regression (`*.test.js` and `*.test.mjs`) | **117/117**, no skips |
| Targeted frontend ESLint | PASS, no diagnostics |
| Frontend `npm run build` | PASS; existing >500 kB chunk warning remains |
| JavaScript syntax / both-repository whitespace checks | 14 JavaScript files passed; both `git diff --check` passed |

The isolated Storage Emulator was started/stopped only for this task on 9199;
existing Auth 9099 and Firestore 8080 services were not stopped/reset/replaced.
UUID actors/records and dedicated temporary upload roots prevented shared fixture
collisions. HTTP/fetch were loopback-restricted and HTTPS blocked in the emulator
runner. No migration uploads/tests or migration quota reset/bypass occurred.

The failing test is named `actual emulator create-only precondition rejects
overwrite (required capability)`: the emulator changed the generation/bytes despite
`ifGenerationMatch=0`. It exercises only its own synthetic object. It remains a
failure, not a skip or a weakened assertion. Business-saga retry/duplicate, linkage
failure, lost response, quota idempotency, authorization, retained/replaced evidence,
malformed references, missing objects and rollback assertions passed.

Initial sandbox `spawn EPERM` attempts did not execute tests; permitted reruns are
the counts above. Two final-emulator launch attempts failed at test-file load
(two files each, zero workflow test cases executed) because the temporary snapshot
lacked routes/dependency linkage. A fresh complete snapshot with the existing clean
dependencies fixed that environment problem; **26/26 final-source API tests then
passed** on Node 22.14.0. No application change was made to mask those failures.
An SDK package-version probe also used a non-exported package.json subpath; the
correct SDK_VERSION/installed-package metadata check confirmed Admin 14.5.0,
Firestore 9.3.1 and Storage 8.4.0 without modifying dependencies.
Expected synthetic failure logs in negative tests are not extra
failed tests. No additional `SCHEDULE_STALE` exception was hidden or relaxed.

## Future activation procedure — DO NOT RUN until approved

### Prerequisites and persistence

Have the exact resources/privacy/IAM/cost decisions above approved and manually
verified. Existing standard Windows user ADC is used; no new login, key file or
credential modification is needed in this procedure. Source ADC must be an
authorized-user credential (or the approved impersonation wrapper), with no
foreign quota project, delegates, endpoints or service-account private key.

Use synthetic emulator users only; no production login or real MENRO photos. Do
not expose emulators or backend over LAN/tunnels. Do not activate workers. Preserve
one stable emulator dataset/export, upload root and namespace between restarts.
Losing Firestore emulator ledgers/quotas while keeping GCS objects breaks safe
recovery/accounting; never start against an empty/reset emulator after uploads.
If the ledger is lost, disable writes and reconcile from backups with explicit
approval. Do not “fix” it by deleting objects or resetting quota.

In an emulator-only terminal, inspect ports first. If 8080/9099 already belong to
other work, **do not stop them**; reuse only after verifying they are the intended
demo instance with an agreed persistent export/backup plan, otherwise STOP.
For a dedicated approved session with free ports:

```powershell
Set-Location C:\Users\chuak\Desktop\menrosystem
$state = Join-Path $env:LOCALAPPDATA 'MENRO-development-emulator-state'
# First start ONLY before any development GCS uploads:
firebase emulators:start --only auth,firestore --project demo-menro-phase2 --config firebase.json --export-on-exit "$state"
# Subsequent starts (instead of the first-start command):
# firebase emulators:start --only auth,firestore --project demo-menro-phase2 --config firebase.json --import "$state" --export-on-exit "$state"
```

The console's explicit `--project demo-menro-phase2` does not deploy Firestore or
change its production location. Preserve/export the dataset on every orderly stop;
unexpected termination can lose the last session. Approve that development data
durability limitation before enabling writes. Do not run two owners on these ports.

### Backend — dedicated PowerShell terminal, AFTER approval

Check ports 5000/5173 are free; do not replace existing services. Use a fresh shell
without production Firebase/credential/Storage settings. The following selects an
isolated source snapshot and locked install, not the stale repository dependencies.
It does not copy `.env`, keys, uploads, fixtures or Git metadata:

```powershell
$repo = 'C:\Users\chuak\Desktop\menrobackend'
$devRoot = Join-Path $env:TEMP 'menro-gcs-development-runtime'
if (Test-Path -LiteralPath $devRoot) { throw 'Review/reuse existing runtime; do not overwrite it.' }
New-Item -ItemType Directory -Path $devRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'src') -Destination $devRoot -Recurse
Copy-Item -LiteralPath (Join-Path $repo 'package.json'),(Join-Path $repo 'package-lock.json') -Destination $devRoot
Set-Location $devRoot
# Use Node >=22 <25, preferably the tested Node 22.14.0 or an approved supported patch.
node --version
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Isolated installation failed' }

$env:NODE_ENV = 'development'
$env:PORT = '5000'
$env:MENRO_INTEGRATION_TEST = 'true'
$env:GCLOUD_PROJECT = 'demo-menro-phase2'
$env:FIREBASE_PROJECT_ID = 'demo-menro-phase2'
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
# Only this dedicated terminal's variables; never edit a real .env/credentials file.
'FIREBASE_STORAGE_EMULATOR_HOST','STORAGE_EMULATOR_HOST','FIREBASE_STORAGE_BUCKET',
'GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_PRIVATE_KEY','FIREBASE_CLIENT_EMAIL','FIREBASE_CONFIG',
'GOOGLE_CLOUD_QUOTA_PROJECT','GOOGLE_CLOUD_PROJECT','MENRO_HISTORICAL_MIGRATION','DEBUG' |
  ForEach-Object { Remove-Item -LiteralPath "Env:$_" -ErrorAction SilentlyContinue }
$env:FRONTEND_URL = 'http://localhost:5173'
$env:ALLOWED_ORIGINS = 'http://localhost:5173'
$env:BACKEND_URL = 'http://localhost:5000'
$env:MENRO_UPLOAD_ROOT = Join-Path $env:TEMP 'menro-gcs-development-local-evidence'
# KEEP this root, namespace, emulator state and synthetic secrets stable across restarts.
$env:REQUEST_IDENTIFICATION_ENCRYPTION_KEY = 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk='
$env:GUEST_INVITATION_SECRET = 'synthetic-development-only-not-for-production'
$env:EVIDENCE_DAILY_FILE_LIMIT = '50'
$env:EVIDENCE_DAILY_BYTE_LIMIT = '209715200'
$env:EVIDENCE_GLOBAL_DAILY_ALERT_BYTES = '1073741824'

$env:MENRO_GCS_DEVELOPMENT = 'true'
$env:EVIDENCE_GCS_PROJECT_ID = 'menrosystem-ddfac'
$env:EVIDENCE_GCS_BUCKET = 'menro-evidence-dev-20261022-a4c8e912'
$env:EVIDENCE_GCS_SERVICE_ACCOUNT = 'menro-evidence-development@menrosystem-ddfac.iam.gserviceaccount.com'
$env:EVIDENCE_GCS_ADC_FILE = Join-Path $env:APPDATA 'gcloud\application_default_credentials.json'
if (!(Test-Path -LiteralPath $env:EVIDENCE_GCS_ADC_FILE)) { throw 'ADC absent; do not create credentials automatically' }
$env:EVIDENCE_GCS_NAMESPACE = '<replace-with-one-approved-stable-lowercase-UUID>'
$env:EVIDENCE_GCS_DEVELOPMENT_APPROVAL = 'APPROVED_DEVELOPMENT_BUCKET_AND_IDENTITY_ONLY'
$env:EVIDENCE_STORAGE_PROVIDER = 'gcs'
$env:EVIDENCE_CLOUD_WORKFLOW_ENABLED = 'true'
$env:EVIDENCE_CLOUD_READ_ENABLED = 'true'
node src/server.js
```

The fixed identification/guest values above are conspicuously public synthetic
fixture secrets for the isolated demo only, never production secrets. Replace the
namespace placeholder before startup; it intentionally fails validation as written.
Do not print ADC, token values or full SDK errors. The first actual cloud evidence
operation authenticates, validates the exact identity and reads bucket security
metadata before exposing a client. There is no startup cloud write or automatic
fallback. Config/identity/privacy/network failures block the operation.

### Frontend — separate terminal, AFTER approval

```powershell
Set-Location C:\Users\chuak\Desktop\menrosystem
$env:NODE_ENV = 'development'
$env:VITE_GCS_DEVELOPMENT = 'true'
$env:VITE_USE_FIREBASE_EMULATORS = 'true'
$env:VITE_FIREBASE_PROJECT_ID = 'demo-menro-phase2'
$env:VITE_FIREBASE_API_KEY = 'demo-key'
$env:VITE_FIREBASE_AUTH_DOMAIN = 'demo-menro-phase2.firebaseapp.com'
$env:VITE_FIREBASE_STORAGE_BUCKET = 'demo-menro-phase2.firebasestorage.app'
$env:VITE_FIREBASE_MESSAGING_SENDER_ID = '000000000000'
$env:VITE_FIREBASE_APP_ID = '1:000000000000:web:phase2'
$env:VITE_API_URL = 'http://localhost:5000/api'
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Browse `http://localhost:5173` (not a deployed URL). Frontend never uses ADC or GCS
directly; protected previews use existing authenticated backend image endpoints.
Use emulator-managed synthetic Participant/Staff/Admin profiles and synthetic guest
invitations. Do not use a real Google popup to seed production identities.

### Bounded application smoke checklist — separately authorized live work

1. Verify the emulator project and synthetic role/profile identities, local API
   origin, exact development bucket/identity and namespace. No production endpoint.
2. Submit one small original synthetic geotagged planting report. Expect Pending
   Review, immutable private reference/hash/generation, and authorized preview only.
   Preserve existing geographic, capture-date, EXIF and quantity rules; do not fake
   those client inputs as a substitute for validated photo metadata.
3. Retry the **same open form** after simulated response interruption: same key,
   same logical record/upload/quota charge. Changed payload with same key -> 409.
   A 202 means pending, not success; keep fields/photos unchanged and retry later.
4. Test one guest contribution, early observation and eligible official observation
   with the existing workflow, then returned corrections retaining/replacing evidence.
   Review/final authority, schedules and official analytics must stay unchanged.
5. Confirm owner/reporter and authorized Staff/Admin previews; unrelated participant
   denied; malformed or missing references fail without private path disclosure or
   local fallback. No second live GCS identity test is implied.
6. Confirm existing local/root-only/revision previews, then perform the read-preserving
   rollback below. Re-enable writes only with preserved ledgers/intents and approval.
7. Inspect synthetic emulator records/quotas and sanitized server outcomes only. Do
   not reset accounting, delete GCS objects or activate schedulers for convenience.

Keys are in-memory form intents, **not durable browser drafts**. Closing/reloading
a form loses its retry key. If success is uncertain, inspect/reconcile the emulator
operation first; do not create a new intent blindly. A changed payload/key is not an
automatic dedupe mechanism. Ambiguous uploads remain tracked/reserved for recovery;
“no orphan” means no silently forgotten upload, not impossible physical orphaning
after loss of the emulator database. Do not delete ledger entries to clear a conflict.

## Read-preserving rollback

Stop only the backend process you own, retaining emulator data/export, upload root,
namespace and all evidence. In that backend terminal change **only**:

```powershell
$env:EVIDENCE_STORAGE_PROVIDER = 'local'
$env:EVIDENCE_CLOUD_WORKFLOW_ENABLED = 'false'
$env:EVIDENCE_CLOUD_READ_ENABLED = 'true'
# Keep MENRO_GCS_DEVELOPMENT=true and the exact development target/ADC/approval selectors.
node src/server.js
```

New evidence uses local storage; authorized previously linked development GCS bytes
remain readable. New local operations do not become cloud successes. Persisted
reference type determines dispatch; no migration/rewriting/deletion occurs. Keep
frontend retry opt-in while this isolated development session exists; the local
backend preserves its preexisting contract (no durable cloud saga for new local
submissions).

Complete cloud read revocation is different: stop the owned backend, set provider
local/write=false/read=false, set `MENRO_GCS_DEVELOPMENT=false`, and remove **all six**
`EVIDENCE_GCS_*` target selectors. This intentionally makes cloud evidence unavailable;
it is not a read-preserving rollback. Do not point at another bucket, silently serve
a same-named local file, or delete cloud data. Never remove ADC or edit production
configuration as a rollback step.

## Stop conditions and final recommendation

STOP writes on wrong identity/project/bucket, unexpected IAM/privacy change, missing
emulator state, quota uncertainty, unsafe/nonlocal connection, repeated reconciliation
errors, 409 payload conflict, ambiguous generation/integrity, or unauthorized endpoint.
Keep original files, intents, revisions, quota and operation ledger intact. No cleanup,
migration, historical real evidence or real-service retry is automatically authorized.

**BLOCKED** specifically on resource/ongoing-trust/cost approval, manual development
bucket/identity/IAM/privacy setup and separately authorized application activation.
The native emulator precondition limitation remains documented; the actual GCS
contract was already independently verified in Phase 8H, not rerun here. Real-cloud
application/browser smoke outcomes cannot be claimed until activation is authorized.
Production activation, Render durability, historical migration, cleanup and deployment
remain separately blocked. No commit, push, provider activation or live cloud
operation occurred during this integration task.
