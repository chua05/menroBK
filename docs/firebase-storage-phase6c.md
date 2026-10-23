# Phase 6C — controlled historical evidence migration tooling

## Resume authorization — 21 October 2026

The user has approved a dedicated emulator-only migration namespace with a single
shared 50-file / 200-MiB Manila-day cap across runs/workers. The earlier blocker
below is historical, not the current decision. Implementation results will be
recorded below; no production accounting or activation is authorized.

Planned boundaries: freeze a bounded namespaced synthetic Firestore snapshot and
use Phase 6B eligibility without relaxing LIVE_SOURCE. Reserve a deterministic
migration operation, stable upload intent and fenced lease transactionally. Use
the existing private adapter OUTSIDE business transactions with the fixed migration
actor. Transactionally re-read exact source selectors and commit only additive
private references, upload-intent LINKED and ledger LINKED together. Verify actual
cloud bytes/generation and original local bytes before marking VERIFIED. Retain
uncertain operations/charges and never recycle IDs or delete evidence. Dry-run
and verification do not write business/ledger/quota/Storage data. Legacy root-only
planting records receive only an additive root reference, with narrowly tested
read compatibility. No submission/review/schedule/analytics operation is replayed.

## Current implementation and acceptance — 21 October 2026

**Emulator-only Phase 6C acceptance PASSED. Production migration is NOT authorized.**
The earlier accounting blocker is resolved by the user's explicit policy decision.
The 20 October pre-authorization audit is retained below as historical context.

### Exact files changed in this authorized implementation

Existing services changed narrowly:

- `src/services/evidenceUploadQuota.service.js`: fixed trusted migration actor,
  distinct hash namespace; hard 50-file/200-MiB admission-day limits independent of
  participant quota configuration; gate rechecked when a capability is used.
- `src/services/firebaseEvidenceStorage.service.js`: accepts the gated migration
  actor and tags its private metadata separately; exact-string media transport for
  generations above Number.MAX_SAFE_INTEGER, rejecting malformed/non-string values.
- `src/services/evidenceAccess.service.js`: carries saved root privateEvidence into
  the existing legacy planting-photo fallback. Authorization, local behavior and
  cloud gate remain unchanged; there is no new endpoint or client selector.
- `tests/integration/evidenceWorkflowEmulator.test.js`: one synthetic EXIF time
  changed from 08:30 to 00:00 on the selected Manila date. At approximately 01:00
  the former valid-photo fixture was in the future; backend rejection was correct.
  Production timestamp rules and the known stale release-date fixtures are unchanged.

New files:

- `src/services/historicalEvidenceMigration.service.js`
- `src/services/historicalEvidenceMigrationLedger.service.js`
- `scripts/migrateHistoricalEvidenceEmulator.js`
- `tests/historicalEvidenceMigration.test.js`
- `tests/integration/historicalEvidenceMigrationEmulator.test.js`

Updated reports: this document and `docs/firebase-storage-phase7a.md`.
Total: 11 files, including both reports. No dependency, frontend, real environment,
Storage Rules, IAM, billing or application workflow change.

### Isolation, eligibility and original preservation

All modes require NODE_ENV=test, explicit demo integration and migration gates,
credential-free exact loopback hosts, the synthetic bucket and fresh scan6b-UUID
document namespace. The local root must be an explicit dedicated temporary
`menro-migration-*` directory. No production execution mode or application startup
registration exists. No generic cloud bucket/project/path arguments are accepted.

Discovery reads at most 1,000 raw namespaced documents, freezes them into the
existing immutable synthetic memory source and runs the unchanged Phase 6B scanner.
Direct live-emulator rows are NOT promoted from REQUIRES_REVIEW. Only ELIGIBLE
groups become new plans. Missing/unsafe/unverified/cloud-conflicting/duplicate-
content references are excluded. Unknown initial revision metadata stays reviewable;
no historical fields are invented to make a source eligible.

The operation groups aliases/reused revision edges only within the same trusted
record, observation/evidence revision and local path. Equal bytes across different
paths are not merged. Root aliases do not become independent image jobs. Parent
report aggregates are never independently rewritten; contribution sources retain
their actual context. Exact observation/revision selectors reject duplicate IDs.

