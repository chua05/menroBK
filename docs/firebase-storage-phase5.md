# Firebase Storage Phase 5: emulator-only workflow integration

**Firebase Storage is not active in production.**

**Production cloud activation remains blocked pending real-service immutability
verification and final acceptance.** No historical migration or Phase 6 work.

## Contract and gates

The default remains `EVIDENCE_STORAGE_PROVIDER=local`. Local mode does not create
workflow operations, interpret Idempotency-Key, or instantiate Storage clients.
Cloud application workflows require ALL of these child-process settings:

```powershell
$env:NODE_ENV='test'
$env:MENRO_INTEGRATION_TEST='true'
$env:GCLOUD_PROJECT='demo-menro-phase2'
$env:GOOGLE_CLOUD_PROJECT='demo-menro-phase2'
$env:FIREBASE_PROJECT_ID='demo-menro-phase2'
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
$env:FIREBASE_STORAGE_EMULATOR_HOST='127.0.0.1:9199'
$env:FIREBASE_STORAGE_BUCKET='demo-menro-phase2.firebasestorage.app'
$env:EVIDENCE_STORAGE_PROVIDER='firebase'
$env:EVIDENCE_CLOUD_WORKFLOW_ENABLED='true'
$env:MENRO_UPLOAD_ROOT=Join-Path $env:TEMP ('menro-phase5-uploads-'+[guid]::NewGuid().ToString('N'))
Remove-Item Env:DEBUG,Env:GOOGLE_APPLICATION_CREDENTIALS,Env:FIREBASE_PRIVATE_KEY,Env:FIREBASE_CLIENT_EMAIL,Env:FIREBASE_CONFIG -ErrorAction SilentlyContinue
```

Do not put these settings in production or real .env files. Production mode,
non-demo projects/buckets, alternate emulator addresses, malformed gates and
credential/config environment variables fail closed. Host presence alone is not
activation. Existing Phase 1-4 infrastructure tests may still run with provider
local, but actual cloud business workflows require the additional explicit gate.

The CLI injects synthetic FIREBASE_CONFIG into emulators:exec children. The new
integration harness validates its exact demo project, allowed keys, synthetic
bucket and database URL before removing it from its own test process. Application
guards themselves do not accept this variable. Other credentials are never read
or printed. HTTPS and non-approved HTTP destinations are blocked by the harness.

The only new request contract is optional `Idempotency-Key`, matching
`^[A-Za-z0-9_-]{8,128}$`. Whitespace, Unicode, commas, multiple values and larger
keys are rejected with 400/INVALID_IDEMPOTENCY_KEY inside the cloud gate. Outside
that gate the header has no workflow meaning. CORS permits the header only with
the validated gate; production allowed headers remain unchanged.

Keys are scoped by trusted actor namespace (Firebase UID versus validated guest
participant ID), workflow and target resource where applicable. Within that
scope, changed payload or image bytes produce 409/IDEMPOTENCY_CONFLICT. The same
key may independently identify operations for different actors/workflows/targets.
Fingerprints use sorted JSON object keys, ordered image hashes, actual decoded
formats and sizes, and relevant submission fields. They exclude multipart
boundaries and filenames. Planting fingerprints exclude mutable profile-display
fields. Image bytes, raw keys, personal payloads and Storage paths are not stored
in the operation fingerprint or public error response.

No key means a fresh independent operation. There is NO automatic fingerprint
deduplication. Existing business duplicate-image/record guards still reject
duplicates. Failed no-key requests cannot transparently recover across requests;
callers needing recovery must supply a key from their FIRST attempt.

Successful creates/replays retain the existing 201 envelope; guest attachment and
correction retain 200. Replay reloads the same business record, so its current
review status may be newer than the original response. A lease conflict returns:

```json
{"success":false,"code":"EVIDENCE_IN_PROGRESS","message":"Evidence processing is still in progress. Please retry with the same Idempotency-Key."}
```

Status is 202 with Retry-After: 2. Uncertain infrastructure outcomes use safe
503/EVIDENCE_RECONCILIATION_REQUIRED. These contain no private operation handles.
No automatic client retries, background loops or frontend changes were added.

## Ledger, quota and transactions

Private demo collection `evidenceWorkflowOperations` holds schemaVersion=1,
scope/fingerprint hashes, workflow, stable server-generated target/observation
IDs and upload-intent UUIDs, RUNNING/RETRYABLE/COMPLETED status, lease token,
leaseUntil, timestamps, retentionPolicy and a completed business resultLink.
With a header its document ID hashes the scoped key; without one it is random.

Reservation/lease acquisition uses Firestore transactions. A 180-second operation
lease and token fence prevent concurrent or expired owners committing linkage.
Each image uses the existing quota-aware upload adapter and the ledger's durable
UUID. The adapter's new optional reserve argument is a TRUSTED SERVER intent ID,
not a client header or object path. Existing calls without it are unchanged.
Same-operation recovery reuses the original object, intent and reservation;
quota finalization follows verified actual upload bytes, not business success.

