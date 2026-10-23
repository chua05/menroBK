# Phase 6B — isolated read-only historical evidence scanner

## Pre-implementation design

Phase 6B does not migrate evidence. The scanner does not modify Firestore business
records or Firebase Storage objects. Production Firebase Storage remains inactive.
No application modules, endpoints, environment files or dependencies will change.

Inputs are explicit: a synthetic memory source or guarded demo emulator source,
approved evidence root, separate output directory, batch size, record/file/hash
budgets, optional checkpoint, source-completeness assertion, and an explicit list
of local backend URL origins (never inferred from stored URLs). Only
`planting-reports/` and `monitoring/` are evidence trees. No home/workspace scan.

Discovery reads raw plantingReports, plantingContributions, monitoringRecords and
their relationship collections. Root aliases, every observation and every revision
remain separate reference edges. Parent aggregated arrays are diagnostic edges,
not additional image jobs. Physical path counts and content counts are separate.

Primary reference precedence follows Phase 6A: BLOCKED, REQUIRES_REVIEW,
ALREADY_CLOUD, MISSING_SOURCE, INVALID_METADATA, DUPLICATE_CONTENT, ELIGIBLE.
Flags retain lower-priority findings. ORPHANED_FILE is a file-only finding and is
permitted only after a complete asserted source and complete file inventory.
Cloud schema alone yields REQUIRES_REVIEW, never proof of private object integrity.
Only explicit trusted synthetic verification fixtures can establish ALREADY_CLOUD.
Unknown legacy context/metadata remains reviewable, not retrospectively verified.

Outputs: exclusively created JSON report and checksum-protected JSON checkpoint,
with opaque reference/file/root identifiers, workflow/class totals, unioned bytes,
hash coverage, cursors/completeness and limitations. No paths, contacts, URLs, GPS,
image bytes or raw business data appear in reports/checkpoints. Checkpoints retain
only normalized relationships, necessary document cursors, digests and hash results.

Document-ID pagination is deterministic. Checkpoints retain bounded normalized
records; resume replays and verifies prior document prefixes before advancing.
Record budget counts NEW records; replay verification has a separate hard 10,000
document bound and is reported explicitly. Each scan is capped at 10,000 source
documents, 50,000 reference edges and 20,000 directory entries; larger datasets
must be partitioned, never silently materialized without bounds. File budget counts
new integrity inspections; directory enumeration is separately bounded. Hashes use
64-KiB reads, one file at a time. A byte-budget-blocked file is not verified; callers
may increase that per-run budget on resume. No file is split into invented hashes.

Memory snapshots have immutable full-input digests. Emulator resume validates
previous prefixes, including insertions/deletions; later concurrent edits cannot
be made into a point-in-time snapshot by pagination. Emulator findings explicitly
retain that limitation. Checkpoints are private operator artifacts, not signed
proof of provenance, and must not be accepted from untrusted parties.

Path security rejects traversal, encoded separators, unexpected drives, arbitrary
URLs and all symlinks/reparse aliases. Realpath containment, no-follow open where
supported, descriptor/stat/path comparisons and post-read checks reduce races.
An actively hostile filesystem still requires an offline, access-controlled
snapshot. Reads never explicitly set timestamps; operating-system access-time
updates cannot be prevented portably by Node and are not evidence-byte writes.

## Implemented files and architecture

Seven NEW files only; no existing application/configuration/dependency files edited:

- `src/services/historicalEvidenceSource.service.js`: immutable synthetic source
  and lazy credential-free emulator read adapter. The adapter exposes readPage and
  close, not a database handle or mutation methods. Collections are allowlisted.
- `src/utils/historicalEvidenceClassification.util.js`: pure normalization,
  source-derived relationships, path rules, structured-reference schema and policy.
- `src/services/historicalEvidenceScanner.service.js`: bounded discovery,
  reconciliation, streaming inspection, checkpoint verification and report output.
