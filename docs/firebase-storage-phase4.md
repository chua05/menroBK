# Firebase Storage Phase 4 — private retrieval and legacy compatibility

**Firebase Storage remains inactive for application uploads and retrieval.**

Phase 4 adds internal backend infrastructure only. No existing endpoint imports
the new resolver or retrieval adapter. The provider remains `local`, explicit
`firebase` activation is rejected, and production Storage access remains blocked.
No Storage Rules, IAM, billing, environment, dependency or frontend changes.

## Architecture and authorization boundary

`src/services/firebaseEvidenceRetrieval.service.js` implements B: validated,
private object retrieval. It does NOT authenticate users or infer permissions
from object names. `serverResolvedEvidence({reference,evidenceType,recordId})`
creates an opaque WeakMap-branded capability after trusted business authorization
A. JSON/raw references cannot be passed directly to `streamTo`. The capability
contains no publicly enumerable Storage fields. Original reference mutation
cannot change its frozen private snapshot. Capabilities are internal JS handles,
not authentication credentials, tokens for browsers, or substitutes for A.

`src/services/evidenceRetrievalResolver.service.js` makes A explicit through an
`authorizeAndResolve(selector, authenticatedUser)` server callback. It awaits A
before creating any cloud capability or reading Storage. Selectors accept only
record/index/observation/revision identifiers; bucket, path, reference or provider
overrides are rejected. The caller must supply the existing middleware-verified
`req.user`, NEVER body identity. A missing identity is rejected before A runs.

Default A calls the unchanged `evidenceAccess.service.js` methods:

- plantingEvidenceForUser: owner, contributor, Staff, Admin.
- monitoringEvidenceForUser: cohort owner, original reporter/monitoredBy, Staff,
  Admin, following the existing implementation.
- monitoringRevisionEvidenceForUser: original reporter/monitoredBy, Staff or
  Admin; cohort ownership alone does not grant revision access.

These methods resolve existing local paths through existing containment,
realpath/symlink and MIME checks. No RBAC is duplicated or widened in new code.
Cloud business-record resolution is an explicit Phase 5 injection point, NOT
implemented by pretending local-path authorization can read cloud records.
The callback must resolve the actual committed saved evidence, not authorize
only a path prefix or pass along a user-supplied reference.

## Reference schema and generation safety

The actual Phase 2 schema is preserved: `provider:firebase`, storageVersion=1,
bucket, objectName, generation, contentType, format, sizeBytes, sha256,
uploadIntentId and optional uploadedAt. The adapter does not silently accept an
alternate `storageProvider` schema or unknown public URL fields.

Validation enforces:

- Approved synthetic bucket and guarded loopback Storage endpoint only.
- Allowlisted planting-report/planting-contribution/monitoring-early/
  monitoring-official type and safe expected record ID.
- Exact `evidence/v1/{type}/{recordId}/{uploadIntentUUID}` path; no traversal,
  percent-encoded extra segments, URLs or arbitrary bucket/object reads.
- Canonical positive uint64 generation STRING, valid SHA256, matching JPEG/PNG/
  WebP MIME/format, integer size from 1 byte through existing 10 MiB maximum.
- Uploaded timestamp, if supplied, must be a bounded parseable string or null.

Both metadata GET and media GET use the exact generation in the query. Installed
Storage SDK 8.4.0 `file.js:613-620` converts File({generation}) strings to Number;
that can round uint64 values. This adapter instead uses a guarded Admin SDK File
without that constructor option and passes the generation string through its
SDK `requestStream` query. Tests verify the exact uint64 maximum reaches real
HTTP transport without Number rounding. No SDK internals or dependency versions
were patched, and shared client retry settings are not mutated.

Metadata must match bucket/name/generation/size/MIME, private cache control,
schema/type/intent/hash/record-scope tags and an actor-scope hash. Public ACLs,
download-token metadata and encoded content are rejected. Actor-scope validation
is an integrity check, NOT authorization of the viewer.

