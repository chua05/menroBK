# Firebase Storage Phase 3 — persistent quota and usage preparation

**Firebase Storage is not active for application uploads.**

**Production activation remains blocked pending real-service immutability
verification and later integration acceptance.** No existing upload/retrieval
endpoint calls this infrastructure. Provider stays `local`; Phase 1 guards and
deny-all Storage rules are unchanged. No Phase 4 work is included.

## Pre-implementation audit and scope

Both repositories were inspected on `fix/validated-survival-analytics`, with
preexisting modified/untracked files preserved. No staging or Git history writes.
The Firestore skill guided the transaction/index review; its live discovery and
provisioning commands were intentionally not run because production access and
tool upgrades are forbidden. Production database edition/rules/IAM remain unverified.

Verified controls, unchanged:

- `src/middleware/upload.middleware.js`: 10 MiB/image, up to 10 planting images,
  60 MiB accepted aggregate, three active requests per process, bounded multipart
  fields/parts. Real bytes still pass existing image signature/Sharp validation.
- `src/routes/monitoring.routes.js`: one image per submission/replacement, 10 MiB.
- `src/middleware/rateLimiter.middleware.js`: 20 attempts/actor/15 minutes;
  actor comes from `req.user.uid`, validated guest participant ID, or IP fallback.
  Failed HTTP attempts count. Integration-mode skipping remains unchanged.
- These rate/concurrency controls are process-local, not cross-instance/global.
  This phase does not replace them or count a request a second time.
- `auth.middleware.js` verifies revoked tokens, active profiles and role access.
  `guestEvent.service.js:validateGuestSession` validates the stored guest token
  hash, expiry, revocation, participant kind and eligible event. A guest's stable
  participant ID is event-scoped, not a Firebase UID or a global human identity.
- Phase 2 already has server capabilities, UUID intents, leases, bounded attempts,
  immutable paths, original-byte checks, private references and dry-run reporting.

## Configuration

`src/config/evidenceUploadQuota.js` validates at quota-factory construction before
quota I/O. No change to existing application startup behavior is required.
Only example env files were edited; real environment files are unchanged.

| Variable | Default | Accepted values |
| --- | ---: | --- |
| EVIDENCE_DAILY_FILE_LIMIT | 50 | Canonical positive integer string, at most 1,000,000 |
| EVIDENCE_DAILY_BYTE_LIMIT | 209715200 (200 MiB) | Canonical positive integer string, at most 1 TiB |
| EVIDENCE_GLOBAL_DAILY_ALERT_BYTES | 1073741824 (1 GiB) | Canonical positive integer string, at most 1 TiB |

Zero, negative, fractional, blank, whitespace, exponential, unsafe and excessive
values fail closed. Caps bound arithmetic/configuration mistakes, not a pilot
recommendation to raise limits. Staff and Admin have the same quota as everyone.

Daily keys use `Intl.DateTimeFormat` with `Asia/Manila`, including UTC 16:00
midnight and year/month boundaries. Admission uses the day of the successful
reservation operation. Retry/finalization retain that original day. Old-day
reservations cannot start a NEW object write: unused reservations can be released
and replaced by a new server operation today. Old-day uncertain retries can
inspect/recover an existing object but cannot create a missing one against an
old allowance. A request already in flight across midnight remains associated
with its admission day; this is not a hard physical Storage-commit-time cap.

## Private actor identity and trust boundary

`createEvidenceUploadQuota().serverActor({uid})` or
`serverActor({guestParticipantId})` accepts ONLY a trusted server identity after
existing identity AND record authorization. These are NOT request-body APIs or
authentication substitutes. Unknown fields, role claims and invalid IDs fail.
WeakSet branding rejects JSON copies. Actor keys are SHA256 of a versioned,
namespaced identity tuple; guest/user values cannot collide at the namespace
level. IDs contain a date and hash, not names/emails/phones/UIDs. Hashing is
pseudonymization, not a substitute for private Firestore permissions.

The adapter's serverContext supports the existing `{uid}` and new internal
`{guestParticipantId}` shapes, not both. Guest sessions retain their existing
authorization model and do not need a Firebase UID. Event-scoped guest identities
cannot enforce a cross-event per-human quota; no new identity collection or
phone-based global identity was invented. Future integration must assess guest
registration abuse separately.

