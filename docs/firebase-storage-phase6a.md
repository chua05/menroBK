# Phase 6A — historical evidence audit and dry-run migration design

Audit date: 20 October 2026, Asia/Manila. Repository:
`C:\Users\chuak\Desktop\menrobackend`. Branch: `fix/validated-survival-analytics`.

## A. Executive summary and evidence levels

Historical migration PLANNING is feasible. Actual historical evidence is **NOT
cleared for migration**: no production record/file reconciliation, backup restore,
IAM check or real-service immutability acceptance was performed.

**Historical file availability cannot be verified from this repository.**
Locally present files are inventoried below, but their production provenance and
business linkage are unknown. Absence of local monitoring files does NOT establish
loss of monitoring evidence on Render or in backups.

This phase created this document only. No scanner, migration command, source/test
change, upload, Firestore request, application import/startup, worker, emulator,
dependency installation or production inspection was executed.

Evidence levels used throughout:

- **SOURCE VERIFIED**: current source and static synthetic fixtures, not live data.
- **LOCALLY MEASURED**: bounded local filesystem metadata/signature/hash reads.
- **PREVIOUSLY REPORTED**: test outcomes in Phase 1–5 documentation; not rerun here.
- **NOT VERIFIED**: production runtime, database contents, historical completeness,
  deployed IAM/rules/disks/backups or real-service behavior.

Phase 1–4 documents describe their historical infrastructure-only stages. Current
Phase 5 source supersedes their statements that no business routes call Storage:
cloud workflows now exist, but only behind the explicit demo/emulator gate.
Production remains blocked in source. This is not verification of deployed code
or deployed environment values.

## B. Evidence source inventory — SOURCE VERIFIED

| Location/convention | Source anchor | Meaning |
| --- | --- | --- |
| `path.resolve(process.cwd(), "uploads")` | `src/config/integrationEnvironment.js:44`, `src/config/uploadRoot.js:3` | Normal local evidence root; depends on service working directory |
| `<UPLOAD_ROOT>/planting-reports/<participantId>/<milliseconds>-<UUID>.<ext>` | `src/services/fileStorage.service.js:94` | Shared writer for registered planting reports and guest contributions |
| `<UPLOAD_ROOT>/monitoring/<reporterUid>/<milliseconds>-<16 hex chars>.<ext>` | `src/services/monitoring.service.js:263` | Early/official monitoring and replacement writer |
| Explicit dedicated temp upload root | `src/config/integrationEnvironment.js:44` | MENRO_UPLOAD_ROOT applies in integration mode only; requires a dedicated directory beneath system temp |
| System temp `menro-evidence-read-*` | `src/services/firebaseEvidenceRetrieval.service.js:168` | Private temporary retrieval staging, NOT an authoritative historical source |
| `tests/integration/fixtures/` | `tests/integration/generateEvidenceFixtures.js` | Synthetic generated camera/evidence fixtures; not historical production evidence |

Both local writers write the original validated `file.buffer` directly with
`fs.writeFile`; they do not resize, transcode or remove EXIF. Planting extensions
come from supported MIME, or allowed filename extension for generic octet-stream;
monitoring uses the uploaded extension or .jpg default. Existing validation is
upstream: an extension alone is not proof of real content type.

Planting `filePath` is relative (`planting-reports/...`); `photoURL` is a BACKEND_URL
URL containing `/uploads/`. Production requires BACKEND_URL for link creation.
Monitoring `photoUrl` is a relative `/uploads/monitoring/...` URL. Storage root
selection is not inferred from URL authority, names, or the frontend domain.

Auth profile photoURL fields (`auth.service.js`) are external profile pictures,
not planting/monitoring evidence. Generated fixtures and retrieval staging must
not be combined with historical upload inventories. Repository-wide service
writer search found no other permanent image-evidence writer in this scope.

### Write, replacement and failure behavior

- Planting/guest photos are written before their Firestore business transaction.
  Failure paths attempt local cleanup (`plantingReport.service.js:1729`,
  `plantingEvidence.service.js:251`).
  Process termination, partial filesystem writes, cleanup failure or uncertain
  commit acknowledgements can still leave missing/unlinked/inconsistent files.
  Neither filename nor existence proves durable business linkage.
