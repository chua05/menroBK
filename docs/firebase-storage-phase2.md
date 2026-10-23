# Firebase Storage Phase 2 — private upload infrastructure

Phase 2.1 investigation and updated verification: [Phase 2.1 report](firebase-storage-phase2.1.md).
The native service-precondition test remains failing; full service acceptance is blocked.

**Firebase Storage is NOT active for application uploads.** The application
provider remains local. Phase 1 rejects `EVIDENCE_STORAGE_PROVIDER=firebase`, and
the production Storage accessor remains blocked. No routes/controllers or
existing storage/retrieval workflows import the new adapter.

## Acceptance status — NOT FULLY ACCEPTED

The adapter and recovery infrastructure are implemented and tested, but the
installed Firebase CLI 15.31.0 Storage emulator ignores the required generation
precondition. The final emulator suite is **13 passed / 1 failed / 0 skipped**.
The failing native overwrite test remains intentionally visible. Do not claim
server-enforced immutability has passed emulator acceptance, activate cloud
uploads, or begin Phase 3 automatically.

The SDK's real outgoing HTTP request is checked by the test before transmission:
`ifGenerationMatch=0` is present. The installed @google-cloud/storage 8.4.0
`file.js:startSimpleUpload_` merges `options.preconditionOpts` into request query
parameters. The installed firebase-tools `storage/apis/gcloud.js` multipart
handler does not pass generation preconditions to its upload implementation;
the observed overwrite succeeds instead of returning 412.

Google Cloud Storage documents generation-match zero as create-only:
https://cloud.google.com/storage/docs/request-preconditions
No production or other live bucket was contacted to test that contract.

## Files added in Phase 2

- `src/services/firebaseEvidenceStorage.service.js`: emulator-only internal
  adapter, durable intents, scoped retries, byte verification and dry-run reports.
- `tests/firebaseEvidenceStorage.test.js`: 18 mock/fault/security tests.
- `tests/integration/firebaseEvidenceStorageEmulator.test.js`: 14 real SDK,
  Firestore/Storage emulator tests, including the failing native contract probe.
- `docs/firebase-storage-phase2.md`: this document.

No previously existing source, Phase 1 configuration, dependency, lockfile,
frontend file, security rule or environment template was changed in Phase 2.
Earlier uncommitted work remains intact.

## Internal API and trust boundary

`createFirebaseEvidenceStorage()` uses the existing Admin app, Firestore client
and guarded `getStorageBucket()` accessor. Every operation rechecks Phase 1
isolation. Both the Firestore project and bucket must be the approved demo
values; an actual Storage client must target `http://127.0.0.1:9199`.

The factory permits client injection for fault tests only. It is a trusted
server-side interface, not a browser API, authorization service or sandbox for
untrusted JavaScript. Never expose it through a route without future approval.

After existing authentication AND record authorization, a future trusted caller
may create a capability using `serverContext({actor: {uid}, evidenceType,
recordId, verification})`. Do not construct it directly from `req.body`.
JSON copies cannot forge an existing capability (WeakSet branding).
No role, owner override, bucket, path, public flag or download-token option is
accepted. Actor/record identifiers reject paths, traversal, email syntax and
whitespace. Evidence types are allowlisted:

- planting-report
- planting-contribution
- monitoring-early
- monitoring-official

Each new context represents ONE server-generated upload operation. Repeated
`reserve(context, image)` calls return the same intent; changed content/context
is rejected. Multiple photos require separate operation contexts. The caller
must retain the returned intent ID privately. After restart, reconstruct an
authorized context with the SAME actor/record/verification and call `upload`
with the saved intent ID. Creating a new context and reserving again represents
a new operation, not cross-operation content deduplication. Arbitrary client
idempotency keys are not accepted.

`image` accepts only `{buffer, contentType, sha256?}`. The adapter snapshots the
buffer, reuses existing image signature/Sharp validation, enforces the existing
10 MiB bound, derives format, verifies MIME, computes SHA-256 and optionally
checks the supplied server hash. It does not change geotag algorithms, rewrite
EXIF, resize or compress originals.

## Object naming and private metadata

`evidence/v1/{allowlistedType}/{validatedRecordId}/{serverUUID}`