No unlimited role exemption exists. If a campaign requires an override, obtain
MENRO approval for a bounded policy ledger keyed by actor hash + campaign,
with limits, expiry, reason, approving administrator and policy version. Reserve
that policy version transactionally with each operation. No override endpoint,
role exemption or campaign policy implementation is authorized in this phase.

## Firestore model

All current factories are restricted to demo project + approved emulator hosts.
Existing production collections are not read, written, migrated or activated.

| Collection | Identity and contents |
| --- | --- |
| evidenceQuotaDays | `YYYY-MM-DD_actorHash`: reservedFiles/Bytes, finalizedFiles/Bytes, uploadAttempts, uploadRetries, failedUploads, outstandingReconciliations, actorKey/day, updatedAt |
| evidenceQuotaReservations | Same UUID as upload intent: reservationId/uploadIntentId, actorKey/kind, day, expectedFiles/Bytes, actualFiles/Bytes, state, version, createdAt/updatedAt, last attempt/failure, reconciliation flag, generation, finalizedAt/releasedAt; objectCreatedAt/observedStorageDay when safely available |
| evidenceQuotaAudit | `reservationUUID_version`: append-only action/state/version/day/actorHash/time; no image, GPS, credential or private object path |
| evidenceUploadIntents | Existing Phase 2 schema plus actorKind, quotaVersion=1, quotaActorKey, quotaDay; existing ownership and verification fields preserved |

Reservation states: `RESERVED -> FINALIZED`, unused `RESERVED -> RELEASED`, and
`RESERVED -> RECONCILIATION_REQUIRED -> FINALIZED` after actual verification.
A finalized reservation may carry a reconciliation flag after a later object
integrity/access failure; its already-confirmed charge is not reversed.

Each adapter intent represents ONE original image object. Multiple images use
separate intent/reservation operations. Quota admission can account estimates
up to existing per-request file counts, but the adapter/finalizer handles one
verified object per intent; batch finalization is not an exposed workflow.
New objects count one actual original-byte size. Verified reuse of that same
intent/object counts zero additional files/bytes. A new replacement context
creates a new object/charge while retaining prior evidence. This is not
cross-record hash deduplication.

No composite index is needed for current quota operations: exact document reads,
and bounded day-prefix ranges on `FieldPath.documentId()`. No index deployment,
TTL, rule, IAM or database configuration changes were made. Production client
Firestore rules must deny access to the new private ledgers before any later
integration; those live rules are NOT VERIFIED. Admin access bypasses client
rules and therefore still depends on server authorization and IAM.

## Transaction boundaries and recovery

1. Existing buffer validation runs before quota admission.
2. One Firestore transaction reads the existing intent, reservation and actor-day
   counter, validates ownership/amount/day, checks reserved + finalized usage,
   then writes the quota reservation/counter/audit AND new intent atomically.
   Neither half can commit alone. Identical retries do not charge again;
   conflicting actor/day/count/bytes fail. Fresh operations cannot choose old days.
3. Upload lease acquisition and quota attempt accounting share a transaction.
   Cross-process counters and intent leases, not process memory, enforce capacity.
4. Storage metadata/upload/download/hash checks occur OUTSIDE transactions.
   Original CRC32C/create-only options and Phase 2 bounded timeouts are retained.
5. After actual byte, generation, metadata and ownership verification, final
   quota movement and UPLOADED intent state commit in one transaction. Retries
   and lost acknowledgements cannot double-finalize. Counter arithmetic fails
   closed on negative, malformed or unsafe integer results.
6. Ambiguous outcomes preserve reserved usage and reconciliation metadata. If
   Firestore itself is unavailable, the original reservation/lease survives for
   restart recovery. Failed-operation metrics can persist only when Firestore
   accepts the write; an unavailable ledger cannot record every failure instantly.

There is **no** blanket release after a timeout/503/412 or after seeing a 404:
a late upload might still complete. `releaseUnused(context,id)` is safe only
when transactional intent/reservation history proves no upload was ever
attempted, with no reference/generation/lease or reconciliation uncertainty.
Release updates the intent to RELEASED and is idempotent. Pre-admission validation
or atomic reservation failure consumes no quota. An uploaded/attempted/linked/
retained-revision object cannot be released through this path. Raw SDK errors
are replaced by fixed safe categories; no new public responses or endpoints exist.