Storage I/O is outside business transactions. Before any business writes, a
prepareLink step transactionally reads/fences the operation and every verified
UPLOADED intent. Its write-only completion closure participates in the SAME
transaction as the business record, hash registry, counters and notifications.
That atomic commit changes intents to LINKED and the operation to COMPLETED.
No separately acknowledged finalization step can claim uncommitted linkage.

Storage success plus business failure retains the verified object/charge for
retry. Commit-acknowledgement loss rereads the ledger and resolves confirmed
linkage without repeating mutations. Response loss similarly replays the saved
resultLink. Reservation-ack loss may require waiting for the operation lease;
the durable IDs are retained. Unknown quota/object outcomes are never released
or deleted. Existing adapter leases, three-attempt budget and Manila day guards
remain intact. SDK/Firestore numeric error codes become safe infrastructure
responses rather than exposing SDK details.

Retention policy `retain-no-ttl-v1`: retain ALL operation identities indefinitely,
including failed/in-progress ones. No expiresAt, TTL, deletion API, pruning worker
or key recycling. Completed keys remain tombstones even if a later business read
fails; replay must never recreate a deleted business record. This intentionally
grows the private demo ledger. Any future bounded retention requires durable
non-replayable tombstones and separate approval; age alone is not safe expiry.

## Workflow integration and authorization

- Planting POST keeps existing metadata/GPS/timestamp, count, duplicate, event,
  distribution, site and review rules. Standalone reports use the operation's
  reserved report ID. Request-linked submissions reserve a contribution ID and
  keep the existing parent report ID/aggregation and transaction rules.
- Guest attachment validates the existing session at the route and the exact
  contribution's event/participant before ledger use. Its actor is the trusted
  event-scoped guest ID, never a body contributor ID. Completed replay repeats
  that ownership check. Parent flattening preserves existing photo order and
  derives each cloud photo's expected contribution context from its source row.
- Early/official monitoring reserve one immutable observation ID per operation.
  Existing counts, partial coverage, reporter/owner relationships, date, schedule,
  outstanding guards, Staff/Admin transitions and notifications are unchanged.
  The official controller normalizes Express's third `next` argument to official
  rather than passing a function into canonical payload serialization.
- Corrections keep observation ID, expectedVersion checks and append-only
  revisions. Valid count/remarks-only reuse creates no new intent or upload
  charge. Cloud retained references and actual bytes are verified OUTSIDE the
  transaction; the reference is compared again inside it. Invalid/missing/
  corrupt evidence requires replacement (422); temporary retrieval failures
  return 503 without classifying evidence as invalid. Replacement uploads use a
  new immutable intent and charge, preserving all earlier references. Stale or
  competing correction transactions cannot append duplicate revisions.

New cloud references use a privateEvidence field containing the exact Phase 2
schema. No legacy field or path is migrated. Monitoring public presenters remove
private references and expose existing hasEvidence signals. Planting/guest JSON
middleware recursively removes privateEvidence for every role, including nested
contribution photos. Local public JSON fields and wire serialization remain.

Existing evidence GET routes load and authorize the business record FIRST using
unchanged owner/contributor/reporter/Staff/Admin rules. Revision access still does
NOT grant access merely because a user owns the cohort. Only committed saved
references are resolved; clients cannot choose bucket/object/generation. Cloud
reads bind to the actual report/contribution or immutable observation ID/type,
then use Phase 4 generation/hash-checked streaming. Local paths retain existing
containment/realpath/sendFile handling. Explicit cloud failures never select a
local fallback. Private/no-store, MIME and nosniff responses work with existing
ProtectedEvidenceImage; raw references, download tokens and public URLs are not
returned. Errors after headers destroy the response instead of writing JSON.

## Verification and remaining limits

Run with Node 22.14.0 in the existing isolated clean npm-ci copy, not the stale
repository node_modules. No installation or dependency update was performed.
Before final regression execution, source and ALL root tests/helpers were synced
from the current repository; the old temporary snapshot lacked eight current
root test files. Earlier partial-snapshot counts are not final acceptance counts.

```powershell
node --test tests/evidenceWorkflow.test.js
node --test tests/evidenceWorkflow.test.js tests/integrationEnvironment.test.js tests/evidenceStorageConfig.test.js tests/storageInitialization.test.js
node --test tests/*.test.js
# With the demo-only child environment above; check 9199 is free first:
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/evidenceWorkflowEmulator.test.js"
# In a SEPARATE child shell with provider local and cloud gate unset:
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/firebaseEvidenceStorageEmulator.test.js tests/integration/firebaseEvidenceRetrievalEmulator.test.js tests/integration/evidenceUploadQuotaEmulator.test.js tests/integration/storageConfigurationEmulator.test.js"
git diff --check
```

Final executed results (overlapping suites must not be summed):

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Phase 5 contracts + existing config/initialization/isolation | 34 | 0 | 0 |
| Full current backend root suite | 302 | 2 | 0 |
| Authenticated Phase 5 Firestore/Auth/Storage acceptance | 13 | 0 | 0 |
| Existing combined Phase 1-4 Storage/Firestore integration | 35 | 1 | 0 |

