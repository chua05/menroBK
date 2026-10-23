# Phase 8A — offline configuration and final rollout preparation

Latest offline acceptance/readiness matrix and keyless instructions:
[Phase 8D-8E](firebase-storage-phase8d-8e.md). This does not authorize live inspection,
acceptance, production activation or migration; the historical results below remain
limited to their stated scope.

21 October 2026. **CONDITIONALLY PREPARED — PRODUCTION ACTIVATION BLOCKED.**
No production Firebase/Storage/Render access, migration, IAM/rules/billing/env
change, deployment, dependency installation, frontend change or Git mutation.
This is preparation/isolated verification, not acceptance of deployed settings.

Phase 8B update: [read-preserving rollback](firebase-storage-phase8b.md) supersedes
the read/upload coupling finding below in the isolated emulator scope. Production
read/write activation remains blocked. Phase 8A test counts below are historical;
fresh Phase 8B counts are recorded in its report.

## Configuration validator

`node scripts/validateEvidenceProductionReadiness.js --config C:/private/non-secret-readiness.json`

Standalone only; no startup registration, dotenv, SDK import, HTTP or mutation.
Input is an explicitly supplied non-secret projection, NOT a real .env or service
account. Rejects unknown keys/actual credential fields and oversized input. Output
contains fixed codes only, never supplied URLs/paths/project values/secrets. Checks
runtime storage configuration using the existing pure resolver and bounded quota
resolver; never initializes Firebase. Secret-presence declarations are operator
assertions, not validation of the key material, IAM or deployed environment.

Example NON-SECRET input for current LOCAL production configuration:

```json
{
  "values": {
    "NODE_ENV": "production",
    "EVIDENCE_STORAGE_PROVIDER": "local",
    "FIREBASE_PROJECT_ID": "menrosystem-ddfac",
    "FIREBASE_STORAGE_BUCKET": "menrosystem-ddfac.firebasestorage.app",
    "FRONTEND_URL": "https://frontend.example",
    "BACKEND_URL": "https://backend.example",
    "EVIDENCE_DAILY_FILE_LIMIT": "50",
    "EVIDENCE_DAILY_BYTE_LIMIT": "209715200",
    "EVIDENCE_GLOBAL_DAILY_ALERT_BYTES": "1073741824"
  },
  "presentSecretNames": [
    "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY",
    "REQUEST_IDENTIFICATION_ENCRYPTION_KEY", "GUEST_INVITATION_SECRET"
  ]
}
```

Replace example origins in the private projection only after operator verification;
this document changes no live config. Bucket is optional to CURRENT local runtime,
but the approved name is needed for future readiness. Config-valid exit 0 is NOT
production approval: `productionCloudReady` is ALWAYS false with manual gates.
Invalid input/config exits 1. No input is read from the running process environment.

Required relevant names (never put secret values into the projection): NODE_ENV,
FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, BACKEND_URL,
FRONTEND_URL/ALLOWED_ORIGINS, EVIDENCE_STORAGE_PROVIDER, optional approved
FIREBASE_STORAGE_BUCKET and bounded EVIDENCE_DAILY_FILE_LIMIT,
EVIDENCE_DAILY_BYTE_LIMIT, EVIDENCE_GLOBAL_DAILY_ALERT_BYTES. Existing requester
privacy/session features separately need REQUEST_IDENTIFICATION_ENCRYPTION_KEY,
GUEST_INVITATION_SECRET and mail-provider settings. This validator is evidence
readiness, NOT a complete replacement for application startup/secret validation.

Production must have no emulator hosts (including STORAGE_EMULATOR_HOST), no enabled
MENRO_INTEGRATION_TEST or MENRO_HISTORICAL_MIGRATION, and no enabled cloud workflow
flag. Unknown/malformed runtime flags fail closed. Project aliases must agree.
Public evidence URL declarations fail. HTTPS origin-only CORS/BACKEND_URL checks
reject credentials/query tokens; preview trust is flagged for separate review.
Current CORS origin policy/authenticated headers are unchanged. Idempotency-Key
remains emulator-cloud gated, not a production API extension.

## Confirmed source gates and production code blockers