- `scripts/scanHistoricalEvidence.js`: explicit standalone JSON-config CLI.
- `tests/historicalEvidenceScanner.test.js`: 34 synthetic unit/CLI tests.
- `tests/integration/historicalEvidenceScannerEmulator.test.js`: 7 isolated demo
  integration cases, UUID fixture setup separate from the scanner reader.
- `docs/firebase-storage-phase6b.md`: this design, execution and verification record.

No import of application startup, Firebase Admin initialization, upload services,
retrieval services or Storage occurs in the scanner. Importing its modules does
not create a Firebase client. Only the explicitly invoked emulator factory loads
the existing Firestore dependency, with an inert credential and a pinned host.

### Raw discovery and relationships

The adapter reads document-ID ASC pages from plantingReports,
plantingContributions, monitoringRecords, events, sites, users, eventParticipants,
distributions, seedlingRequests, plantingEvidenceHashes and monitoringEvidenceHashes.
Registries and relationship documents count as examined source documents, NOT as
additional evidence files or business records. Archived/rejected records are not
filtered out. No HTTP presenter is used.

Planting photos and root photoPath/photoURL aliases remain individual edges. Parent
arrays are explicitly marked PARENT_AGGREGATE and never certified as independent
original images. Contribution ownership handles BOTH actual source schemas:

1. Guest/allocation contribution participantId references eventParticipants;
   contributorId is that guest ID or the registration's userId.
2. Registered request-linked submissions store participantId/contributorId and
   authenticatedSubmitterUid as the actual user UID. No event-registration row is
   invented or required for that schema (`plantingReport.service.js`).

Parent/event and participant/event inconsistencies require review; contradictory
actor bindings are blocked. Missing relationship documents remain reviewable.
The scanner does not prove legal ownership from a directory name or validate a
historical guest's current session. Session/contact data is discarded.

Monitoring reads each history entry and every revisionHistory[].evidenceRef,
retaining early/official/revision breakdowns. Observation ID collisions block
affected references. Missing legacy IDs, unknown type, malformed dates, nonsequential
revision numbers or active-evidence mismatches retain diagnostic flags. Flat legacy
documents retain their real document identity; no virtual lifecycle IDs are made.
Repeated evidenceRevision references count as multiple edges to one path. Status,
counts, review/audit data and scheduling are never changed or recomputed.

### Classification details

All diagnostic flags survive; only the highest-priority primary class is counted
in `metrics.classifications` (these counts sum to evidenceReferences):

1. BLOCKED: unsafe/unsupported paths, symlink/reparse aliases, changing source,
   verified hash mismatch, duplicate observation identity, conflicting authoritative
   references, malformed/untrusted cloud reference, contradictory actor binding.
2. REQUIRES_REVIEW: incomplete graph/inventory, missing relationship/owner or unknown
   historical metadata requirement, legacy/revision ambiguity, parent aggregation,
   unverified cloud object, skipped hash/read error, or live-emulator consistency.
3. ALREADY_CLOUD: valid exact Phase 2 schema/context plus an explicit trusted
   synthetic fixture proof digest. No object is read to manufacture that proof.
4. MISSING_SOURCE: safe local reference missing from an asserted complete source,
   with no higher-priority uncertainty. The missing flag remains even if review
   takes precedence; primary missing counts are not counts of every diagnostic.
5. INVALID_METADATA: malformed declared hashes, dimensions/sizes/format/date,
   detected unsupported signature or signature/extension mismatch.
6. DUPLICATE_CONTENT: otherwise consistent source with equal actual SHA-256 at
   different paths. No merge, shared ownership or upload authorization is implied.
7. ELIGIBLE: byte-preserving migration CANDIDATE within this scanner's inspection
   scope, not proof of camera authenticity, approved planting or complete decoding.

ORPHANED_FILE is separate from reference classifications and NEVER authorizes
deletion. Proven orphan counts are emitted only for complete immutable synthetic
memory snapshots; live emulator unmatched files remain REQUIRES_REVIEW and the
orphan count is null. Likewise no live-emulator reference is silently called
ELIGIBLE: all retain LIVE_SOURCE. This is intentionally conservative.

