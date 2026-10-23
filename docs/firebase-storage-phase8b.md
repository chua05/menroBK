# Phase 8B — read-preserving rollback and cloud retrieval safety

21 October 2026. **Source/demo rollback verified; production activation remains BLOCKED.**
Phase 8B only. No production Firebase, Render or real GCS access, historical migration,
original evidence modification, dependency/frontend/.env change, Git mutation or deploy.

## Root cause and scoped correction

`evidenceAccess.service.js:cloudEvidence` used `evidenceWorkflow.enabled()` to
authorize cloud retrieval. That switch controls NEW cloud business writes; disabling
it or switching the provider to local therefore hid valid saved cloud evidence.
The generic Storage SDK accessor already supported local-provider demo infrastructure
and did not require changing. Authentication and evidence HTTP routes are unchanged.

`resolveEvidenceStorageConfig` now exposes an independent `cloudRead` capability:

| Upload provider | Cloud workflow/write flag | New read flag | Result |
| --- | --- | --- | --- |
| local/default | absent/false | absent/false | Legacy local only; no cloud reads |
| firebase | true | absent/true | Existing cloud writes AND reads; backward compatible |
| local | absent/false | true | New evidence stays local; saved cloud evidence readable |
| firebase | false | true | Cloud workflow off; saved cloud readable; existing local submission path used |
| firebase | absent/false | absent/false | Invalid config, still fail closed |
| any | true | false | Invalid config; cannot admit cloud writes with reads explicitly disabled |

New `EVIDENCE_CLOUD_READ_ENABLED` accepts only exact strings true/false. Read-only
mode requires the SAME credential-free demo project, approved Firestore/Auth/Storage
loopback hosts and synthetic bucket. CLI's optional STORAGE_EMULATOR_HOST alias
is accepted ONLY as http://127.0.0.1:9199; alternate selectors are rejected.
Production mode, mismatched project aliases, ambient credential/config
variables and real buckets remain rejected. No real-service read activation exists.
Selecting local alone never enables cloud reads. No real environment file was edited.

Request-facing access dispatch uses the persisted saved private reference AFTER
unchanged business-record authorization, not the selected upload provider. The
private retrieval adapter checks both emulator isolation and read capability when
constructed, when issuing a token and before streaming. Cached capabilities cannot
bypass a revoked read flag. No independent client-selected bucket/path/reference API.

Existing writes are still governed by `evidenceWorkflow.enabled()`. Read flag does
not enable that workflow, Idempotency-Key processing, CORS header expansion, migration,
quota reservations, schedules, notifications or workers. Trusted internal emulator
adapter/fixture tools retain their prior separate guards; this is not an IAM-limited
Storage client or a new blanket prohibition on all trusted test-infrastructure writes.

## Persisted reference and legacy compatibility

- Planting photos and legacy root-only photoPath/photoURL aliases continue through
  existing owner/contributor/Staff/Admin authorization. Root saved references are
  carried into dispatch without changing IDs or source bytes.
- Early/official current observations keep cohort-owner/reporter/Staff/Admin access.
  Revision reads keep their narrower original-reporter/Staff/Admin policy; cohort
  ownership alone still does NOT authorize historical revisions.
- Explicit non-null malformed references, including false/empty string/unknown
  provider/malformed object, fail closed even when a valid local alias exists.
- **Null has existing schema meaning:** monitoring.service.js writes privateEvidence:
  null when a verified local replacement clears the current cloud reference. This
  is treated as cleared/local, preserving that workflow, NOT as fallback after a
  failed cloud request. Older revisions can still retain valid cloud references.
- Exact allowed type/record/path/UUID, private metadata, generation STRING, bounded
  size, MIME/signature and actual SHA-256 checks remain. No latest-generation or
  silent local fallback for missing/corrupt/forged actual cloud references.
- Private staging, timeouts/concurrency/cancellation, no-store/nosniff headers,
  reference redaction and safe API errors remain. No public/download-token URLs.

## Safe rollback procedure — DEMO ONLY, not production authorization

1. Preserve sources, cloud objects, receipts, revisions and quota state. Do not
   clear/recycle operations or replace whole business documents. Track in-flight
   operations before changing a process's configuration; timeout is not proof of
   failure. This phase adds no background reconciliation or automatic cleanup.
2. Use a read-compatible version containing Phase 8B. In the isolated child process
   keep the existing exact demo environment and synthetic bucket, then set:

   ```powershell
   $env:EVIDENCE_STORAGE_PROVIDER='local'
   $env:EVIDENCE_CLOUD_WORKFLOW_ENABLED='false'
   $env:EVIDENCE_CLOUD_READ_ENABLED='true'
   ```

   An alternative is to leave firebase selected with write flag false AND explicit
   reads true, but local is the clear recommended NEW-upload configuration. Existing
   local submission semantics are retained, not a ban on every new local upload.
