# Final release-safeguards local acceptance

Accepted starting commits: frontend `6013451ece08a343a086a1487243a202e8b041c2`, backend `7af4115aba49604bda20df98503f8436d477d022`. These results were executed for the release safeguards; previous focused passes were not substituted for the aggregate runs below.

| Executed check | Final result |
| --- | --- |
| Backend credential-free aggregate, 24 separately isolated Node suites | 193/193 PASS |
| Included release configuration/service and trusted-controller/bootstrap suites | 13/13 and 3/3 PASS |
| Frontend unit/safety/index aggregate | 66/66 PASS |
| Real Phase 3C browser aggregate | 5/5 PASS |
| Real requester communication / approved analytics | 3/3 PASS |
| Same real communication suite with cloud evidence writes disabled | 3/3 PASS |
| New real Auth/API write-pause suite | 1/1 PASS |
| New real Auth/API pilot suite | 1/1 PASS |
| Existing mocked frontend Playwright aggregate | 25/25 PASS |
| Per-tree Firebase Emulator lifecycle/security/idempotency | 7/7 PASS |
| Legacy evidence workflow emulator with permanent-sample pause ON | 17/17 PASS |
| Repeated UUID cleanup preserving independent Auth/Firestore/Storage sentinels | 1/1 PASS |
| Scoped frontend ESLint | PASS |
| Normal Vite production build | PASS (existing large-chunk warning) |
| Backend changed/new JavaScript syntax checks | 17 files PASS |
| Both worktree diff whitespace checks | PASS |
| Dependency manifests/lockfiles | Unchanged |
| Repository-wide `npm run lint` | FAIL: unchanged baseline 2 errors, 1 warning below |

The final native Vite build passed with the same native-binary permissions used by the existing browser/build harness. An intermediate restricted-process attempt could not load the installed Tailwind native binary; no package was reinstalled or changed to resolve that execution restriction. No failed or skipped acceptance test was counted as a pass.

## Reproduction and isolation

- Frontend: `npx playwright test --config playwright.phase3c-isolated.config.js --reporter=list`; `playwright.phase3d4-isolated.config.js`; `playwright.phase3d4-readonly-evidence.config.js`; `playwright.release-paused.config.js`; `playwright.release-pilot.config.js`; existing mock `playwright.phase3c.config.js`.
- Backend: individual `node --require ./tests/testSetup.js --test --test-isolation=none tests/<suite>.test.js` processes avoid CommonJS mock-cache contamination. `NODE_PATH` points to existing original-backend dependencies; no dependency installation.
- Emulator regressions: explicit isolated topology and test-only demo environment, `node --test --test-isolation=none tests/integration/sampleMonitoringEvidenceFixtureEmulator.test.js` and `tests/integration/evidenceWorkflowEmulator.test.js`. The latter was run with `PERMANENT_SAMPLE_WRITE_PAUSED=true` and the cohort gate enabled, proving legacy planting/aggregate operations remain functional during a permanent-sample hold.
- All service I/O used `demo-menro-phase3c-isolated`, Auth9299/Firestore8281/Storage9298/Hub4401 and the exact isolated bucket. Real browser APIs used backend5185/frontend5186 with real AuthProvider/authenticatedApi/camera; external browser origins were blocked. Only the separate mocked suite used its existing mock aliases. Shared topology was exercised by pure validator tests only, never by accessing shared data.
- Fresh Firebase CLI launcher root PID13772 and its original creation time/command were recorded. Dedicated Auth/Storage/Hub listeners belonged to PID15528; Firestore listener to PID33480, both verified descendants. No shared import occurred. All six emulator/backend/frontend ports were released after owned-process shutdown. Unknown processes were preserved.

## Security findings and limits

Read pause returns 503 for permanent mutations while preserving authenticated visit/information/history/private image reads. Real pause teardown compared a fixture-scoped digest of visit/cohort, capture/hash/intent/workflow records, information/notification records, quota ledgers, linked bytes and all actor-owned Storage objects, including possible orphan objects; it remained unchanged. The normal backend role/ownership checks remain in place. Pilot requires both user/cohort membership; tests cover excluded users, excluded existing cohorts, forbidden cursors, Staff ownership, Participant denial, query constraints before pagination and both notification directions. Real pilot verifies the allowlisted catalogue, discovery, history and draft write; a forged capture actor cannot bypass it.