Cloud schema uses provider/storageVersion/bucket/objectName/generation/contentType/
format/sizeBytes/sha256/uploadIntentId/uploadedAt exactly as current infrastructure.
Generation stays a positive uint64 STRING. Only the approved demo bucket is accepted.
Cloud/local mixed authorities and stored hash conflicts are blocked. A syntactically
valid reference does not establish generation availability, hash integrity or privacy.

## Explicit execution

Run under Node 22.14.0 with the existing clean-lockfile dependencies. Repository
node_modules remains untouched. There is no package script or application startup
registration. An operator must prepare explicit private config/fixture files and
dedicated existing evidence/output directories. Example config (replace placeholder
paths with approved synthetic locations; forward slashes work on Windows):

```json
{
  "source": { "mode": "synthetic-memory", "fixtureFile": "C:/approved-synthetic/fixture.json" },
  "evidenceRoot": "C:/approved-synthetic/evidence",
  "outputDirectory": "C:/approved-synthetic/reports",
  "batchSize": 100,
  "maxRecords": 1000,
  "maxFiles": 500,
  "maxHashBytes": 104857600,
  "localOrigins": ["http://localhost:5000"]
}
```

The fixture envelope is `{ "synthetic": true, "complete": true, "collections":
{ "plantingReports": { "report-id": { ... } }, ... } }`. `complete` is an explicit
operator assertion, not a production provenance guarantee. Optional `verifiedCloud`
contains canonical-reference SHA-256 proof digests ONLY for trusted synthetic tests.

```powershell
node scripts/scanHistoricalEvidence.js --config C:/approved-synthetic/config.json
```

For the emulator source replace `source` with:

```json
{ "mode": "firestore-emulator", "namespace": "scan6b-<fresh UUID>-", "complete": true }
```

The namespace must be a real lowercase UUID, not the literal placeholder. All fixture
document IDs and their relationships must use that run's prefix. This avoids scanning
shared deterministic fixtures. The factory requires these child-process values:

```powershell
$env:NODE_ENV='test'
$env:MENRO_INTEGRATION_TEST='true'
$env:GCLOUD_PROJECT='demo-menro-phase2'
$env:GOOGLE_CLOUD_PROJECT='demo-menro-phase2'
$env:FIREBASE_PROJECT_ID='demo-menro-phase2'
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
```

Do not load a real .env or credentials. Credential/config environment variables fail
closed; clear them only in the separately authorized synthetic test CHILD process,
never from production or another running process. The scanner does not need a Storage
host/provider, Auth client, upload root override, authenticated user or HTTP server.
Use existing emulators only after confirming project/loopback ownership. Do not run
this scanner through a CLI wrapper that injects ambiguous FIREBASE_CONFIG.

### Batching, resume and output contract

Add `checkpointFile` to the config to resume. Policy/source identity, root/output
identity, origin mapping, completeness assertion and synthetic proof list must match.
Batch size and per-run budgets may change without changing document ordering.
Checkpoints retain normalized records, necessary document-ID cursors, per-record
digests, file stamps and cached integrity results; never raw source documents.
Previous prefixes are re-read and compared against newly normalized records before
continuing, including empty completed collections. Changed inputs/files or malformed
checkpoints fail closed, rather than producing silently double-counted results.

Reference totals are rebuilt from normalized records on every run, NOT added to
previous report totals. Inventory and hash state use opaque canonical path keys.
File inventories are checked again before output. Unhashed files can be retried with
an increased byte budget; a single file must fit that run's remaining budget. No
partial hash is presented as a complete checksum. Read errors are retryable only
while the source snapshot remains compatible. Hard-cap exhaustion requires a new
explicit partition; do not keep replaying a non-resumable 10,000-record checkpoint.