No original filename, email or personal name is used. Object metadata contains
schema version, intent ID, type, hashed actor/record scopes and SHA-256. Capture
and GPS verification results stay in the private Firestore intent, not object
metadata or logs. No public ACL, permanent token URL or signed URL is created.
Cache-Control is private/no-store. Actual production bucket ACL/IAM remains
unverified; emulator deny-all rules rejected unauthenticated synthetic access.

The internal result contains provider, schema version, bucket, object name,
actual generation string, MIME, detected format, size, SHA-256, intent ID and
upload timestamp. It must never be serialized in public API responses as-is.

## Durable intent lifecycle

New emulator-only collection: `evidenceUploadIntents`.

```text
RESERVED → UPLOADING → UPLOADED
                 ↘ RECONCILIATION_REQUIRED → scoped retry/inspection
UPLOADED → LINKED  (future real business-record transaction only)
```

Fields include operation ID, trusted actor/record/type, object name/bucket,
original size/hash/MIME/format, private verification JSON, timestamps, status,
attempt count, lease owner/expiry, actual generation/reference, last sanitized
failure and reconciliation flag. `LINKED` and `retainedAsRevision` are protected
states, not automatically assigned by this adapter.

Firestore transactions (bounded to three transaction attempts) reserve and
claim/update the intent. There is **no Storage I/O inside a transaction**.
An upload lease lasts 120 seconds. An active competing lease is rejected, not
polled. Stale workers cannot finalize another lease. A same-intent retry must
match actor, record, type, validation results, bytes/hash and MIME.

At most three application-level create attempts occur per intent. Completed
objects can still be inspected/recovered after that budget; absent objects
require manual reconciliation rather than further writes. SDK retries are also
finite; the adapter does not run a background retry loop.

## Upload/recovery sequence

1. Revalidate context, environment and bytes; transactionally claim the intent.
2. Inspect its exact trusted path, not a prefix search or client URL.
3. If an object exists, verify all context metadata, size, MIME, generation and
   privacy fields, then stream/hash the actual bounded bytes of that generation.
4. Only if no object exists and no prior generation was committed, request
   create-only upload (`ifGenerationMatch: 0`, non-resumable, CRC32C validation).
5. Inspect again even after a timeout, 412 or lost Storage response. Never blindly
   create a second object/name or delete an uncertain object.
6. Commit UPLOADED and the verified actual generation in Firestore. If a commit
   acknowledgement is lost, re-read the intent before deciding failure.
7. Record a sanitized reconciliation failure when uncertainty remains. If that
   update also fails, the durable UPLOADING lease remains for later recovery.

Metadata operations and verification streams have 20-second adapter deadlines;
save uses a 15-second SDK timeout and a 20-second outer deadline. An outer timeout
does not prove an in-flight SDK write was cancelled: it is treated as uncertain.
The production create-only contract is essential for safe late-write races;
the current emulator cannot certify it. Do not replace it with an exists-then-save
check or enable production to work around emulator limitations.

## Failure categories and logging

Errors use fixed categories, not raw SDK messages: invalid context/metadata,
unsupported type, intent conflict, object collision/metadata mismatch,
checksum mismatch, timeout, unavailable service, missing object and uncertain
outcome/reconciliation. Logs contain operation, intent ID, evidence type,
category and state only. They do not contain credentials, images, EXIF/GPS,
actor identity or full object paths. Logging failure cannot undo a durable result.

## Reconciliation and deletion safety

`reconciliationReport(context, intentIds)` inspects at most 100 exact IDs,
checks ownership/context, and reports in-progress, incomplete, unlinked candidate,
protected or uncertain status. It does not mutate intent state. An unlinked
candidate is NOT a proven orphan. Every row has `cleanupAllowed: false`.

There is NO delete API, prefix deletion, cleanup worker, scheduler or automatic
retention policy. Linked and previous-revision objects are always protected.
Future deletion requires committed-reference auditing and a verified generation
precondition. The emulator does not support validating that safety contract.

The final integration harness therefore performs ownership auditing but NO
object deletion. Unique synthetic objects exist only in the Storage emulator
started for that run, with no export; that process is stopped afterward.
Synthetic intent/link-fixture documents remain in the demo Firestore emulator
for auditability. No shared collection is cleared and no historical record is
modified. Actual linked protection is tested with a new synthetic fixture record
and its intent updated in the same real emulator transaction—not a real MENRO
business record or an adapter claim that application linkage is implemented.