Before upload and again before linkage, original bytes are re-read with bounded
no-follow/realpath/file-ID checks, exact expected size, signature and SHA-256.
Only the existing validated private adapter may upload. Original files/local fields
remain. Fresh transaction snapshots preserve unrelated fields, review statuses,
counts, reporter/owner/event/site relationships, chronology and revision ordering.

### Shared accounting — implemented approved policy

Trusted actor `{migrationScope: "historical-evidence-v1"}` becomes actorKind=migration
with a fixed namespaced hash. Every process/run uses the SAME identity for a given
Manila day. It cannot collide with a user/guest of the same textual ID and cannot
be replaced with a run UUID. MENRO_HISTORICAL_MIGRATION=true is required; production
integration/project/host checks still fail closed. No HTTP route accepts this actor.

Existing transactional reservations/counters/audit are reused. Reserved + finalized
usage may not exceed 50 files or 209,715,200 bytes per Manila day. Retries reuse the
stable intent/reservation; confirmed Storage success finalizes once even if business
linkage later fails. Uncertain writes retain their reservation/charge. Participant
and guest identities, limits and usage are not charged or redefined.

Definite daily-quota rejection pauses the migration operation without consuming its
material-failure attempt budget. It does not create an object or recycle an identity.
Admission can be retried after a later day, subject to existing intent/day safeguards.
Already-started old-day uncertain uploads may only recover a verified existing object;
they cannot write an absent object against yesterday's quota. Unused old-day intents
may require manual reconciliation; this tool does not automatically release/recycle
them. The global usage alert remains an alert, not a global billing/admission cap.

### Ledger and transaction design — implemented

Private demo collection `historicalEvidenceMigrations` stores schemaVersion=1,
deterministic operation ID, source plan/fingerprint, namespace, stable intent UUID,
lease token/deadline, material-attempt count, state, original reference snapshots,
private cloud reference and append-only timestamped audit. Retention is
`retain-no-ttl-v1`: no expiry, key recycling, pruning or deletion automation.

Identity binds schema, record, exact evidence location/context, local source and
expected checksum. It excludes volatile document updateTime. Reuse of an already
reserved logical location with a changed source identity is quarantined rather
than creating a fresh object. Existing ledger fingerprint conflicts fail closed.

1. Transactionally reserve the operation and server-generated stable intent UUID;
   enforce a 180-second fenced lease and at most three material attempts.
2. Reserve/upload using existing intent/quota transactions. Storage I/O stays outside
   Firestore transactions. State progresses RESERVED → UPLOADING → UPLOADED.
3. Re-read the business document, upload intent, ledger and required relationship
   bindings INSIDE a transaction. Check lease/version identity, original target
   fingerprints and owner/event/site/cohort bindings. Reject stale targets.
4. Commit additive private references, intent LINKED and ledger LINKED together.
   Arrays are rebuilt from the fresh transaction snapshot; there is no stale export
   replacement or independent parent update. A lost acknowledgement is recovered
   by reading that atomic receipt, never by uploading another object.
5. Verify saved linkage, original source, actual cloud bytes/size/private metadata
   and exact generation through the existing protected retrieval adapter. Recheck
   linkage/bindings in a transaction before marking VERIFIED.

Failures retain RECONCILIATION_REQUIRED plus stable source/intent identities. A
competing worker gets an explicit in-progress result; an expired owner cannot commit.
Completed operations are verified, not uploaded again. Pending operations are ordered
before completed verification work so bounded reruns progress beyond the first batch.
Exhausted attempts remain visible for manual reconciliation and do not starve other work.

### Modes and invocation

The standalone CLI accepts only an explicit JSON config with namespace, evidenceRoot,
outputDirectory and optional maxOperations. No production mode or credential option.
Output is a safe status/opaque-ID summary, never a source path or cloud reference.

```powershell
node scripts/migrateHistoricalEvidenceEmulator.js --config C:/approved-synthetic/config.json
node scripts/migrateHistoricalEvidenceEmulator.js --config C:/approved-synthetic/config.json execute-emulator
node scripts/migrateHistoricalEvidenceEmulator.js --config C:/approved-synthetic/config.json reconcile-emulator
node scripts/migrateHistoricalEvidenceEmulator.js --config C:/approved-synthetic/config.json verify-emulator
node scripts/migrateHistoricalEvidenceEmulator.js --config C:/approved-synthetic/config.json rollback-assessment
```