3. Validate config before starting a NEW task-owned process. Do not restart shared
   services. Verify reads for owner/Staff/Admin and unrelated-user denial, root-only
   planting, current early/official observations and every local/cloud revision.
4. Confirm new application submissions create local paths without cloud intents,
   workflow operations or quota charges; counts/review/schedule rules stay unchanged.
5. Compare original business/revision and intent/quota snapshots. Cloud read failure
   means stop/reconcile, not choose the local alias or delete the cloud reference.
6. Forward recovery reuses the correct durable operation/intent. Uncertain uploads,
   stale linkage, old-day reservations or business conflicts remain manual cases;
   this task does not change submission/correction recovery rules or complete any
   pre-existing unfinished cloud operation. Production rollback still requires a
   separately approved real target/read gate and actual deployment acceptance.

## Files changed in Phase 8B

Existing files (including previously untracked infrastructure) changed narrowly:

1. src/config/evidenceStorage.js — validated independent read flag, shared demo
   isolation, backward-compatible write-enabled reads and upload-disabled mode.
2. src/services/evidenceAccess.service.js — read gate rather than write gate;
   malformed-reference dispatch with legitimate null-clearing compatibility.
3. src/services/firebaseEvidenceRetrieval.service.js — read capability rechecked
   at factory/token/stream boundaries in addition to original emulator guard.
4. scripts/validateEvidenceProductionReadiness.js — accepts the non-secret read flag
   so offline production validation rejects activation using the runtime resolver.
5. tests/evidenceProductionReadiness.test.js — production read-enable rejection.
6. tests/evidenceStorageConfig.test.js — five focused configuration/negative cases.
7. tests/firebaseEvidenceRetrieval.test.js — two capability/byte tests and updated
   explicitly authorized read-only provider expectation; production rejection retained.
8. tests/helpers/evidenceRetrievalFixture.js — explicit synthetic read opt-in.
9. tests/integration/firebaseEvidenceRetrievalEmulator.test.js — explicit read opt-in
   and strict validation/removal of CLI-only demo discovery metadata in test child.
10. docs/firebase-storage-phase8a.md — superseding findings and updated readiness row.

New: tests/integration/evidenceRollbackEmulator.test.js and this report. Total 12 files.
No changes to app initialization, Firebase credentials/accessor, routes, authentication,
frontend, submission/review services, quota logic, migration tooling, schedules,
analytics, dependencies, environment files, Storage Rules or known failing assertions.

## Verification and evidence scope

Existing clean-lockfile temporary copy, Node 22.14.0. Package/lockfile hashes match
repository; Admin 14.5.0 / Firestore 9.3.1 / Storage 8.4.0 / Multer 2.4.0 / Sharp
0.35.5 unchanged. Repository node_modules not replaced. Exact final counts below
are overlapping suites, not an additive unique total.

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Focused config/retrieval/resolver/workflow/readiness/initialization | 78 | 0 | 0 |
| Full backend regression | 396 | 2 | 0 |
| New authenticated rollback emulator acceptance | 13 | 0 | 0 |
| Existing Phase 5 authenticated workflows | 13 | 0 | 0 |
| Existing Storage/retrieval/quota/config emulator | 35 | 1 | 0 |

The 13 new cases start the application ALREADY in read-only/local-provider mode,
with real demo Auth tokens and UUID Firestore fixtures. Trusted fixture setup uses
four tiny synthetic objects through the existing adapter with new test-user quotas,
NOT migration accounting. Tests verify actual delivered original bytes, private
headers, owner/reporter/Staff/Admin versus unrelated/missing-auth denial before
Storage reads, root-only compatibility, local/cloud revisions, null-cleared local
replacement with retained cloud history, malformed/missing/wrong-generation failures,
read revocation/default-safe behavior, upload gate off with either provider, valid
new LOCAL planting submission, and unchanged original history/schedule/intent/quota.
Synthetic reference-corruption tests restore ONLY their own new test records.

Initial diagnostic rollback run passed 12/12 before the null-clearing compatibility
case was added. It is not the final count. Existing monitoring replacement source
explicitly clears with null; that convention was preserved before final acceptance.
No existing business rule was changed to make a test pass.