Media headers must report the same generation/MIME and, when present, expected
length. Only a full response is supported; no caller-defined range or alternate
generation is accepted. Missing expected generation returns a safe missing or
mismatch result, never a latest-generation fallback. The emulator ignores some
generation selectors; explicit metadata/header comparison still rejects its
newer object. Availability of historical generations in real GCS is NOT VERIFIED.

## Integrity model and private streaming

Strict pre-response integrity is selected:

1. Read at most 64 KiB of metadata JSON.
2. Stream image bytes through incremental SHA256/size checks to a unique private
   temporary file. Only the first 12 image bytes are retained for MIME signature
   checks; no whole-image Buffer is assembled by the adapter.
3. Verify exact length, whole-image SHA256 and JPEG/PNG/WebP signature before any
   image response header/body is sent. Decoding/EXIF validation remains the
   unchanged upload responsibility; this is not a second native-image decoder.
4. Stream the verified temporary copy to the destination with native Node
   pipeline backpressure, then remove only that operation's temporary file and
   empty directory. It never deletes stored evidence, revisions or uploads.

The staging directory is generated by mkdtemp under the system temp directory;
files use exclusive creation and mode 0600 (mkdtemp is private on POSIX; Windows
relies on the user's temp-directory ACL). Stream high-water marks are bounded at
64 KiB. Default admission is three active retrievals PER FACTORY, configurable
from 1 to 8 for trusted internal callers; busy operations fail safely. Future
integration should reuse a factory, not create one per request to evade this
resource bound. This is not a global/user bandwidth quota.

Default total deadline is 30 seconds, bounded configuration maximum 60 seconds.
The HTTP requests have zero automatic retries through operation-local File
interceptors. The same deadline covers metadata, download, staging and delivery.
AbortSignal or downstream close/error cancels upstream streams/SDK requests and
native pipelines; listeners/timers are removed and resource slots released.
SDK abort errors are suppressed in favor of safe categories, not leaked.

The SDK returns an older duplexify GET stream. Direct asynchronous iteration
stalled despite its readable end, waiting for completion of the unused duplex
side. A bounded native PassThrough bridge fixes completion while preserving
backpressure, error propagation and cancellation. Unit fixtures now model the
actual legacy SDK stream and asynchronous response timing.

Only these response headers are set:

- Content-Type: trusted validated image MIME.
- Content-Length: verified original-byte length.
- Cache-Control: private, no-store.
- X-Content-Type-Options: nosniff.

Storage headers such as Content-Disposition (which contains the private object
name), bucket/name, ETag and token URLs are NOT forwarded. The internal result
contains only contentType, sizeBytes and generation. No signed URLs, public ACLs
or Firebase download tokens are generated.

Trade-off: strict verification adds staging latency and a second local disk read
instead of immediate network-to-client streaming. At most 10 MiB is staged per
operation, normally at most 30 MiB per factory with default concurrency. Handled
success/failure/abort paths clean up staging files. Abrupt process termination or
filesystem cleanup failure can leave a private temporary copy; cleanup failures
log only a fixed category. No broad cleanup worker was added. Deployment must
verify temp permissions, disk capacity and crash-residue policy separately.

A later downstream failure can occur AFTER verified bytes were delivered. It
cannot retract them or reliably return a new JSON error after headers. This is
explicitly tested. Integrity failures detected before delivery expose zero image
bytes; transport delivery is not an all-or-nothing network transaction.

## Legacy dispatch and error handling

The default resolver returns `{provider:local,evidence:{absolutePath,contentType}}`
from the existing authorized local implementation, unchanged. It does not move,
rewrite or reinterpret stored historical documents. The existing sendFile path
continues to serve local descriptors. Cloud results return only an internal
streamTo function bound to the validated capability. Existing endpoints remain
untouched and do not use this dispatcher yet.

Explicit cloud references always select cloud validation/retrieval, including
when invalid or missing. A convenient local descriptor cannot cause fallback.
Unsupported/malformed provider markers fail. A raw legacy string alone is not
sufficient to create an authorized filesystem descriptor.

Fixed internal error codes distinguish invalid context/reference/destination,
unsupported provider, forbidden business access, missing evidence, generation/
size/MIME/metadata/checksum mismatch, Storage permission/unavailability, timeout,
busy admission, client disconnect and delivery failure. Raw SDK error text,
private object paths, GPS, credentials and image bytes are never logged or
included in these errors. Only staging cleanup failure has a sanitized warning.
There are no new HTTP error contracts in this phase. Phase 5 must map errors
before headers and destroy/end an already-started failed response appropriately.

## Testing environment and commands

Verified using Node 22.14.0 and the existing clean npm-ci copy:
`C:\Users\chuak\AppData\Local\Temp\menro-storage-phase2-e4bcb0495c8b42229e36b348b9faa90b`.
Admin 14.5.0, Firestore 9.3.1, Storage 8.4.0; repository node_modules remains
untouched. No dependencies, manifests or lockfiles were changed. The test helper
uses the already-installed SDK transitive duplexify dependency, without installing
anything. Production code adds only Node built-ins and existing configuration.

Use the Phase 2.1 documented demo-only child-shell environment: demo-menro-phase2,
Firestore 127.0.0.1:8080, Auth 127.0.0.1:9099, Storage 127.0.0.1:9199 and the
synthetic bucket; provider local. Remove DEBUG/credential env variables, use no
real .env or credential files, and check Storage port is free first. HTTP guards
block non-loopback/emulator traffic. Existing shared Auth/Firestore processes
were not restarted or stopped; only task-owned Storage harnesses were used.
Synthetic actors/records/objects use UUIDs; no shared fixtures or collections
were cleared. Some NEW synthetic objects are deliberately overwritten/mutated
to test corruption detection. No historical evidence or production data changed.

```powershell
node --test tests/firebaseEvidenceRetrieval.test.js tests/evidenceRetrievalResolver.test.js
node --test tests/*.test.js
node --test tests/firebaseEvidenceRetrieval.test.js tests/evidenceRetrievalResolver.test.js tests/evidenceUploadQuota.test.js tests/firebaseEvidenceStorage.test.js tests/firebaseStorageTransport.test.js tests/evidenceStorageConfig.test.js tests/storageInitialization.test.js tests/integrationEnvironment.test.js tests/localEvidenceStorageCompatibility.test.js tests/evidenceAccess.test.js tests/evidenceController.test.js tests/monitoringWorkflow.test.js tests/monitoringController.test.js tests/monitoringSchedule.test.js tests/monitoringObservation.test.js tests/plantingEvidence.test.js tests/uploadSecurity.test.js tests/plantingReport.workflow.test.js tests/earlyMonitoring.test.js tests/authRoutes.test.js tests/authMiddleware.test.js tests/analytics.test.js tests/generatedReport.test.js
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/firebaseEvidenceRetrievalEmulator.test.js"
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/firebaseEvidenceRetrievalEmulator.test.js tests/integration/evidenceUploadQuotaEmulator.test.js tests/integration/firebaseEvidenceStorageEmulator.test.js tests/integration/storageConfigurationEmulator.test.js"
git diff --check
```

### Executed results and scope

Final completed-source results (suites overlap; do not sum them):

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| New retrieval/resolver unit tests | 22 | 0 | 0 |
| New native retrieval emulator tests | 10 | 0 | 0 |
| Focused Phase 1–4 + workflow/security/analytics regressions | 186 | 0 | 0 |
| Full backend root suite | 288 | 2 | 0 |
| Combined Phase 1–4 Storage/Firestore emulator suite | 35 | 1 | 0 |

All six new JavaScript files pass node --check. Tracked git diff --check and
explicit new-file trailing-whitespace checks pass. No frontend build applies.
The two full-suite failures and the one combined emulator failure are the
unchanged independent baseline issues described below; no Phase 4 test fails.

The first native retrieval diagnostic exposed the SDK stream completion bug:
its task-owned test worker was stopped after verifying PID and filename; the CLI
then stopped its own Storage process. That interrupted run reported 1 pass and
5 failures, not acceptance. An intermediate legacy mock run had 9 passes and 13
failures because its response fired synchronously before listeners; asynchronous
fixture setup was corrected to match the real SDK. Neither failing behavior was
hidden by increasing the production timeout or weakening assertions. Final
standalone native retrieval then passed all 10 cases with a 5-second TEST deadline
(the service default remains 30 seconds).

Tests cover actual JPEG/PNG/WebP bytes, safe headers, record context mismatch,
missing objects, overwritten generation, forged checksum tags versus actual
bytes, exact uint64 wire query, anonymous rules denial, cancellation, and unchanged
quota/intent snapshots. Unit/fault cases cover metadata/media permission/timeout,
size/type/encoding/publicness mismatch, partial streams, pre-delivery corruption,
large slow downstream backpressure, concurrency cleanup, opaque context snapshots
and zero fallback. A 9 MiB synthetic stream tests buffer bounds, not full decoder
acceptance or a process RSS benchmark.

Legacy tests execute the existing authorization and filesystem code with new
synthetic local files and mocked record loading, preserving contributor access
and revision-specific restrictions. Cloud authorization callbacks use synthetic
fixture policies only: no live JWT/browser-to-cloud business workflow acceptance
is claimed. Full authenticated cloud workflow integration belongs to Phase 5.
Permission/timeout fault injection is not production IAM verification.

The unchanged two connectedWorkflow failures use 2026-10-19 release dates at
tests/connectedWorkflow.test.js:129 and :214 (tests :124/:211), correctly returning
SCHEDULE_STALE on October 20. No scheduling code or unrelated fixture was edited.
The original native ifGenerationMatch=0 upload assertion remains visible and
failing; retrieval rejection of changed generations is NOT proof of service-level
create-only enforcement. No real GCS generation/retention/IAM acceptance occurred.
The CLI's Java rules-runtime EOF shutdown warning and blocked SDK credential-
metadata probe warning were not suppressed or mistaken for application failures.

## Files, Git and Phase 5 gates

Only seven NEW files in Phase 4:

- src/services/firebaseEvidenceRetrieval.service.js
- src/services/evidenceRetrievalResolver.service.js
- tests/firebaseEvidenceRetrieval.test.js
- tests/evidenceRetrievalResolver.test.js
- tests/helpers/evidenceRetrievalFixture.js
- tests/integration/firebaseEvidenceRetrievalEmulator.test.js
- docs/firebase-storage-phase4.md

No existing source/test/config files were modified. Baseline byte comparisons
confirmed unchanged Phase 1–3 adapters/configuration, quota models, evidence
service/controller/routes, planting/monitoring/guest services and routes,
authentication/RBAC, image validation, local storage, upload limiters, rules,
manifests and lockfile. The original native immutability test is unchanged.
Frontend dirty work remains untouched; no frontend build or UI change applies.
Both repositories remain on fix/validated-survival-analytics, with preexisting
modified/untracked work preserved and nothing staged. No commit/push/history or
branch operation, production access, deployment, env/IAM/rule/billing change or
scheduler activation occurred.

Phase 4 infrastructure is for review and controlled local testing, NOT cloud
activation. Before Phase 5 implementation, obtain explicit authorization and:

1. Refactor/reuse existing exact record, observation/revision and contributor
   authorization rules for a trusted saved-reference resolver; do not duplicate
   or weaken those rules. Authenticate through existing middleware and reauthorize
   every request. Never cache capabilities as user/session authorization.
2. Bind stored references to the intended immutable observation/revision and
   uploader context. Decide/document legacy mixed-record representation without
   data migration in this phase. Never consume a client-provided cloud reference.
3. Integrate response handling and ProtectedEvidenceImage contracts only with
   full local/emulator authenticated workflow regression acceptance.
4. Retain the live provider block until separately approved nonproduction GCS
   immutability, historical-generation availability, private IAM/rules and cloud
   integration gates pass. Review SDK upgrades against this request-stream path.
5. Review temp filesystem permissions/capacity/crash residue, shared-instance
   concurrency, retrieval abuse/egress costs and suitable response deadlines.
   Upload quotas alone do not cap reads or cloud billing.

No Phase 5 implementation or application integration was started.

Phase 4 is locally verified within its infrastructure-only scope, with the
documented independent baseline limitations. It is ready for review and a
separately authorized controlled local Phase 5 integration, NOT production
activation or a claim that cloud business authorization/IAM has been accepted.