## Verification on 20 October 2026

Clean temporary `npm ci --no-audit --no-fund`, Node 22.14.0. Repository
node_modules and manifests were not replaced. Existing lockfile resolves Admin
14.5.0, Storage 8.4.0, Firestore 9.3.1, Multer 2.4.0 and Sharp 0.35.5.

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| New isolated adapter unit/fault suite | 18 | 0 | 0 |
| Focused adapter + Phase 1 + local workflow/security regressions | 89 | 0 | 0 |
| Full backend root test suite | 237 | 2 | 0 |
| Final real Firestore/Storage emulator suite | 13 | 1 | 0 |

The two existing full-suite failures are connectedWorkflow.test.js:124 and :211:
release dates fixed to 2026-10-19 now violate the real-clock future-schedule
validation at seedlingRequestSchedule.util.js:86. This is a date-sensitive fixture
problem, not evidence that production scheduling should change. Proposed separate
fix: use a scoped deterministic test clock for those two tests with the intended
Manila date, restore it afterward, and preserve assertions and production rules.
No scheduling code or fixtures were changed here.

The sole final integration failure is the native overwrite rejection probe.
Unit tests confirm the adapter requests create-only behavior; real outgoing HTTP
confirms the SDK sends it, but the emulator accepts overwrite. This is NOT counted
as a pass. The final harness's ownership-audit hook passes; it no longer attempts
deletion. Earlier runs identified that emulator behavior and a cleanup-test
ownership assertion failure when the probe stripped custom metadata; those
diagnostic runs are not the final counts above.

Other emulator cases passed: exact EXIF bytes, SHA verification, private metadata,
actual generations, anonymous denial, reservation/upload idempotency, conflicting
content, concurrency, Storage failures/timeouts/lost responses, Firestore
reserve/finalization/lost-ack failures, simulated crash/expired-lease recovery,
metadata/actual-byte mismatch, and committed-link/revision dry-run protection.

Tests use UUID-scoped synthetic records and block non-loopback HTTP/HTTPS.
The CLI starts only Storage; existing approved Auth/Firestore listeners are not
restarted/stopped. Metadata credential probing was blocked by the test guard and
emitted a nonfatal MetadataLookupWarning. The Java rules runtime also emitted an
EOF/NullPointerException warning during shutdown after tests; no application code
was changed to suppress either dependency warning.

Principal commands, from the isolated Node 22 source copy:

```powershell
npm ci --no-audit --no-fund
node --test tests/firebaseEvidenceStorage.test.js
node --test tests/*.test.js
# Set the Phase 1 demo-only variables from .env.integration.example first;
# use no credential files or real .env and unset DEBUG to avoid CLI environment logs.
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/firebaseEvidenceStorageEmulator.test.js"
```

All new JavaScript syntax and git diff whitespace checks passed. No frontend
build applies: no frontend files/contracts changed. Existing upload, guest,
monitoring, resubmission, private retrieval, analytics and scheduling implementation
files retain their pre-existing bytes and diffs. No production Firebase, rule,
IAM, billing, environment setting, deployment, worker or Git history mutation occurred.

## Remaining gates and Phase 3

Phase 2 is implemented but cannot receive full acceptance with the installed
emulator's missing precondition enforcement. Obtain approval for a compatible
test environment/emulator solution, or separately authorize a dedicated
NONPRODUCTION GCS contract test. Do not contact the production bucket. Do not
upgrade tooling or patch its source silently, skip the failure, or weaken
immutability to obtain green tests.

Production edition/IAM/bucket settings, Linux compatibility and real cloud
immutability remain unverified. The Firestore skill's live instance discovery was
not run because this task forbids production access; only the existing native
SDK and approved demo instance were used.

Phase 3 quota/rate/cost safeguards may be planned, but implementation requires
separate approval. Before later activation, also review client rules for the
private intent collection, bounded operational recovery, IAM, permanent reference
sanitization and real workflow linkage. No Phase 3 or application integration has
started. Active evidence storage and retrieval remain LOCAL.