The focused 34 include 14 new coordinator tests and the existing 20 gate/safety
tests. The full suite has 304 cases. All 17 modified/new JavaScript files pass
node --check; git diff --check and explicit new-file whitespace checks pass.
No frontend build applies because no frontend source or UI was changed.

The 13 authenticated cases verify original bytes, private headers and reference
redaction; standalone and request-linked planting; no-key duplicate rejection;
same-key changed fields/images conflict; early and partial official observations;
Staff return/review and Admin approval restrictions; concurrent corrections and
submissions; count/remarks reuse without new charges; immutable replacement and
historical revision retrieval; invalid site GPS replacement; valid but unrelated
guest denial; guest parent aggregation; local mixed retrieval; absent/forged/
wrong-generation objects; Storage failure; Storage success/business failure; and
business success/interrupted response. Actual persisted business/hash/intent/
quota records are inspected. Separate adapter tests cover remaining Storage
faults and restart/timeout reconciliation. Unit tests cover actor namespaces,
malformed keys, canonical ordering, old-key retention, expired-owner fencing,
reservation/commit acknowledgement loss and safe 202 behavior.

Earlier
diagnostics: the first native launch rejected CLI-injected FIREBASE_CONFIG before
any workflow tests; after harness isolation, 6/9 passed and exposed the Express
third-argument issue. The corrected suite passed 9/9, then expanded coverage
passed 12/12 before the final retained-evidence integrity hardening rerun.
These diagnostic failures were not hidden or counted as final successes.

Known independent failures remain visible: connectedWorkflow.test.js:124/:211
uses past 2026-10-19 release fixtures and correctly fails SCHEDULE_STALE. The
native multipart ifGenerationMatch=0 test still FAILS because CLI 15.31.0 ignores
the condition; no real-service immutability acceptance is claimed. Java rules
runtime EOF shutdown warnings and blocked credential-metadata probes are reported
separately, not suppressed or counted as application failures.

All synthetic users, records, hashes and images use fresh UUIDs. No shared test
fixtures/collections were cleared. Existing Auth/Firestore processes were not
stopped/restarted; only task-owned Storage/server processes were used. No real
.env, dependencies, credentials, production records, IAM, rules, billing,
schedulers, frontend, Git history or deployment configuration changed.
Final listener inspection confirmed shared Firestore PID 11524 at 8080 and Auth
PID 16768 at 9099 unchanged, and task-owned Storage 9199 stopped. Storage fixtures
are ephemeral without export; private demo Firestore audit records are retained,
so old synthetic references may correctly become unavailable after emulator stop.

## Exact files changed in Phase 5

Existing files edited (including previously untracked Phase 1/2 infrastructure):

- src/config/cors.js
- src/config/evidenceStorage.js
- src/controller/evidence.controller.js
- src/controller/monitoring.controller.js
- src/controller/plantingReport.controller.js
- src/routes/guestEvent.routes.js
- src/routes/plantingReport.routes.js
- src/services/evidenceAccess.service.js
- src/services/firebaseEvidenceStorage.service.js
- src/services/monitoring.service.js
- src/services/parentPlantingReport.service.js
- src/services/plantingEvidence.service.js
- src/services/plantingReport.service.js

New files:

- src/middleware/privateEvidenceResponse.middleware.js
- src/services/evidenceWorkflow.service.js
- tests/evidenceWorkflow.test.js
- tests/integration/evidenceWorkflowEmulator.test.js
- docs/firebase-storage-phase5.md

Both repositories remain on fix/validated-survival-analytics. Nothing is staged.
Preexisting tracked/untracked work, including dependency/Render/Graphify/map
changes, remains. No source edits outside the files listed above were made in
Phase 5. The Firestore/API skills informed transaction and contract checks; live
database discovery/tool installation was not run because production access and
dependency/tool upgrades were forbidden.

Phase 5's controlled local workflow integration is verified within the documented
emulator limits. It is NOT production activation or real-service immutability
acceptance. Phase 6 remains unstarted and requires separate explicit approval.

Limitations: no browser visual acceptance or production IAM/Linux/GCS verification.
An old-day unused/uncertain intent cannot blindly start a new write against an old
quota; it may require separately audited reconciliation under Phase 3 rules.
Business validation/version/allocation changes may prevent completing an uploaded
operation; its object and charge remain, never automatic cleanup. No-key failures
have no cross-request recovery guarantee. Leases can require a bounded wait after
process interruption; there is no background recovery scheduler. A missing object
is not proof that an in-flight write cannot later finish. Retrieval uses bounded
private temporary staging; crash residue/egress costs remain operational gates.
Retained-evidence verification uses its own shared retrieval factory; admission is
bounded per factory, not a global bandwidth quota.

Phase 6 migration is NOT started. Migration planning must first review these
results, preserve private legacy paths/attribution, establish production IAM and
client-rule restrictions for new private ledgers, settle recovery/retention policy,
and separately verify real-service create-only/generation/private-access behavior.
No production activation is authorized by emulator workflow acceptance.