- Monitoring saves before its submission transaction (`monitoring.service.js:332`)
  and deletes the new local file on caught failure (`:567`). Replacement saves
  before correction commit (`:813`); a failed correction unlinks only its new
  target (`:978`). Successful replacement does not delete earlier evidence.
- Count/remarks corrections reuse an evidence revision; multiple revision rows
  may intentionally reference the SAME file. Revision count is not image count.
- Cloud workflows keep uncertain/unlinked uploaded objects and quota charges;
  operation completion and LINKED intents commit with business writes. There is
  no automatic cloud object deletion. This audit makes no orphan determination.
- There is no historical binary recovery implementation in these services.
  Metadata, GPS, filenames and checksums cannot reconstruct missing image bytes.

## C. Code-derived Firestore reference map

These are code-defined schemas, **not production-data verification**.

| Collection/shape | Evidence reference locations | Relationships and invariants |
| --- | --- | --- |
| `plantingReports/{id}`, standalone/legacy | `photos[i].photoPath`, `photos[i].photoURL`; top-level `photoPath`, `photoURL` primary aliases; imageHash/imageHashes | participantId, distributionId/requestId, eventId, siteId/barangay, plantingDate, quantityPlanted, verification/staff-review metadata |
| `plantingReports/{id}`, `reportType: parent` | Display photos are dynamically aggregated; do not assume returned photos[] are a stored parent array | requestId, eventId, original requester, quantity/review summaries; canonical image owner is the contribution |
| `plantingContributions/{id}` | `photos[i].photoPath`, `photos[i].photoURL`, imageHashes; optional privateEvidence inside each photo | reportId → parent, eventId, participantId, contributorId, participantType, inventoryId, quantity, recordedAt, evidencePending, allocationReserved, verification/staff-review fields |
| `eventParticipants/{id}` | No primary image bytes/reference | Event-scoped guest identity/session hash/expiry or registered user association; contributor attribution must be preserved independently of current session validity |
| `monitoringRecords/{lifecycleId}` | `history[j].photoUrl`, `history[j].privateEvidence`; `history[j].revisionHistory[k].evidenceRef.photoUrl` / `.privateEvidence` | plantingReportId, participantId = cohort owner, siteId, eventId, quantityPlanted, lifecycle dates; history[].id = immutable observation ID |
| Legacy flat `monitoringRecords/{id}` | Legacy root photoUrl plus legacy observation fields | Presentation may synthesize a grouped lifecycle; those presentation IDs are NOT real Firestore document paths |
| `plantingEvidenceHashes/{sha256}` | Registry, not another image | reportId, optional contributionId/eventId, createdAt |
| `monitoringEvidenceHashes/{sha256}` | Registry, not another image | lifecycleId and, for replacement, observationId; initial submissions also record reporter identity |

Planting photo metadata includes imageHash, imageDetails (format/dimensions),
metadata GPS/captured time, uploadedAt, gpsMetadataPresent/gpsValid, timestamp
findings, site distance/coverage/match, municipalityScope, suspiciousFlags and
automatedStatus. Root fields duplicate selected primary-photo findings. Preserve
all fields, including unknown older fields; do not regenerate verification status
using today's rules during a byte migration.

`parentPlantingReport.service.js:131–166` loads contributions by reportId, filters
rows with photos, then flattens each existing photos array. There is no explicit
orderBy there. Preserve the observed contribution/document ordering plus original
photo-array ordinal; do not invent recordedAt sorting. Phase 5 derives the expected
cloud contribution context from the source contribution (`_evidenceRecordId`).
Treat parent views, root primary aliases and nested contribution photos as edges
to canonical evidence, not additional physical images or new upload jobs.

Guest ownership is established by the validated session's participantId/eventId,
not a submitted contributor ID (`guestEvent.service.js:212`,
`plantingEvidence.service.js:14`). Existing contribution creation has its own
optional submissionKey (`plantingContribution.service.js:10`). Do not confuse
that with the Phase 5 upload Idempotency-Key. Migration must not invent guest UIDs,
require a historical guest to sign in again, or copy session tokens into manifests.

