# Firebase Storage preparation — Phase 1 only

Evidence remains on the existing local filesystem. No upload/retrieval endpoint,
image reference, evidence schema, review workflow or security rule was changed.

## Configuration

- `EVIDENCE_STORAGE_PROVIDER` defaults to `local`; explicit `local` is accepted.
  Unknown/empty values fail startup. `firebase` fails with a Phase 1 unavailable
  error: no cloud adapter exists yet.
- `FIREBASE_STORAGE_BUCKET` is optional while using local evidence storage. When
  provided outside integration mode, only the approved bare bucket name
  `menrosystem-ddfac.firebasestorage.app` is accepted. Do not include `gs://`, a
  URL, path or whitespace. An explicitly configured project must match MENRO.
- Existing Auth/Firestore exports and their single initialized Admin app remain.
  An optional bucket name prepares that app's Storage options without making I/O.
- `getStorageBucket()` is lazy and restricted to the approved demo emulator in
  Phase 1. Production calls are rejected before loading the Storage client.
  Nothing calls this accessor in existing upload/retrieval services.
- Existing local production operation does not require configuring a bucket yet.
  No live `.env` or Render environment change is part of this phase.

## Isolated tests

Existing Auth/Firestore-only integration settings remain valid. To opt into
Storage SDK tests, provide BOTH Storage variables, alongside existing guards:

```powershell
$env:NODE_ENV = 'test'
$env:MENRO_INTEGRATION_TEST = 'true'
$env:GCLOUD_PROJECT = 'demo-menro-phase2'
$env:FIREBASE_PROJECT_ID = 'demo-menro-phase2'
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
$env:FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199'
$env:FIREBASE_STORAGE_BUCKET = 'demo-menro-phase2.firebasestorage.app'
$env:EVIDENCE_STORAGE_PROVIDER = 'local'
```

Use an isolated copy without credential files or a real `.env`. Never inherit
production bucket settings into integration tests. An isolated temporary
`MENRO_UPLOAD_ROOT` remains required for workflow tests, as before.

```powershell
node --test tests/evidenceStorageConfig.test.js tests/storageInitialization.test.js tests/integrationEnvironment.test.js
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test tests/integration/storageConfigurationEmulator.test.js"
```

The separate backend emulator config binds Storage only to `127.0.0.1:9199`;
it neither starts nor changes Auth/Firestore services. Check the port is free
first. Do not stop an existing emulator. `emulators:exec` stops its own emulator
after the test. The smoke test blocks non-emulator HTTP(S), lists synthetic
metadata only, and performs no image uploads/downloads/deletions.

`tests/integration/storage.deny-all.rules` is a local-only test fixture matching
the supplied deny-all policy, not a production rule change or deployment target.
Do not deploy the emulator config or rules. No package/script changes are needed.

## Security and later phases

The Admin SDK is privileged: deny-all client rules do not authorize backend
actions. Later phases require record-level authorization, private streaming,
bucket-scoped IAM review, immutable references, quotas and safe failure cleanup.
Do not grant IAM permissions, create public ACLs, generate download-token URLs,
migrate historical files or activate the firebase provider during Phase 1.

Do not treat emulator success as verification of production IAM, bucket
location, billing, retention, Render settings or signed URLs. Use a clean
lockfile installation (Node 22 recommended) because repository node_modules
may still be stale. Phase 2 requires separate explicit approval.

## Local verification (20 October 2026)

Clean isolated `npm ci` succeeded on Node 22.14.0; Firebase Admin 14.5.0,
Firestore 9.3.1, Storage 8.4.0, Multer 2.4.0 and Sharp 0.35.5 matched the lockfile.
Sharp native loading passed. No repository dependencies were installed/replaced.

The configuration/initialization/safety group passed 20/20. The real Admin SDK
Storage-only emulator smoke passed 1/1, with no image object operations; its own
emulator stopped and existing Auth/Firestore listeners remained. The Java rules
runtime emitted an EOF/NullPointerException warning during shutdown AFTER test
success; CLI exited 0 and port 9199 was confirmed closed.

The final focused workflow/security group passed 71/71; the full suite passed
219/221, including the direct local-file compatibility test. The two failures
are pre-existing connectedWorkflow request fixtures with release date 2026-10-19
(now past), returning SCHEDULE_STALE. They are not modified in this phase.
There were no skipped tests in these groups. Configuration/safety (20/20) and
smoke (1/1) counts are subsets/separate runs, not additional full-suite cases.

The local-file test proves unchanged original bytes and /uploads references,
authorized private retrieval, rejection of an unrelated participant, and no
Storage client initialization. Existing monitoring regression tests cover local
files, replacement/reuse and failure cleanup. JavaScript syntax and tracked/new
file whitespace checks passed. Manifests and existing workflow implementation
files match the initial temporary source snapshot; prior diffs were preserved.

Live Google sign-in, production IAM, real bucket settings and Linux runtime
compatibility were not tested. No frontend build is applicable: no frontend
files or contracts changed. Production Storage is still disabled.
