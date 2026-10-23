# Phase 2.1 — Emulator compatibility and immutable upload verification

2026-10-20: Investigation complete with a **known failing emulator capability
test**. Full Phase 2 service-level acceptance remains BLOCKED. Provider remains
`local`; the application `firebase` provider and production Storage accessor
remain disabled. No application source fix was justified or applied.

## Root cause and source references

Tested Node 22.14.0, Firebase CLI 15.31.0, Admin 14.5.0, Storage SDK 8.4.0.
Used the existing clean npm-ci copy:
`C:\Users\chuak\AppData\Local\Temp\menro-storage-phase2-e4bcb0495c8b42229e36b348b9faa90b`.
Repository node_modules is stale (Admin 11.11.1), was not used or replaced.
Manifests, lockfile, adapter and configuration match their pre-task clean baseline.

- `src/services/firebaseEvidenceStorage.service.js:205-214`: nonresumable save,
  CRC32C validation, `preconditionOpts:{ifGenerationMatch:0}` and reconciliation.
- Clean `node_modules/@google-cloud/storage/build/cjs/src/file.js:1570` chooses
  simple upload; `startSimpleUpload_` at 3599 builds the request and 3633 merges
  preconditions into its query string.
- Integration HTTP guard asserts the actual outgoing SDK request contains both
  `uploadType=multipart` and `ifGenerationMatch=0`. The emulator processes it and
  stores a replacement. This is sender wire tracing plus observed server behavior,
  NOT a separate packet capture or production-log inspection.
- Installed CLI root:
  `C:\Users\chuak\AppData\Roaming\npm\node_modules\firebase-tools\lib\emulator\storage`.
  `apis/gcloud.js:230-319` handles uploads. Multipart construction at 292-298
  forwards bucket/name/metadata/bytes/authorization, NOT the query precondition;
  shared finalizer at 255 calls `adminStorageLayer.uploadObject`.
- `files.js:131-166` (`uploadObject`) builds new metadata, then deletes/replaces
  the destination at 162-164 without generation-condition enforcement. Searching
  the installed Storage subtree finds no `ifGenerationMatch`/`generationMatch`.

The native assertion remains FAILING, not skipped or inverted:
`Missing expected rejection`. Its sanitized diagnostic is:

```json
{"transport":"multipart","ifGenerationMatch":0,"generationChanged":true,"originalBytesIntact":false}
```

Only a newly created UUID synthetic object is deliberately overwritten by this
capability probe. No historical evidence is changed or deleted. Existing shared
Firestore/Auth processes remain running; only our own Storage emulator was
started/stopped. Synthetic intent/linkage documents are UUID-isolated and retained
in demo Firestore for audit; no shared fixtures were reset or deleted.

## Two different guarantees

**A — Adapter verified:** durable immutable identity, create-only options,
same-byte idempotency, conflicting-byte rejection, private metadata/generation
validation, actual-byte SHA256, transaction leases, concurrent same-intent
protection, lost-response recovery, original-byte preservation on adapter retries.

**SDK transport verified separately:** a bounded loopback HTTP STUB receives real
SDK multipart requests, returns CRC32C metadata, returns 412 on collisions and
concurrent writes, and verifies error propagation without replacing original
stub bytes/generation. No ADC discovery, real credentials or cloud connections.
This is a MOCK test, not Firebase/GCS service acceptance.

**B — Service atomic protection NOT verified:** emulator fails; real GCS was not
contacted. Existence checks and leases cannot replace atomic service enforcement
against a writer outside the same intent. The native assertion was strengthened
with original-byte verification and diagnostic output, not weakened.

## Alternatives evaluated without installation

| Option | Assessment |
| --- | --- |
| Existing emulator alternate modes | Resumable initialization (`apis/gcloud.js:232-244`) and media (`307-318`) also drop preconditions; finalization uses the same uploadObject. No supported alternative identified. Source inspection, not alternate-mode runtime acceptance. Do not change adapter transport. |
| Different CLI | No confirmed fixed version identified. Retrieved upstream master upload handler also drops conditions. Older 14.0.0 and installed-tag source requests through research tool were unavailable. Other versions were NOT installed/executed; enforcement and compatibility remain NOT VERIFIED. Release notes alone cannot prove a fix or its absence. |
| SDK HTTP stub | Implemented, passing, transport/error-handling proof only. |
| Future GCS contract test | Requires separate explicit authorization and dedicated nonproduction resources; specification below. |

Primary sources reviewed:

- [GCS preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions): condition 0 requires no live object; collisions return 412.
- [Upstream emulator upload handler](https://raw.githubusercontent.com/firebase/firebase-tools/master/src/emulator/storage/apis/gcloud.ts), lines 257-347. Mutable source is not proof about every release.
- [Firebase CLI releases](https://github.com/firebase/firebase-tools/releases), visible recent releases reviewed; no confirmed upload-precondition fix identified.

## Final test results and commands

Run from the clean copy on Node 22.14.0. No dependency install/upgrade needed.
Initial sandbox test launch failed EPERM; authorized isolated subprocess execution
worked. Initial new stub fixture wrongly expected name in multipart metadata;
corrected it to read the SDK's query name. No application behavior changed.

```powershell
node --test tests/firebaseStorageTransport.test.js
# 1 passed, 0 failed, 0 skipped

node --test tests/firebaseEvidenceStorage.test.js tests/firebaseStorageTransport.test.js tests/evidenceStorageConfig.test.js tests/storageInitialization.test.js tests/integrationEnvironment.test.js tests/localEvidenceStorageCompatibility.test.js tests/evidenceAccess.test.js tests/evidenceController.test.js tests/monitoringWorkflow.test.js tests/plantingEvidence.test.js tests/uploadSecurity.test.js tests/plantingReport.workflow.test.js tests/earlyMonitoring.test.js
# 91 passed, 0 failed, 0 skipped; includes adapter 19 and transport 1

node --test tests/*.test.js
# 241 total: 239 passed, 2 failed, 0 skipped (overlaps focused suite)

firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/storageConfigurationEmulator.test.js tests/integration/firebaseEvidenceStorageEmulator.test.js"
# 16 total: 15 passed, 1 failed, 0 skipped
# Phase 1 smoke 1/1; adapter emulator 14 passed / 1 known native failure
```

Emulator child-shell environment (do not modify real .env):

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
$env:EVIDENCE_STORAGE_PROVIDER='local'
$env:CI='true'
$env:FIREBASE_CLI_DISABLE_UPDATE_CHECK='true'
Remove-Item Env:DEBUG,Env:GOOGLE_APPLICATION_CREDENTIALS,Env:FIREBASE_PRIVATE_KEY,Env:FIREBASE_CLIENT_EMAIL -ErrorAction SilentlyContinue
```

Require a free port 9199 and approved loopback demo Firestore/Auth first. Never
stop someone else's services. No real env/credential files in the clean copy.
HTTP guards block non-emulator traffic. CLI used alternate local hub/log ports.
SDK metadata-probe warning reflects a blocked credential-discovery request; Java
rules-runtime EOF/NullPointerException appeared at shutdown. Neither explains the
assertion failure. Storage 9199 stopped afterward; 8080/9099 remained listening.

Full-suite failures are unchanged: `tests/connectedWorkflow.test.js:124,211`,
with release date `2026-10-19` at 129/214. On October 20,
`src/utils/seedlingRequestSchedule.util.js:86` correctly throws SCHEDULE_STALE.
No scheduling or unrelated fixture edits. Focused planting, early/official
monitoring, protected retrieval, local compatibility and isolation tests pass.
No live browser/application end-to-end acceptance is claimed.

## Future service acceptance — requires explicit authorization, NOT RUN

1. Approve a dedicated nonproduction project/bucket, least-privilege credentials,
   cost limits and cleanup scope. Never use MENRO production resources.
2. Use standalone SDK testing; do not bypass the application's emulator guard or
   activate its cloud provider. Use bounded synthetic images and unique run prefix.
3. Create with condition 0; record generation/SHA256/private metadata. Write
   different bytes to the same live name with condition 0; require HTTP 412 and
   unchanged original bytes, metadata and generation.
4. Race two creates to a fresh identical name: exactly one success and one 412,
   bytes matching winner. Verify bounded retries cannot replace winner.
5. Verify private access, no public ACL/download tokens, generation-specific
   retrieval; record sanitized results without credentials/private URLs.
6. Only with approval, remove this run's synthetic objects after ownership checks
   using exact-generation conditional deletion. Never broad/unconditional deletion.

## Scope, Git and recommendation

Changed only these five files in this phase:

- tests/firebaseStorageTransport.test.js (new SDK HTTP stub)
- tests/firebaseEvidenceStorage.test.js (post-success conflict preservation)
- tests/integration/firebaseEvidenceStorageEmulator.test.js (transport trace,
  failing capability diagnostics, original-byte and retry collision assertions)
- docs/firebase-storage-phase2.1.md (this report)
- docs/firebase-storage-phase2.md (addendum link)

Both repositories remain on `fix/validated-survival-analytics`; all unrelated
dirty work is preserved. No staging, commit, push, branch switch, deployment,
dependency upgrade, Firebase production access, IAM/rules/billing change,
workflow change, cloud activation or Phase 3 implementation occurred.

Phase 2.1 investigation can close with this visible limitation. Full Phase 2
service acceptance and cloud activation remain blocked. Phase 3 **planning** can
proceed only after explicit approval; implementation remains a separate gate.