### Monitoring chronology, ownership and revisions

`monitoring.service.js:417–527` stores workflowVersion, observationType (early or
official), originalReporterId/monitoredBy, monitoredDate/monitoredAt, totalMonitored,
cohortQuantityAtObservation, full/partial flag, healthy/damaged/dead counts,
survival/mortality findings, GPS/capture audit, reviewStatus/reviewVersion,
revisionNumber/currentEvidenceRevision, Staff/Admin metadata and auditHistory.
There is no universally sufficient standalone monitoring-cycle ID: retain the
cohort/lifecycle, observation type/date and scheduling fields as they stand.

`resubmitMonitoringObservationImpl` (`:769` onward) preserves observation ID,
appends revisionHistory and auditHistory, and stores each revision's evidenceRef.
Reused evidence retains its evidenceRevision; replacement uses the new revision
number. Latest observation photoUrl/privateEvidence mirrors the chosen revision.
Migrate ALL retained revision references, not just latest history entries, and do
not count count-only reuse as a second file. Do not reinterpret early as official,
partial as full coverage, or legacy Reviewed/Validated as Admin approval.

Legacy consolidation (`monitoring.service.js:575` onward) builds virtual groups
and public presenters remove private fields. A future scanner must inspect raw
snapshot documents, not HTTP presentation output or getAllMonitoringRecords:
presentation hides references, may filter archived rows and loses write targets.
Missing/duplicate observation IDs or revision identities require conservative
review; do not assign new historical observation IDs just to fit the cloud adapter.

### Cloud infrastructure already present — SOURCE VERIFIED

- `privateEvidence` holds provider=firebase, storageVersion=1, bucket, objectName,
  generation STRING, contentType, format, sizeBytes, sha256, uploadIntentId and
  uploadedAt. Current paths are `evidence/v1/{type}/{recordId}/{intentUUID}`.
  Planting uses the real report/contribution; monitoring uses observation ID.
- `evidenceUploadIntents`: actor/type/record binding, original hash/size/type,
  private verificationJson, RESERVED/UPLOADING/UPLOADED/LINKED/RECONCILIATION_REQUIRED
  state, lease, attempt count, generation/reference, quota day/actor and failures.
- `evidenceQuotaReservations`, `evidenceQuotaDays`, `evidenceQuotaAudit`: per-actor
  Manila admission-day limits, reserved/finalized bytes/files, attempts, generations
  and audit entries. These are not an inventory of historical local evidence.
- `evidenceWorkflowOperations`: scoped key/payload digests, durable target and
  intent IDs, fenced lease, RUNNING/RETRYABLE/COMPLETED, business resultLink and
  retain-no-ttl-v1 policy (`evidenceWorkflow.service.js`). Existing live-submission
  idempotency is NOT a historical migration ledger or a migration API.

The current guards reject production cloud workflows; simply setting a production
bucket or invoking existing business POSTs is not a migration path. All current
Storage factories remain demo/emulator-restricted. Their safe primitives may be
reused later, not bypassed during Phase 6B.

## D. Local availability — LOCALLY MEASURED

Only the repository's uploads tree was examined. No user Downloads, temporary
test-copy uploads, Render files, live records or real .env values were inspected.

| Local scope | Regular file paths | Bytes | Distribution |
| --- | ---: | ---: | --- |
| uploads/planting-reports | 237 | 1,606,567 | 9 subdirectories; 236 .jpg (377,437 bytes), 1 .png (1,229,130 bytes) |
| uploads/monitoring | 0 | 0 | No subdirectories |
| uploads root, outside those trees | 1 | 0 | .js file, not image evidence; excluded |

Directory listing had a 5,000-entry budget; no truncation, listing errors or
reparse-point entries were observed. No zero-byte evidence files or unexpected
filenames against the current timestamp/UUID-or-hex conventions were found.
Unexpected names would be review signals, not proof of invalid older records.