| Source | Confirmed behavior / consequence |
| --- | --- |
| config/evidenceStorage.js | Local default; firebase workflow requires demo integration/hosts and credential-free gate |
| config/firebase.js:getStorageBucket | Lazy accessor rejects production; existing Auth/Firestore initialization retained |
| config/integrationEnvironment.js:resolveUploadRoot | CWD/uploads outside integration; MENRO_UPLOAD_ROOT ignored in production |
| evidenceAccess.service.js:cloudEvidence | Phase 8B: explicit cloudRead capability independent of new-upload provider/workflow; demo only |
| firebaseEvidenceRetrieval.service.js:guard/validateResolved | Demo emulator and bucket only, exact authorized saved context/generation; no fallback |
| firebaseEvidenceStorage/evidenceWorkflow/evidenceUploadQuota | Demo-only intents/quotas/key ledger; no production enablement merely by changing bucket |
| historicalEvidenceMigration.service.js:guard | Fixed demo namespace/temp root; not a production migration command |

**Original coupling blocker corrected in Phase 8B, emulator-only.** With explicit
EVIDENCE_CLOUD_READ_ENABLED=true and all credential-free demo guards, local uploads
and disabled cloud workflows retain authorized saved cloud reads. Production read
activation is still rejected. Local aliases are never a fallback for failed cloud
references; current local evidence is unchanged. See Phase 8B for exact procedure.

Phase 8B separates NEW-upload admission from saved cloud reads and tests mixed
local/cloud rollback in emulators. Future authorized code must still support a
separately approved real target configuration, preserving record/generation/hash
checks and read capability during write shutdown. Real-service/deployment rollback
acceptance is required BEFORE activation. Production
quota/accounting and migration-source adapters also need separate reviewed gates;
emulator approval is not permission to deploy their behavior against real data.

## Rollout stages — none executed

0. Preparation: resolve code blockers above, consistent source snapshot, tested
   encrypted backups/restore, IAM/rules/secret and operational ownership review.
1. Authorized nonproduction cloud acceptance: approve and pin exact dedicated
   tuple/prefix; use Phase 7B standalone harness with synthetic bytes; independently
   verify IAM, exact-generation/create-only/private behavior and application auth.
2. Production readiness approval: review real-service results, restore evidence,
   source exceptions, retention/version availability, costs/alerts/quotas, Linux
   native/temp capacity, ledger client denial and explicit deployment authority.
3. Controlled activation: separate task, minimal cohort/scope, monitored uploads
   and reads, durable receipts, budget enforcement, approved rollback-ready version.
   Production is still local and BLOCKED in current source; do not set firebase now.
4. Historical migration: separate task/authorization/budget and provenance-reviewed
   eligible source set; bounded CAS batches; preserve original files/revisions;
   reconcile and retrieve each accepted binding; manual resolution of unknowns.

## Rollback/recovery runbook — prerequisites, NOT executable authorization

1. Select a tested READ-COMPATIBLE release/config. Phase 8B verifies source/demo
   shutdown with ongoing reads; production target/runtime acceptance is still pending.
2. Authorized operator disables ONLY new cloud-write admission. Keep Firebase Auth,
   backend record authorization, saved-reference validation and private streaming
   active. Drain/track in-flight intents and fenced operations; don't treat a timeout
   as proof no object was created. Do not clear leases/quotas or activate schedulers.
3. Restore approved local NEW-upload provider behavior only when mixed-record
   retrieval has passed; retain cloud read capability for all committed old/current
   revisions. Never replace an explicit cloud failure with an arbitrary local alias.
4. Preserve cloud/local bytes, references, ledgers, quota/audit receipts and original
   timestamps. No delete, TTL, identity recycling or whole-document stale restore.
5. Reconcile same operation/intent after Storage success or lost business/response
   acknowledgement. Check exact binding and original source. Missing/corrupt/stale
   generations or conflicting revisions remain quarantined for manual resolution.
6. Verify owner/Staff/Admin and unrelated-user denial, current and EVERY retained
   evidence revision, parent contribution context, generation/hash/bytes, unchanged
   schedules/counts/analytics. Compare restricted manifests and redacted aggregates.
7. Stop rollout if retrieval fails. Use separately approved forward recovery or
   exact transactional reference reversal to VERIFIED preserved bytes; never delete
   cloud evidence to make provider rollback appear successful. Backup restore must
   target an isolated root first and preserve newer reviews/corrections.

## Readiness matrix