Real Phase 3C verifies browser-generated JPEG, fresh seeded GPS, session verification, private upload/retrieval, returned correction/resubmission/approval, immutable revisions [0,1] and approved read-only state. Backend emulator cases additionally exercise exact completed retry, replay, SHA reservation, wrong binding, stale version and unauthorized retrieval. These backend-only assertions are not described as physical/browser-device proof. The legacy 17-case suite confirms planting/participant aggregate scheduling/KPI contracts stay intact during pause. No visit creation UI, production scheduling, sampling rule, retention/TTL or official KPI change was introduced.

Client Firestore/Storage deny-all rules and original notification indexes are unchanged. The six earlier additive index signatures and nine new pilot query signatures are source-tested. Actual managed index build state, IAM, bucket exposure, production credentials/rotation and deployed policy remain unverified. The full operator and physical-device package is `permanent-sample-release-handoff.md` in the backend worktree.

Repository lint exception: `src/pages/VerifiedPlantingCohortsPage.jsx` lines48/52 `react-hooks/set-state-in-effect`, line57 `react-hooks/exhaustive-deps` missing `selected`. Current and base97087c9 blobs independently equal `0af80901a3f9722055ce3f457de5a8e34e619e09`. No modification or suppression. Functional/scoped acceptance is recorded with this known exception, never as a repository-wide lint PASS.

## Cleanup and reviewed release contents

Every browser teardown executed explicit UUID-owned cleanup twice. Independent sentinel acceptance verified repeated cleanup leaves unrelated Auth, Firestore and Storage resources intact, then removed its own sentinels. Final read-only isolated checks returned **0 Auth users, 0 Firestore collections, 0 Storage objects**. Per-tree cleanup reported16 created records removed; legacy workflow cleanup reported259 records and19 owned objects removed. No shared emulator record was read/deleted, and no production credentials or endpoint was used.

Reviewed backend files (19):

- `src/config/firebase.js`, `src/config/permanentSampleRelease.js`
- `src/controller/evidence.controller.js`, `src/controller/evidenceCaptureSession.controller.js`, `src/controller/verifiedPlantingCohort.controller.js`
- `src/services/evidenceAccess.service.js`, `src/services/evidenceCaptureSession.service.js`, `src/services/permanentSampleAnalytics.service.js`, `src/services/sampleMonitoringEvidence.service.js`, `src/services/sampleMonitoringInformation.service.js`, `src/services/sampleMonitoringVisit.service.js`, `src/services/verifiedPlantingCohort.service.js`
- `tests/integration/phase3cBrowserCleanup.js`, `tests/integration/phase3cBrowserServer.js`, `tests/integration/permanentSampleReleaseFixture.js`
- `tests/permanentSampleRelease.test.js`, `tests/permanentSampleRelease.controllers.test.js`
- `docs/permanent-sample-release-handoff.md`, `docs/release-safeguards-acceptance.md`

Reviewed frontend files (11):

- `firestore.indexes.json`
- `src/components/MonitoringInformationPanel.jsx`, `src/pages/MonitoringInformationPage.jsx`, `src/pages/PermanentSampleMonitoringPage.jsx`
- `tests/monitoringIndexes.test.js`, `tests/phase3c/realTeardown.js`, `tests/e2e/permanent-sample-release.spec.js`
- `playwright.release-paused.config.js`, `playwright.release-pilot.config.js`
- `docs/permanent-sample-release-handoff.md`, `docs/release-safeguards-acceptance.md`

The repository-required frontend `graphify update .` completed AST extraction locally without an API call. Generated graph/cache/backups remain unstaged and excluded from release commits. No generated media, logs, runtime fixture records, secrets, `.env` or dependency manifests are release contents. Local logs/manifests are retained only under the existing test-evidence TEMP area.

## Decision

**Production PREPARATION: GO at source/local acceptance level with the documented existing lint exception. Production ACTIVATION: NO-GO.** The user must complete Android/iPhone camera/GPS/EXIF acceptance; MENRO must approve sampling, visit creation/scheduling, intervals, rechecking, official reporting use and information/retention policy; authorized operators must verify production IAM/bucket/credentials/rules/index readiness and sign off the staged pilot/rollback plan. No such external approval is inferred here.

Separate scoped local commit hashes are provided in the final handoff; the commits can also be identified from each worktree's local log. No push, merge, deployment, live configuration change or production feature activation is authorized by this acceptance.