A separate read-only SHA-256 pass was permitted only after confirming the entire
candidate set was below an explicit 500-file/10-MiB bound. It read 237 files and
1,606,567 content bytes, with zero read errors. Results:

- 13 distinct content hashes; distinct-content bytes total 1,467,263.
- 6 equal-content groups containing 230 file paths.
- 224 redundant copies relative to one path per distinct content hash.
- The other 7 files are singleton-content paths.
- Bounded header checks found zero JPEG/PNG signature/extension mismatches.

No image, hash value, actor-directory name, filename, personal identifier or GPS
coordinate from these files is published. No EXIF extraction, full image decode,
business-reference match or original-capture authenticity check was performed.
13 distinct contents is NOT 13 valid records; 237 paths is NOT 237 original
production evidence items. Identical bytes do not authorize cross-record merging.
Hard-link/physical-file identity was not audited. These measurements are not a
transactionally consistent snapshot and cannot establish production completeness.

Missing-source, orphan, eligible, already-cloud and metadata-validity COUNTS are
**NOT VERIFIED**, not zero: no authorized historical database snapshot was provided
or queried. Local duplicates might include development/test artifacts; provenance
was not assumed from their small sizes or names.

## E. Render durability assessment — RISK, deployment NOT VERIFIED

No render.yaml/render.yml, Dockerfile, root README, application backup command or
evidence recovery routine was identified in the inspected repository/config/docs.
uploads/ and generated integration fixtures are gitignored. A Git checkout is not
an evidence backup. Node's start command is `node src/server.js`.

Current normal upload root is CWD/uploads. In particular, MENRO_UPLOAD_ROOT is an
integration-only override; setting it on Render alone does NOT relocate normal
production uploads. A future authorized operator must verify the actual working
directory, resolved root and disk mount cover the same directory. Do not assume
a mounted /var/data disk protects a separate CWD/uploads directory.