VERIFIED below means the explicit local scope ONLY. No production property is
marked VERIFIED based on mocks or emulators.

| Requirement | Status | Evidence / outstanding gate |
| --- | --- | --- |
| Cloud upload integrity | PARTIALLY VERIFIED | Hash/size/original bytes in mocks + native demo; real GCS pending |
| Real-service immutability | BLOCKED | Native emulator assertion still fails; dedicated cloud test NOT RUN |
| Private retrieval | PARTIALLY VERIFIED | Authenticated demo and corrupt/missing-object cases; real IAM pending |
| Record authorization | PARTIALLY VERIFIED | Actual demo Auth roles/ownership and existing regression; deployment pending |
| Upload quotas | VERIFIED | Synthetic admission/finalization/concurrency only; no real billing assurance |
| Migration accounting | VERIFIED | Existing fixed shared demo actor, file/byte boundaries; production policy unapproved |
| Historical sources | NOT TESTED | No production inventory/export/files consulted |
| Reference reconciliation | PARTIALLY VERIFIED | Synthetic scanner/migration; no production provenance or adapter |
| Backup and restore | NOT TESTED | Procedure prepared; real restore acceptance absent |
| Render persistence | NOT TESTED | Source root known; deployed working directory/disk/mount unknown |
| Production IAM | NOT TESTED | No service identity or cloud policy contacted |
| Storage Rules | PARTIALLY VERIFIED | Intended deny-all fixture + demo anonymous denial only; deployed publication unknown |
| Secret management | NOT TESTED | Offline names-only validator, not running credential/IAM verification |
| Cost safeguards | REQUIRES MANUAL APPROVAL | Admission quotas != global/egress/billing cap; alert ownership/budget needed |
| Crash recovery | PARTIALLY VERIFIED | Mock/demo lost response/link cases; real-service/restart durability pending |
| Monitoring revisions | VERIFIED | Existing synthetic current/reuse/replacement workflow regressions; no real data changed |
| Rollback compatibility | PARTIALLY VERIFIED | Phase 8B independent read gate and mixed/revision rollback in demo; production target/real-service acceptance blocked |
| Production deployment | BLOCKED | Code + service + inspection + authorization gates remain |

## Executed verification

Existing clean npm-ci copy, Node 22.14.0. Package/lock SHA-256 matched repository;
Admin 14.5.0, Firestore 9.3.1, Storage 8.4.0, Multer 2.4.0 and Sharp 0.35.5 unchanged.
Repository node_modules was not replaced; no installation or dependencies changed.
Current source/tests/scripts synced into the existing temporary test copy.

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| New harness + validator + existing SDK loopback transport | 46 | 0 | 0 |
| Final full backend root suite | 388 | 2 | 0 |
| Phase 5 authenticated demo workflows | 13 | 0 | 0 |
| Phase 6B scanner unit/CLI/emulator | 41 | 0 | 0 |
| Phase 6C selected NO-UPLOAD emulator checks | 5 | 0 | 0 |
| Existing Phase 1–4 Storage/retrieval/quota/config emulator | 35 | 1 | 0 |

Counts overlap; do not sum as unique tests. Final full-root runner confirmed
390 total, 388 passed and 2 failed. The harness-only group has 27 tests; validator
has 18; loopback SDK has 1. No real-service harness was executed.

Commands from the clean copy (Node 22 on PATH):

```powershell
node --test --test-reporter=spec tests/nonproductionStorageAcceptance.test.js tests/evidenceProductionReadiness.test.js tests/firebaseStorageTransport.test.js
node --test --test-reporter=spec tests/*.test.js
node --test --test-reporter=spec tests/historicalEvidenceScanner.test.js tests/integration/historicalEvidenceScannerEmulator.test.js
# Exact Phase 6C selection, with credential-free demo + migration gate:
node --test --test-reporter=spec '--test-name-pattern=dry-run defaults|missing, unsafe|shared emulator file/byte|production project/bucket|standalone CLI' tests/integration/historicalEvidenceMigrationEmulator.test.js
# With Phase 5's documented demo cloud child environment + unique temp upload root:
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test --test-reporter=spec tests/integration/evidenceWorkflowEmulator.test.js"
# Separate child, provider local, cloud/migration gates absent:
firebase emulators:exec --only storage --project demo-menro-phase2 --config firebase.storage-emulator.json "node --test --test-reporter=spec tests/integration/firebaseEvidenceStorageEmulator.test.js tests/integration/firebaseEvidenceRetrievalEmulator.test.js tests/integration/evidenceUploadQuotaEmulator.test.js tests/integration/storageConfigurationEmulator.test.js"
git diff --check
```