`quotaReconciliationReport(context,ids)` is bounded to 100 exact UUIDs and
cross-checks intent state. A 15-minute stale flag applies to unresolved rows,
not completed historical usage. It performs no writes, release or deletion.
Existing Phase 2 reconciliation can inspect actual object generation and hash;
an authorized retry through upload is the idempotent recovery/finalization path.
Age alone never frees uncertain capacity. No cleanup scheduler or deletion API.

Legacy Phase 2 intents lacking quotaVersion remain readable/reportable but new
quota-aware upload/reserve attempts fail `LEGACY_INTENT_REQUIRES_RECONCILIATION`.
No historical usage is invented, backfilled or silently charged. A separately
approved policy is needed before resuming such old intents. Existing application
records are local evidence records and are not converted to this schema.

## Usage monitoring and cost limitations

No single global write hotspot was added. The per-actor daily ledger and
append-only reservation audit provide finalized/reserved files and bytes,
processing failures, recovery retries and outstanding reconciliation counts.
Attempts/retries count pre-finalization upload/recovery attempts, not repeated
read-only reuse after finalized success. Failure counts are processing failures,
not proof that no object was created.

Private `quotaUsageReport(day,{after,limit})` reads at most 501 rows to return at
most 500; stable document-ID cursors allow continuation. `quotaUsageSummary`
defaults to ten pages of 100, maximum twenty pages of 500, accumulating totals
without unbounded memory. It reports a next cursor and incomplete status if
budget is exhausted. Alert states distinguish CROSSED from
UNKNOWN_INCOMPLETE_SCAN and NOT_OBSERVED_IN_COMPLETE_SCAN. Page-only results
are explicitly labeled, never presented as a full-day total.

The 1 GiB threshold reports **application admission-day usage**; original Storage
creation timestamps are retained separately when available. It does not impose
a global admission cap, calculate retained capacity, measure egress, predict
Firestore/Storage billing, or provide an atomic multi-page snapshot. Concurrent
new actor insertions/updates can make a scan incomplete in time even after the
cursor reaches the end; repeat operational reporting as appropriate. Unknown
uploads remain reserved estimates until verified. Daily usage never subtracts
old/replacement revisions. No scheduled worker, production alert or automatic
project-disable behavior was introduced. A hard global cap requires separate
policy approval and a distributed admission design, not merely this report.

## Verification environment and commands

Node 22.14.0; existing clean npm-ci temporary copy:
`C:\Users\chuak\AppData\Local\Temp\menro-storage-phase2-e4bcb0495c8b42229e36b348b9faa90b`.
Admin 14.5.0, Firestore 9.3.1, Storage 8.4.0 from unchanged lockfile. No package
installation/upgrade or repository node_modules replacement was performed.

Only demo-menro-phase2 and loopback Firestore 8080/Auth 9099/Storage 9199 were
allowed. No real .env or credentials were copied. HTTP/HTTPS test guards block
non-emulator traffic. Use the child-shell environment documented in the Phase
2.1 report; remove DEBUG and credential env variables, require a free Storage
port, and do not restart anyone else's services. Synthetic actors/records use
UUIDs; no collection reset, shared fixture deletion, exports or object cleanup.
The quota tests inject a future clock solely to isolate admission-day fixtures;
actual Storage timestamps are not replaced. Existing Firestore/Auth remain
running; only this task's Storage process starts/stops. Its Java EOF shutdown
warning and blocked SDK metadata-probe warning remain documented, not suppressed.

Commands (execute from the clean copy with Node 22 PATH):

```powershell
node --test tests/evidenceUploadQuota.test.js tests/firebaseEvidenceStorage.test.js
node --test tests/*.test.js
node --test tests/evidenceUploadQuota.test.js tests/firebaseEvidenceStorage.test.js tests/firebaseStorageTransport.test.js tests/evidenceStorageConfig.test.js tests/storageInitialization.test.js tests/integrationEnvironment.test.js tests/localEvidenceStorageCompatibility.test.js tests/evidenceAccess.test.js tests/evidenceController.test.js tests/monitoringWorkflow.test.js tests/monitoringController.test.js tests/monitoringSchedule.test.js tests/monitoringObservation.test.js tests/plantingEvidence.test.js tests/uploadSecurity.test.js tests/plantingReport.workflow.test.js tests/earlyMonitoring.test.js tests/authRoutes.test.js tests/authMiddleware.test.js tests/analytics.test.js tests/generatedReport.test.js
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/evidenceUploadQuotaEmulator.test.js tests/integration/firebaseEvidenceStorageEmulator.test.js tests/integration/storageConfigurationEmulator.test.js"
git diff --check
```