Omitted mode is dry-run: no ledger/quota/business/Storage writes. Execution requires
the separate explicit execute-emulator mode AND the validated migration environment.
Reconcile handles EXISTING ledger operations only, not newly discovered candidates.
Verify and rollback-assessment are read-only and never repair/deactivate references.
Actual reference reversal still requires explicit manual approval. There is no
automatic source/object deletion or local fallback on an explicit cloud failure.

Example config (the UUID and paths must be real isolated synthetic values):

```json
{
  "namespace": "scan6b-<fresh lowercase UUID>-",
  "evidenceRoot": "C:/Users/<operator>/AppData/Local/Temp/menro-migration-<run>",
  "outputDirectory": "C:/approved-synthetic/reports",
  "maxOperations": 10
}
```

Child-process environment only, never real .env or Render settings:

```powershell
$env:NODE_ENV='test'
$env:MENRO_INTEGRATION_TEST='true'
$env:MENRO_HISTORICAL_MIGRATION='true'
$env:GCLOUD_PROJECT='demo-menro-phase2'
$env:GOOGLE_CLOUD_PROJECT='demo-menro-phase2'
$env:FIREBASE_PROJECT_ID='demo-menro-phase2'
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
$env:FIREBASE_STORAGE_EMULATOR_HOST='127.0.0.1:9199'
$env:FIREBASE_STORAGE_BUCKET='demo-menro-phase2.firebasestorage.app'
$env:EVIDENCE_STORAGE_PROVIDER='local'
```

Standalone infrastructure migration does not require application cloud traffic:
leave EVIDENCE_CLOUD_WORKFLOW_ENABLED unset. Authenticated application regression
tests use their separately documented demo cloud gate. Reject credentials/config
variables rather than reading them. The integration harness validates/removes only
the Firebase CLI's known demo discovery config in its own child process.

### Executed tests and limitations

Final migration unit/transport: **7 passed / 0 failed / 0 skipped**. Includes the
maximum uint64 generation in mocks AND real SDK requests to a bounded loopback
HTTP stub. This proves exact query transport, not GCS service acceptance.

Final migration emulator: **18 passed / 0 failed / 0 skipped**. Actual persisted
business/intent/quota/ledger data is checked for successful migration, repeats,
concurrent execution, shared count/byte boundaries, upload/linkage interruption,
read-only verification, root-only protected retrieval and unrelated-user denial,
parent/contribution reads, reused monitoring revisions, stale source/relationship
rejection, source identity conflict, bounded continuation and default CLI dry-run.
The inconsistent-reference verification cases do not delete/corrupt real evidence;
actual-byte corruption and missing objects are also covered by the existing retrieval
emulator regressions. All test sources are synthetic; original local bytes survive.

Final combined Phase 6C/Phase 5 rerun before the last added conflict case passed
30/30 (17 migration + 13 authenticated workflows). Final 18-case migration rerun
passed after that guard was added. Phase 6B scanner regression: 41/41.
Full backend: 343 passed / 2 failed / 0 skipped, 345 total. Existing Storage suites:
35 passed / 1 failed / 0 skipped. Exact commands and independent failures are recorded
in the Phase 7A report. Overlapping suites must not be summed as unique cases.

Operational tool bounds: 1,000 source documents, 1,000 inventory files, 200 MiB scan
hash budget, 50 operation identities per synthetic namespace and 1–50 operations
per execution (default 10). Oversized namespaces require explicit independent
synthetic partitions; there is no unbounded or production scan. Namespace limits
do NOT reset the shared migration daily accounting identity.

Read-only verification is conservative if legitimate later business edits change
an original binding. Do not restore old review/count data to make a receipt verify.
After three material failures or incompatible source/old-day intent state, retain
the operation and require audited reconciliation; do not create another identity.
No automatic reference-reversal executor was implemented.

The native Storage emulator create-only test remains failing and unchanged. Only
separately approved real nonproduction service tests can establish that guarantee.
Production IAM/rules/source completeness/backups/Render durability remain unverified.
Stopping the task-owned Storage emulator discards its ephemeral synthetic objects;
retained demo Firestore receipts can correctly become unavailable afterward. This
is not a claim of production evidence loss or a reason to delete/re-upload records.