Reports contain overall metrics and per-workflow primary classes, pseudonymous edge
findings, file findings, duplicate path groups, limits/usage, source completeness,
hash coverage, artifact names and limitations. `businessRecords` includes only the
three business collections; `allRecords` includes relationship/registry documents.
`uniqueLocalFilePaths` is inventoried filesystem candidates; `referencedLocalFilePaths`
also includes missing referenced paths. `bytesInspected` unions fully hashed path
bytes, while `usage.bytesHashedThisRun` records actual read budget consumption,
including a failed inspection. `bytesEligible` unions ELIGIBLE paths only, not aliases
or duplicate-content/review candidates. No content checksum is a personal-data export.

Output is restricted to the separate approved existing directory (no symlinked
ancestors or nested overlap with evidence). Private-permission, exclusive pending
artifacts are synced then hard-linked exclusively to unique final JSON names. Existing
reports cannot be overwritten. Only the scanner's own pending link is removed; source
files are never removed. Interrupted writes can leave a `.pending` artifact or a
checkpoint without its report; there is no automatic cleanup/reconciliation worker.
Filesystems without hard-link support fail safely; no unsafe overwrite fallback.

## Executed verification — 20 October 2026

Used Node 22.14.0 and the already-existing clean npm-ci test copy:
`C:/Users/chuak/AppData/Local/Temp/menro-storage-phase2-e4bcb0495c8b42229e36b348b9faa90b`.
No package installation or node_modules replacement occurred. Current scanner source,
tests and CLI were synced into that copy. Existing workflow source was unchanged.

Commands (from the clean copy; use the demo-only child environment above for the
scanner integration; counts overlap and must not be summed as unique test cases):

```powershell
node --test --test-reporter=spec tests/historicalEvidenceScanner.test.js tests/integration/historicalEvidenceScannerEmulator.test.js
node --test --test-reporter=spec tests/*.test.js
```

The existing Phase 5 workflow command used its documented demo Storage child gate,
a unique MENRO_UPLOAD_ROOT and fresh UUID users/records/images. The other Storage
commands used provider local and the cloud-workflow gate UNSET. All use only demo
loopback hosts. The CLI starts/stops its OWN Storage emulator, not shared Auth/Firestore:

```powershell
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/evidenceWorkflowEmulator.test.js"
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/firebaseEvidenceStorageEmulator.test.js tests/integration/firebaseEvidenceRetrievalEmulator.test.js tests/integration/evidenceUploadQuotaEmulator.test.js tests/integration/storageConfigurationEmulator.test.js"
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test --test-reporter=spec tests/integration/firebaseEvidenceStorageEmulator.test.js"
git diff --check
```

| Final executed suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| New scanner unit + CLI | 34 | 0 | 0 |
| New scanner Firestore emulator | 7 | 0 | 0 |
| Combined scanner acceptance | 41 | 0 | 0 |
| Full backend root suite | 336 | 2 | 0 |
| Existing authenticated Phase 5 API/Storage workflows | 13 | 0 | 0 |
| Existing combined Phase 1–4 integrations | 35 | 1 | 0 |
| Additional native precondition diagnostic rerun | 14 | 1 | 0 |

All six new JavaScript files pass node --check. git diff --check and explicit
new-file trailing-whitespace checks pass. There is no frontend change/build.
The full-root suite includes configuration/isolation, local evidence access,
upload/retrieval adapters, quota, planting/guest, early/official/revision workflow,
analytics, notification, proxy and upload-security regressions.

The scanner tests cover the 25 requested categories plus source-drift and immutable
memory snapshots, real source schemas for registered/guest attribution, cloud-context
checks, hash conflicts, revision/date ambiguity, exclusive output and CLI execution.
The integration suite compares actual persisted namespaced documents before/after
scanning, proves no Storage/business-initializer modules loaded, and checks source
drift separately through an explicitly task-owned fixture mutation. Its fixture
writer is NOT part of the scanner. No shared collections were reset or deleted.

Known independent failures remain unchanged:

- `tests/connectedWorkflow.test.js:124` and `:211` use release date 2026-10-19;
  SCHEDULE_STALE is correct on 20 October. No fixture/business rule was changed.