Final executed counts are recorded in the acceptance section below. Suites
overlap and must not be summed. The native overwrite-precondition test remains
visible and failing, with original-byte assertion intact. No real GCS acceptance
is claimed. No browser or production authorization acceptance is claimed.

## Changed files and compatibility

New: `src/config/evidenceUploadQuota.js`,
`src/services/evidenceUploadQuota.service.js`, `tests/evidenceUploadQuota.test.js`,
`tests/helpers/evidenceQuotaMemory.js`,
`tests/integration/evidenceUploadQuotaEmulator.test.js`, this document.

Modified: `.env.example`, `.env.integration.example` (quota defaults only),
`src/services/firebaseEvidenceStorage.service.js` (internal integration),
`tests/firebaseEvidenceStorage.test.js` (quota-aware transaction fake/assertions),
`tests/integration/firebaseEvidenceStorageEmulator.test.js` (forward transaction
set operations; existing native overwrite assertions unchanged).

Byte comparisons against the preexisting clean source baseline confirmed no
changes to package manifests/lockfile, app startup, Phase 1 configuration,
authentication, rate/concurrency middleware, existing planting/monitoring/guest
routes/services, image validation, local storage/retrieval, or Storage rules.
The frontend remains untouched with its existing dirty work preserved. No
frontend build applies to this backend-only phase.

Both branches remain `fix/validated-survival-analytics`. Existing 12 tracked
backend modifications and prior untracked development files remain; the new
Phase 3 files are untracked within that worktree. No staged changes. No commit,
push, pull, fetch, merge, rebase, reset, stash, branch switch, production access,
Render/Firebase settings changes, deployment or scheduler activation occurred.

## Acceptance, remaining blockers and Phase 4

Final executed results on the completed source:

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Quota + adapter unit tests | 46 | 0 | 0 |
| Focused Phase 1–3 + workflow/security/analytics regressions | 164 | 0 | 0 |
| Full backend root suite | 266 | 2 | 0 |
| New real quota emulator tests (subset below) | 10 | 0 | 0 |
| Combined quota + Phase 2 + Phase 1 emulator suite | 25 | 1 | 0 |

All eight changed/new JavaScript files pass `node --check`; `git diff --check`
and an explicit trailing-whitespace check for these files pass. The two root
failures are the unchanged `tests/connectedWorkflow.test.js:124,211` fixtures
with release date 2026-10-19 (fields at 129/214), correctly rejected with
SCHEDULE_STALE on October 20. They were not edited. The one emulator failure is
the unchanged native `ifGenerationMatch=0` overwrite-rejection assertion; its
diagnostic still shows changed generation and original bytes overwritten by the
emulator's deliberately synthetic capability probe. It is NOT skipped or counted
as a pass. Earlier intermediate runs passed 33, 39 and 44 unit cases, then the
expanded final 46; intermediate focused/emulator counts are superseded above.

The real quota cases verify exact-boundary concurrent admission, duplicate and
restart persistence, guest isolation, never-attempted cancellation, upload reuse
and replacement, transaction rollback, finalization failure recovery, stale
dry-run/linked preservation, crash-like outage recovery across midnight,
old-day new-write rejection, global threshold/pagination/budget reporting.
Unit cases additionally exercise conflicting retries, invalid configuration,
Manila dates, malicious actor shapes, counter corruption/negative prevention,
legacy-intent blocking, unavailable services and preserved live rate-limiter
behavior. The limiter test uses synthetic identity middleware, NOT real Auth.

The isolated Phase 3 infrastructure meets its local acceptance criteria with the
documented independent baseline limitations. No new task-related failure remains.
The unresolved Storage emulator create-only failure, real nonproduction GCS
immutability acceptance, production Firestore client-rule/IAM review, campaign
policy, cross-event guest identity limits, orphan recovery policy, and later
authenticated workflow integration remain explicit gates. Daily quotas are not
a hard cloud billing limit. Never activate cloud uploads based on these tests.

Phase 4 secure retrieval may be considered only after review and explicit
authorization. None is implemented or started here.