One broader diagnostic run reported 25 passed / 2 failed: retrieval test startup
was rejected because Firebase CLI also injects STORAGE_EMULATOR_HOST. Installed
CLI env.js confirms the alias is http://127.0.0.1:9199. The new guard was corrected
to accept ONLY that exact matching alias, with positive/negative tests; all other
addresses remain blocked. The full corrected integration rerun passed 35/36 with
only the unchanged native precondition failure. This diagnostic is not counted as
final acceptance, and no guard was removed to make tests pass.

Final full-root result: 398 cases, 396 passed / 2 failed / 0 skipped. Ten scoped
JavaScript files pass node --check; git diff --check and all 12 scoped files'
explicit trailing-whitespace checks pass. No frontend build applies.

Known failures remain visible and unchanged: connectedWorkflow.test.js:124/:211
uses the past 2026-10-19 release date, correctly producing SCHEDULE_STALE; the native
Storage Emulator multipart condition-zero overwrite assertion remains unmodified.
Neither is skipped, weakened or relabeled as a pass. Blocked metadata credential
probes and Java Rules runtime EOF/NullPointerException at shutdown are separate
environment diagnostics. No real-service immutability, IAM or browser acceptance.

Commands (clean copy, Node 22 PATH):

```powershell
node --test --test-reporter=spec tests/evidenceStorageConfig.test.js tests/firebaseEvidenceRetrieval.test.js tests/evidenceRetrievalResolver.test.js tests/evidenceWorkflow.test.js tests/evidenceProductionReadiness.test.js tests/storageInitialization.test.js
node --test --test-reporter=spec tests/*.test.js
# Demo child: local provider, workflow false, explicit reads true, unique temp upload root:
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test --test-reporter=spec tests/integration/evidenceRollbackEmulator.test.js"
# Separate child: existing Phase 5 demo cloud settings (reads inherited from workflow):
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test --test-reporter=spec tests/integration/evidenceWorkflowEmulator.test.js"
# Separate child: local provider, write/read flags absent; retrieval test explicitly opts in:
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test --test-reporter=spec tests/integration/firebaseEvidenceStorageEmulator.test.js tests/integration/firebaseEvidenceRetrievalEmulator.test.js tests/integration/evidenceUploadQuotaEmulator.test.js tests/integration/storageConfigurationEmulator.test.js"
git diff --check
```

All child runs use demo-menro-phase2, Firestore 127.0.0.1:8080, Auth 127.0.0.1:9099,
Storage 127.0.0.1:9199 and demo-menro-phase2.firebasestorage.app. No real .env/ADC,
DEBUG or credential variables; only the matching CLI Storage alias is allowed. Existing shared
Auth/Firestore processes remain; only task-owned Storage/server processes used.
No shared records/quotas reset. Migration upload tests deliberately not run: prior
read-only counter showed 42/50 already used; this task does not consume that account.
Final loopback inspection confirms unchanged shared Auth PID 16768 / Firestore
PID 11524, with task-owned Storage 9199 and hub/log 4401/4501 stopped. The shared
21 October migration counter remains exactly 42 finalized files / 12,138 bytes,
zero reservations, matching the prior inspection. No quota reset or bypass.

## Updated readiness matrix and next approvals

| Area | Status | Scope / remaining requirement |
| --- | --- | --- |
| Read/write gate separation | VERIFIED | Current source and isolated demo only |
| Local/root/revision compatibility | VERIFIED | Synthetic authenticated delivered bytes and roles |
| No cloud-to-local error fallback | VERIFIED | Malformed, missing, wrong-generation and denial cases |
| Read revocation and default safety | VERIFIED | Config tests + cached token + authenticated API |
| Production read/write access | BLOCKED | Deliberately no real target/activation gate |
| Real-service immutability/privacy/IAM | NOT TESTED | Separate nonproduction authorization required |
| Production rollback compatibility | PARTIALLY VERIFIED | Source/demo fixed; real target/runtime/restore acceptance pending |
| Historical source/Render durability/backups | NOT TESTED | No production inspection or restore authorized/performed |
| Production deployment/migration | BLOCKED | Code-target, service, inspection and manual approvals remain |

Next: approve a dedicated nonproduction project/bucket/identity and bounded synthetic
GCS acceptance scope; pin the Phase 7B allowlist in a separately reviewed change.
Separately authorize any production-target gate implementation and read-only
Render/source/backup inspection. No production access or activation follows from
this phase. Readiness validator still never certifies productionCloudReady=true.

Branch remains fix/validated-survival-analytics; unrelated dirty work preserved,
nothing staged, no commit/push/branch/dependency/environment/production changes.
Stop at Phase 8B; no real-service test, live migration or deployment authorized.