- `tests/integration/firebaseEvidenceStorageEmulator.test.js:102` still fails
  `Missing expected rejection`: multipart ifGenerationMatch=0 is transmitted but
  CLI 15.31.0 replaces the synthetic object. The native diagnostic still reports
  generationChanged=true and originalBytesIntact=false. No real GCS acceptance.
- Credential-metadata probes blocked by existing integration HTTP guards and Java
  rules-runtime NullPointerException during CLI shutdown are reported separately.
  The scanner's dedicated explicit-credential reader does not require ADC discovery.

Diagnostic iterations were not counted as final passes: first scanner run exposed
Windows lstat dev=0 versus descriptor volume ID (corrected within the new scanner);
a clean-copy CLI test initially lacked its scripts directory (temporary harness
copy corrected). Final scanner acceptance passed after both corrections.

### Synthetic dry-run results

The unit/CLI fixture has 4 examined documents, 1 business report, 1 evidence edge,
1 local path, 1 content, 68 hashed bytes and 68 ELIGIBLE candidate bytes. No missing,
duplicate, invalid or blocked reference; zero orphan files. This is NOT historical
data and does not certify a real production evidence file.

The isolated emulator fixture has 9 examined documents, 5 business records,
11 reference edges (1 planting, 1 contribution, 1 early, 2 official, 6 revisions),
1 local path, 1 content, 68 hashed bytes and no duplicate-content group. Shared
references/revisions do not multiply physical-file counts. All live-emulator edges
remain reviewable (LIVE_SOURCE), eligible bytes are 0 and orphan count is null.
The intentionally absent parent relation remains visible in diagnostics. Actual
source document digests and original synthetic bytes match before/after scanning.

## Limitations and Phase 6C gate

- No production source, backup, historical-file completeness, deployed disk/IAM,
  object generation/privacy or official record accuracy has been verified.
- Live emulator reads are not one consistent database/filesystem snapshot. Prefix
  validation detects prior-prefix drift on resume, not every possible concurrent
  mutation after a read. Use an offline access-controlled snapshot for certainty.
- All symlinks are rejected, including in-root aliases. Strict current writer path
  patterns may flag older conventions for manual review. No remote URL is fetched.
- Signature/hash inspection does not decode pixels, verify EXIF/GPS, compare decoded
  dimensions or authenticate capture history. It must not replace existing upload
  verification or future migration acceptance checks.
- Portable Node cannot fully defeat hostile ancestor replacement without OS-level
  snapshot/permissions, nor prevent OS-managed access-time updates. No explicit
  timestamp, content or metadata write is made to evidence.
- Limits are deliberate; large sources need explicit partitions/future approved
  indexing tooling. Pseudonymous checkpoints remain private operator artifacts;
  checksum validation is corruption detection, NOT an authenticity signature.
- Minimal parent/actor/event graph validation is not a full municipal business-data
  integrity audit. Unknown/legacy context remains reviewable; no inferred repairs.
- Existing two stale-date failures and native emulator immutability failure remain
  visible. Full production/cloud migration acceptance is NOT claimed.

Phase 6B is locally verified within this read-only synthetic/emulator scope.
Phase 6C may be PLANNED only after explicit approval. Controlled migration tooling
still requires approved immutable source snapshots/backups, source/context policy,
additive binding/ledger and recovery design, migration accounting, real-service
create-only/private-access acceptance and separate migration authorization.
No Phase 6C, migration, cleanup or cloud activation was implemented.

Branch remains fix/validated-survival-analytics; nothing staged or committed. All
preexisting tracked/untracked work remains. No push/fetch/pull, branch/history
operation, deployment, production access, environment/rules/IAM/billing change,
dependency update, frontend edit or scheduler activation occurred. Only new scanner
files plus this document were added. Shared Firestore/Auth processes are preserved;
task-owned temporary Storage/server processes have stopped. Generated scanner
reports exist only in task-owned synthetic temporary output, not historical uploads.