## Historical pre-authorization audit — 20 October 2026 (superseded status)

20 October 2026. Branch: `fix/validated-survival-analytics`.

**NOT IMPLEMENTED / NOT ACCEPTED.** This is the documented safe-stop outcome,
not a migration implementation or successful migration test report.

The combined task explicitly requires stopping the accounting subtask when a new
policy decision is necessary and continuing only independent read-only checks.
That condition applies. No migration writer, migration ledger, executable migration
CLI, quota extension, business mutation or synthetic cloud upload was introduced.
The independent Phase 7A findings are in `firebase-storage-phase7a.md`.

## Confirmed prerequisite

- `src/services/firebaseEvidenceStorage.service.js:67-90`, serverContext, accepts
  only `{uid}` or `{guestParticipantId}` and creates the matching quota actor.
- `src/services/evidenceUploadQuota.service.js:28-38`, serverActor, recognizes only
  user/guest namespaces. `:92-98` applies admission-day limits and stores actorKind.
- `src/config/evidenceUploadQuota.js:11-13` defaults to 50 files / 200 MiB per actor
  per Manila day; the 1-GiB global figure is an alert threshold, not a hard cap.
- `docs/firebase-storage-phase6a.md`, section H.6, requires approved migration
  accounting before implementation, without user charging, backdating or bypass.
- No approved migration actor, shared budget scope, limits, accounting lifetime
  or cross-run admission policy exists in current source or supplied decisions.

Using a historical participant's UID would charge participant admissions as new
uploads. Fabricating `uid: migration-*` would still label traffic as a normal user.
Disabling reservations would bypass cost controls. Creating a fresh budget actor
for each run could bypass an intended shared cap. None was implemented.

### Smallest proposed decision — NOT approved or implemented

Approve a distinct trusted-server **migration** actor namespace, unavailable to
HTTP clients and production, with one shared emulator-only accounting identity
across migration runs. A conservative candidate is the existing default ceiling:
50 files / 200 MiB per Manila admission day, separate from participant/guest usage.
Require bounded per-execution limits no larger than that ceiling, persistent
transactional reservation/finalization, retry idempotency, no old-day new uploads,
and retention of uncertain charges. Do not treat the global alert as a cap.

Confirm limits, scope and retention before adding the actor path to the existing
quota/upload infrastructure. This is a proposal, not a newly imposed MENRO policy.
No production migration/accounting policy is authorized by emulator approval.

## Other compatibility requirements found in current source

1. `historicalEvidenceScanner.service.js:172` adds LIVE_SOURCE to every direct
   emulator reference; classification utility treats it as REQUIRES_REVIEW.
   Execution cannot promote these rows to ELIGIBLE or remove this safeguard.
   Proposed path: freeze the explicitly namespaced synthetic source into an
   immutable in-memory snapshot, scan that with the existing scanner, then verify
   source/evidence context again in the eventual linkage transaction. A scanner
   checksum or checkpoint alone is not an authenticated migration capability.
2. `evidenceAccess.service.js:114-120` constructs a legacy root-photo fallback
   from photoURL/photoPath only; root privateEvidence is dropped. Appending a root
   cloud field would not prove cloud retrieval through that fallback. Either
   quarantine root-only records or obtain a separately scoped compatibility fix
   and tests; do not claim those records migrated successfully with a broken read.
3. Initial monitoring revision evidenceRef at `monitoring.service.js:488-507`
   lacks imageDetails even though its observation has it. The scanner correctly
   leaves unknown metadata reviewable. Do not invent required revision metadata
   or silently declare the revision ELIGIBLE. Define trusted same-evidence
   provenance rules or leave these references excluded.
4. Reused revision references and root aliases must be grouped by their trusted
   business/evidence identity, not global content hash. Different owners or actual
   source paths must not automatically share an operation/object.
5. Existing LINKED upload intents reject new upload calls. A retry after business
   linkage must load and verify the existing reference, not call upload again.

## Planned architecture and transaction boundaries — design only

Reuse the Phase 6B discovery/path policy, existing immutable upload intents,
approved quota extension and private retrieval. Do not call submission endpoints
or replay business workflows. Keep a dedicated historical migration ledger rather
than reusing live Idempotency-Key operations or accepting client-supplied IDs.

Proposed files AFTER resolving the blocker:

- `src/services/historicalEvidenceMigration.service.js`
- `src/services/historicalEvidenceMigrationLedger.service.js`
- `scripts/migrateHistoricalEvidenceEmulator.js`
- `tests/historicalEvidenceMigration.test.js`
- `tests/integration/historicalEvidenceMigrationEmulator.test.js`
- Minimal approved trusted migration actor support in existing quota/upload modules.

No files in that list were created in this task. No new API route or production
mode should exist. Dry-run must be default; execute/reconcile require separate
explicit emulator flags; verification and rollback assessment must remain read-only.

### Ledger identity and schema proposal

Use a versioned deterministic digest of collection/document identity, canonical
evidence location, immutable observation/evidence revision identity when applicable,
and expected original checksum. Do not include volatile document updateTime in
operation identity. Save bounded original reference snapshots, source size/type,
source/context fingerprint, stable intent UUID, private cloud reference with exact
generation string, approved accounting policy ID, lease token/deadline/version,
attempt counters, linkage receipt and append-only audit timestamps.

Suggested states: PLANNED → RESERVED → UPLOADING → UPLOADED → LINKED → VERIFIED;
uncertain outcomes remain RECONCILIATION_REQUIRED, definitive conflicts BLOCKED.
No TTL/key recycling, automated deletion or fake success state. Migration and
upload-intent states have distinct responsibilities; the upload intent is the
object-write authority, the migration ledger is the source/linkage authority.

### Transaction sequence

1. READ-ONLY preflight: validate explicit demo/loopback/credential-free gates,
   synthetic root and namespace, complete immutable scan, ELIGIBLE classification,
   relationship and canonical selector. Re-read bounded original bytes and verify
   path/file identity, signature, size/hash. Never trust arbitrary serialized plans.
2. Transaction A: reserve deterministic migration identity and stable intent UUID,
   approved budget and fenced lease. Compare any existing operation's immutable
   context; identical retries reuse it, conflicts stop. Use bounded attempts.
3. OUTSIDE transactions: existing adapter reserves/uploads with approved migration
   actor, original bytes, private metadata and ifGenerationMatch=0. Verify actual
   object size/hash/generation; preserve uncertain objects and accounting.
4. Transaction B: read ledger, upload intent, fresh business document and necessary
   relationships BEFORE writes. Check lease/version, exact observation/revision,
   original reference fingerprint and verified intent. Update only the intended
   saved private reference(s), preserving local references and all historical data.
   Build arrays from the freshly read document, not an old scan export. Commit the
   business linkage, intent LINKED and ledger LINKED receipt atomically.
5. OUTSIDE transactions: authenticated byte/generation/context verification,
   source preservation, unchanged review/revision/analytics facts and derived parent
   aggregation. A separate fenced transaction may mark VERIFIED only after this
   succeeds. A lost acknowledgement requires re-reading the durable linkage receipt.

No Storage I/O in Firestore transactions. No independent parent-aggregate writes.
If the target reference changed, stop rather than overwriting newer evidence.

## Recovery and rollback proposal

Upload success/linkage failure retains original object, intent, budget reservation
and operation identity for forward reconciliation. Linkage success/response loss
re-reads the atomic receipt and verifies rather than creating another object.
Missing/corrupt/wrong-generation objects are unresolved, not permission for a new
object or local fallback. Preserve all local originals and prior revisions.

Rollback assessment should compare saved source and current linkage read-only.
Any future reversal needs explicit manual approval and a transactional comparison
against the exact current binding. Never restore a whole stale document, delete
local/cloud evidence, recycle identity or automatically release uncertain charges.

## Acceptance status

All requested Phase 6C migration tests are **NOT EXECUTED / NOT VERIFIED** because
the accounting prerequisite was not bypassed. This includes successful migration,
new-ledger concurrency, recovery after upload/linkage interruption, stale linkage,
legacy read compatibility and verification of migrated objects. No synthetic
migration was attempted; no success claim is made.

Independent existing mocked tests passed 62/62; they do NOT test migration tooling.
See Phase 7A for the exact command, findings, historical results and readiness matrix.

Resume only after the migration accounting policy is explicitly confirmed. Then
implement and test Phase 6C before marking historical migration or production
readiness accepted. Do not begin live migration, cloud activation or deployment.