Render documents an ephemeral default filesystem; only data beneath a persistent
disk mount survives redeploy/restart. See [Render Persistent Disks](https://render.com/docs/disks),
public documentation consulted 20 October 2026. No Render service/dashboard,
filesystem or credentials were accessed. The Markdown documentation endpoint
could not be read by the browsing tool; its official HTML version was read.

Actual disk attachment, mount, snapshots, off-host backups and past evidence loss
are NOT VERIFIED. Missing local files do not establish Render loss. A disk alone
does not prove a verified application-consistent database-plus-files backup.
No disk, backup, transfer, snapshot or restore action is authorized here.

## F. Proposed eligibility matrix and precedence — DESIGN ONLY

Record all diagnostic flags; assign exactly one primary class per logical evidence
reference by this precedence. Separate filesystem-only findings from references.

| Priority | Primary class | Exact proposed rule |
| --- | --- | --- |
| 1 | BLOCKED | Unsafe path/reparse escape; ambiguous/cross-owner binding; verified hash conflict; duplicate observation identity; conflicting cloud/local authoritative references; unknown provider or untrusted project; source changed during scan |
| 2 | REQUIRES_REVIEW | Incomplete graph/export/permissions; ambiguous aliases, legacy schema or ordering; uncertain source provenance; unverified cloud object integrity; missing metadata whose historical requirement is unknown |
| 3 | ALREADY_CLOUD | Explicit structured reference passes schema/context AND independently verified object-generation/hash/private-access evidence from an authorized snapshot/fixture; no upload action. Schema-only matches remain REQUIRES_REVIEW with alreadyCloudCandidate flag |
| 4 | MISSING_SOURCE | Proven local business reference has no file in the explicitly complete authoritative source snapshot. If snapshot completeness is unknown, use REQUIRES_REVIEW, not presumed missing |
| 5 | INVALID_METADATA | Declared fields malformed or inconsistent, unsupported/corrupt bytes, or a known version's required metadata absent; retain original facts and diagnostic flags without rewriting review results |
| 6 | DUPLICATE_CONTENT | Otherwise sound local source shares SHA-256/size with another source path. Keep each authorized reference; no automatic merge/upload sharing |
| 7 | ELIGIBLE | Complete graph, safe resolvable source, original bytes available, required metadata/hash/context consistent and no higher-priority exception |

ORPHANED_FILE is a filesystem-only classification: a safe local candidate has zero
reference edges after a COMPLETE authorized scan of all raw relevant collections,
archives and revisions. Until then call it UNMATCHED_CANDIDATE/REQUIRES_REVIEW.
It does not authorize deletion. A many-reference shared file is not orphaned.

Duplicate content is also a secondary cross-cutting flag: higher-priority problems
must not disappear into a duplicate group. Preserve separate counts for references,
canonical file paths, content hashes and potential physical-file aliases. Missing
bytes remain unrecoverable unless a genuine authorized backup/original is found;
metadata must never be used to synthesize a replacement original.

## G. Future read-only dry-run scanner — DESIGN, NOT IMPLEMENTED

### Inputs and isolation

Require an explicit versioned offline JSON/JSONL snapshot plus explicit read-only
evidence root and origin/path mapping. Do not auto-discover .env, ADC, live project
or working-directory uploads. Optionally support an explicitly selected demo
emulator read source, pinned to the existing approved loopback project/hosts;
offline should be default. Never import server.js, app.js or existing business
services: they may initialize credentials, aggregate/filter records, or stage files.
Do not follow stored URLs or query production. Future production exports require
separate operator authorization and secure handling; none were obtained here.

### Bounded traversal and reference identities

1. Validate snapshot version/completeness, root realpath, allowlisted local schemes,
   privileges and budgets before reading records. Reject path traversal, nulls,
   encoded separators, cross-root/case-collision ambiguity and symlinks by default.
   Preserve original path text in a restricted manifest; never strip arbitrary
   filesystem prefixes or turn a remote URL into a network fetch.
2. Enumerate raw plantingReports, plantingContributions and monitoringRecords;
   include archived/rejected records, all observations, and EVERY revision.
   Resolve necessary event/site/participant relationships from snapshot maps.
   Do not use public presenters or count hash registries as extra images.
3. Use canonical document path + stable observation/revision identity + photo-array
   ordinal where no immutable photo ID exists. Keep aliases as edges to canonical
   evidence. For flat legacy records retain actual document ID/field pointer;
   never persist a synthesized lifecycle ID as a write target.
4. Offline inputs use a fixed snapshot digest and record/byte offsets. Emulator
   reads use document-ID ASC ordering, startAfter(lastDocumentId), limit 100;
   do not order by optional dates that exclude old records or use unbounded get().
   Separate per-collection checkpoints avoid skipping equal timestamps entirely.
5. Bound runs to an explicit record/page/byte/time budget (initial suggestion:
   1,000 documents, 100 MiB read bytes, 60 seconds; caller can lower these).
   Stream hashes in 64-KiB chunks and process one image at a time. No decoder or
   EXIF parser by default; later approved decoding needs isolated resource limits.
   Do not implement on-the-fly upgrades or new dependencies to inspect images.
6. Emit deterministic classifications, completeness flags, reasons, cursor and
   input/policy digests. Budget exhaustion means INCOMPLETE, not zero unresolved
   items or a proven orphan count. On resume reject changed roots/input digests
   or stale checkpoints. Live concurrent reads are not a point-in-time snapshot.
7. Large global indexes/duplicate grouping require a bounded on-disk sort/index
   in an explicitly approved report scratch directory, never unbounded RAM.
   Future checkpoints/report artifacts may be written ONLY to a separately
   approved output directory, not evidence or Firestore. Source scanning remains
   read-only. This phase did not implement or create such artifacts.

Read-only means no upload, create/update/delete/transactional write, record repair,
quota reservation, cleanup, automatic alias correction or migration side effect.
Expose only a narrow read interface to a future emulator client; add tests proving
mutating methods are never invoked. Classification cannot fetch private cloud
objects in a production scan; absent trusted verification manifests, classify
cloud schema candidates as REQUIRES_REVIEW instead of fabricating acceptance.

### Report shape

Propose runId/policyVersion/inputDigest/rootAlias, startedAt, finishedAt,
complete/incomplete reason, nextCursor, limits/usage and workflow breakdowns.
For each workflow and total report: referencesExamined, uniqueSourceFilePaths,
distinctContentHashes, eligibleReferenceCount, eligibleUniqueFileCount,
missingSourceCount, orphanedFileCount (or null/unverified), duplicateGroupCount,
duplicateFileCount, duplicateReferenceCount, invalidMetadataCount,
alreadyCloudCount, requiresReviewCount, blockedCount, eligibleUniqueBytes,
unresolvedKnownBytes and unresolvedUnknownSizeReferenceCount.

Count primary reference classes once; orphan counts belong to the file inventory,
not that reference-class sum. Byte totals use unioned canonical source identities,
not sums of aliases/revisions. Mixed eligible/blocked references to one file need
an explicit shared-context flag; do not add the bytes twice. Missing file sizes
are unknown, not zero. Persist a restricted edge manifest for audits and an
aggregate redacted report for sharing. No raw paths, personal IDs or GPS in logs.

## H. Future migration and recovery strategy — NOT AUTHORIZED TO RUN

1. Obtain an authorized consistent record export and byte-preserving evidence
   snapshot, including ALL old revisions. Encrypt/access-restrict both. Test
   restoration into an isolated read-only audit copy; record checksums and custody.
   Do not take an unverified Git checkout or database-only backup as sufficient.
2. Run the approved future scanner offline; reconcile missing, ambiguous, unsafe,
   duplicate-content and legacy-context items. MENRO approves exceptions; no
   invented metadata, retrospective verification/approval or automatic merge.
3. Prefer **additive private migration bindings** in a separate future ledger,
   keyed by canonical business-reference identity and original source fingerprint.
   Preserve historical business documents/local references unchanged. Current
   code does NOT resolve such sidecars; a future authorized resolver change and
   acceptance tests are prerequisites. Alternative additive privateEvidence
   updates require explicit approval and exact transactional CAS, not rewriting
   historical arrays from an old export. Neither option is implemented here.
4. Use a dedicated durable migration-operation ledger (not live POST idempotency):
   immutable source/context/hash/type/size identity, stable intent UUID, lease
   token/version, planned target, actual generation, validation/backup evidence,
   original reference snapshot and append-only action/outcome audit. Suggested
   states: PLANNED → SOURCE_VERIFIED → UPLOAD_RESERVED → OBJECT_VERIFIED →
   BINDING_COMMITTED → ACCEPTED; failures become RECONCILIATION_REQUIRED/BLOCKED.
   No TTL/key reuse; retries inspect the same intent and generation. Do not put
   volatile document updateTime in the idempotency identity and create new uploads
   whenever an unrelated record field changes.
5. Upload exact original bytes only through a separately approved immutable
   migration adapter. Do not call planting/monitoring submission endpoints:
   they enforce current event schedules, duplicate rules, notifications, counts
   and review transitions. Preserve original reporter/guest/cohort attribution;
   a migration operator is not the historical submitter. Keep cloud uploadedAt /
   migratedAt separate from original capture/upload/review timestamps.
6. Resolve historical quota/accounting policy BEFORE upload implementation.
   Existing admission-day user quotas cannot silently be bypassed, backdated or
   charged as new participant observations. Design an approved bounded migration
   budget/rate ledger, with separate physical-byte accounting and operator audit;
   retain source attribution, existing quota ledgers and user business policy.
7. Storage upload/generation/size/SHA/private metadata checks occur OUTSIDE
   Firestore transactions. Commit the verified binding and migration ledger
   atomically, after rereading actual target/context/source fingerprint and
   version/updateTime preconditions. Preserve concurrent review/correction and
   unknown fields; block stale reference changes, never overwrite newer history.
8. Count a VERIFIED binding as accepted only after authenticated retrieval,
   expected immutable observation/revision association, original-byte comparison
   and unchanged business/analytics snapshots. Copying one image must not rerun
   quantity totals, schedules, Staff/Admin decisions or notifications.
9. On upload success/commit failure, retain the object/intent and retry the same
   ledger identity. On lost commit acknowledgement reread the binding/ledger;
   do not upload again. Missing/corrupt generations and unavailable services
   require safe reconciliation, not an arbitrary latest-generation/local fallback.
   No automatic quota release or source/cloud deletion on timeout, age or 404.
10. Rollback is an explicit audited binding deactivation to the preserved,
    checksum-verified local source, or forward recovery to the verified object.
    Do not restore whole stale business documents or delete objects/revisions.
    Preserve failed bindings and prior audit records. If local bytes are not
    verified, rollback is not available; stop rather than inventing evidence.

Evidence reused within one observation's count-only revisions should map all
edges to its original evidence identity. Cross-report/guest/observation identical
bytes must NOT automatically share an object: ownership, retention and current
type/record-path constraints differ. Preserve the duplicate registry rather than
overwriting hash-owner rows to make migration pass.

## I. Security and privacy

Existing authenticated evidence routes (`routes/evidence.routes.js:10`) authorize
record ownership/contribution/reporting before file resolution. Staff/Admin
retain their existing access; ordinary cohort ownership alone does not grant
historical revision access (`evidenceAccess.service.js:175`). Expired guest
sessions do not imply absent historical contributor identity. Never make a guest
upload/retrieval public or use client-supplied storage paths as migration authority.

The future binding resolver must reauthorize the real business record BEFORE
looking up a binding, validate its immutable context, and retain private/no-store
streaming and response redaction. No Firebase download tokens, public ACLs,
permanent URLs, arbitrary bucket access or silent fallback. Admin SDK bypasses
client rules, so least-privilege operator IAM and server authorization are both
required. New ledgers and manifests must not be client-readable.

Stored EXIF/GPS and reviewer/reporter identities are sensitive. Keep full forensic
metadata in restricted backups/manifests only; publish aggregate counts and opaque
reference IDs. No raw images, tokens, credentials, private paths or personal
directory names were included in this audit. Read failures/permission problems
are unresolved, not evidence of absence. A checksum proves equality, not camera
authenticity, verified planting or official boundary correctness.

## J. Production blockers and compatibility risks

- Real-service create-only preconditions have NOT been accepted. The known
  CLI 15.31.0 multipart ifGenerationMatch=0 failure remains; do not weaken its test
  or equate emulator adapter behavior with real GCS immutability.
- Production Storage IAM/rules, Firestore ledger client restrictions, bucket
  retention/generation availability and deployed code/environment are unverified.
- Actual historical source completeness, file-to-record matches and Render
  mount/backups are unverified. No current local file is certified ELIGIBLE.
- Backup/restore and a tested record-plus-file recovery procedure are required.
- Current cloud adapters reject production operation; historical bindings,
  legacy routing/ID compatibility, CAS migration tooling, migration-budget policy
  and safe operational reconciliation require separately approved implementation.
- Future validation must handle unsupported formats, oversized/pixel-heavy older
  images, inconsistent hashes, unknown legacy IDs/ownership, document/array size
  limits, overlapping aliases/revisions and Windows/Linux path differences.
  Never change records to make them fit current 128-character/path constraints.
- No automatic source cleanup is permitted. No retention/backup TTL decision is
  approved; bounded disk/temp/egress costs and private staging crash residue need
  operational review. User upload quotas are not a hard total cloud billing cap.
- Actual authenticated cutover and full byte/graph/audit/analytics equivalence
  acceptance, plus explicit production/migration authorization, remain required.

## K. Phase 6B readiness and proposed tests

**Conditionally ready for isolated READ-ONLY scanner implementation planning and
synthetic/offline tests, after explicit authorization. NOT ready for live migration,
production cloud activation or an uploading/cutover tool.**

Potential future files (proposals only; NOT created): a pure historical-reference
extractor/path normalizer, offline scanner CLI, JSON report/checkpoint schema and
focused synthetic unit tests. An emulator read adapter should be optional and
separate. Do not modify business workflows or add production credentials just to
implement a scanner. Quota and legacy-acceptance policy decisions may remain
REQUIRES_REVIEW classifications rather than blocking a conservative offline scan.

Required future tests: root photo alias versus photos[0]; parent/contribution
de-aggregation and stable ordinals; expired guests with preserved identity;
flat legacy records versus virtual lifecycle IDs; early/official and all revision
edges; reused versus replaced evidence; missing files and incomplete exports;
same-content separate owners; conflicting stored hashes; malformed references;
traversal/encoded separators/symlinks/case collisions; unreadable/corrupt/oversized
files; changed-source races; cloud schema-only candidates; page/cursor ties,
checkpoint restart/input drift and budget exhaustion; deterministic counts/unioned
bytes; redaction; zero uploads/Firestore writes/deletes and unchanged source hashes.
Later upload-tool tests must separately cover concurrent workers, lost Storage/
Firestore acknowledgements, stale bindings, quota/accounting, generation mismatch,
all-role retrieval, non-destructive rollback and analytics/notification neutrality.

## L. Git status, verification and scope closure

Initial branch: fix/validated-survival-analytics. Nothing staged. Existing tracked
modifications at audit start (preserved):

```text
.env.example
.env.integration.example
package-lock.json
package.json
src/app.js
src/config/cors.js
src/config/firebase.js
src/config/integrationEnvironment.js
src/controller/evidence.controller.js
src/controller/monitoring.controller.js
src/controller/plantingReport.controller.js
src/middleware/upload.middleware.js
src/routes/guestEvent.routes.js
src/routes/monitoring.routes.js
src/routes/plantingReport.routes.js
src/services/evidenceAccess.service.js
src/services/monitoring.service.js
src/services/parentPlantingReport.service.js
src/services/plantingEvidence.service.js
src/services/plantingReport.service.js
src/utils/imageVerification.util.js
tests/integration/notificationEmulator.test.js
tests/plantingEvidence.test.js
```

Preexisting untracked status groups (preserved): docs/ (Phases 1–5 and boundary
audit), firebase.storage-emulator.json, scripts/audit-barangay-boundaries.py,
scripts/requirements-geo-audit.txt; src/config/{evidenceStorage,evidenceUploadQuota,
trustProxy}.js; src/middleware/privateEvidenceResponse.middleware.js;
src/services/{evidenceRetrievalResolver,evidenceUploadQuota,evidenceWorkflow,
firebaseEvidenceRetrieval,firebaseEvidenceStorage}.service.js; tests/helpers/;
tests/{barangayBoundary,evidenceRetrievalResolver,evidenceStorageConfig,
evidenceUploadQuota,evidenceWorkflow,firebaseCompatibility,firebaseEvidenceRetrieval,
firebaseEvidenceStorage,firebaseStorageTransport,localEvidenceStorageCompatibility,
storageInitialization,trustProxy,uploadSecurity}.test.js; tests/test_boundary_audit.py;
tests/integration/{evidenceUploadQuotaEmulator,evidenceWorkflowEmulator,
firebaseEvidenceRetrievalEmulator,firebaseEvidenceStorageEmulator,
storageConfigurationEmulator}.test.js; tests/integration/storage.deny-all.rules.

Only new audit file: **docs/firebase-storage-phase6a.md**. Frontend was not modified
or run. Existing application/tests/docs/scripts content is checked with a combined
SHA-256 manifest excluding this new document, credentials and fixture images;
the before/after combined hashes MATCHED. Git diff --check and the new document's
trailing-whitespace check passed; no staged files were found. Git status/diff
checks are read-only.

No tests/builds were run in Phase 6A because they may write files, fixtures or
emulator data. Phase 5's documented 13/13 authenticated and 302/304 root results
are historical context, not fresh audit test results. Its two stale-date failures
and the 35/36 native Storage result remain documented limitations, not reclassified
as successes here. Firestore/Render skills guided the source/schema and durability
review; live discovery, provisioning and production inspection were deliberately
not run. Only public Render documentation was retrieved.

No source/test/env/dependency change, file movement/deletion, evidence upload,
Firestore/Storage access, Render access, scheduler, deployment, staging, commit,
push, fetch, pull or branch/history change occurred. This is audit documentation,
not migration tooling or production acceptance. **Stop here; Phase 6B requires
explicit approval.**