The fixed demo/loopback child variables and credential rejection are documented in
Phases 5/6C. No real .env loaded from the clean copy. CLI discovery config is strictly
validated/removed by existing harnesses only in their own child. Existing Firestore
8080 PID 11524 and Auth 9099 PID 16768 preserved; only task-owned free Storage 9199
started/stopped. Synthetic UUID namespaces/users/source files only; no shared reset.

**Migration upload-heavy rerun NOT EXECUTED in full this phase:** read-only demo
counter inspection found today already finalized 42/50 files, 12,138 bytes, zero
reservations. Full 18-case suite would require more than remaining 8 files. No quota
reset, identity change or backdated upload was used. Five selected no-upload checks
passed; 13 unselected cases are NOT freshly verified, regardless of reporter skip=0.
Their previously documented 18/18 result is historical, not this run. Fixed actor/
quota/lease/recovery unit regressions also run in the full root suite. Boundary
tests use their existing isolated synthetic calendar days, not today's counter.

Known failures preserved:

- connectedWorkflow.test.js:124 and :211: hardcoded 2026-10-19 release is now past;
  correct SCHEDULE_STALE. No schedule rule/fixture changed.
- firebaseEvidenceStorageEmulator.test.js:102: actual multipart sends condition 0
  but CLI 15.31.0 accepts overwrite. Diagnostic generationChanged=true and
  originalBytesIntact=false; assertion not hidden/skipped/weakened.
- An initial diagnostic invocation used stale repository dependencies and additionally
  failed uploadSecurity's malformed field case. The clean-lockfile reruns pass that
  case. This is not accepted dependency evidence; repository node_modules remains
  intentionally untouched. Initial new synthetic PNG failed local decode and was
  replaced by a locally generated valid 2x2 PNG before final harness tests.
- Blocked SDK metadata probes and Java rules-runtime shutdown EOF/NullPointerException
  are environment diagnostics, not suppressed or counted as assertion passes.

No browser/Linux/cloud IAM/backup restore acceptance claimed. No frontend build
applies. All five new JavaScript files pass node --check; git diff --check and
all eight new files' explicit trailing-whitespace checks passed. Shared emulator
PIDs are unchanged; Storage 9199 and task-owned hub/log ports 4401/4501 are closed.

## Files and production blockers by authorization type

Exactly eight NEW files; existing runtime/test/config/docs files unchanged:

- src/services/nonproductionStorageAcceptance.service.js
- scripts/acceptNonproductionEvidenceStorage.js
- scripts/validateEvidenceProductionReadiness.js
- tests/nonproductionStorageAcceptance.test.js
- tests/evidenceProductionReadiness.test.js
- docs/firebase-storage-phase7b.md
- docs/firebase-storage-phase7c.md
- docs/firebase-storage-phase8a.md

Code: explicit approved nonproduction tuple; separately reviewed production target
gates supporting the Phase 8B read/write separation; production storage/accounting/source
gates. Real service: atomic condition 0, generation reads/privacy/IAM and authorized
application access. Inspection: Render mount/current source, complete record/byte
snapshot and actual backup/restore, deployed IAM/Rules/secret/runtime settings.
Manual: resource/identity/cost/retention approval, cloud test authorization, production
code/activation approval, production migration budget/eligibility and deployment.

Smallest next action: approve exact NONPRODUCTION project/bucket/service-account
tuple and bounded synthetic test scope, review/pin allowlist and execute the Phase
7B contract probe separately. In parallel, authorize read-only Render/source/backup
inspection if desired. Independently accept read-preserving rollback against an
approved real-service/runtime target before production consideration. None follows
automatically from this report.

Both repositories' existing uncommitted work is preserved. Backend remains on
fix/validated-survival-analytics; nothing staged/committed/pushed. Frontend untouched.
Public Render guidance shaped the runbook, not a deployed infrastructure change.
Stop before real-service acceptance, production inspection, live migration or deploy.
