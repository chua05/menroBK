# Phase 3D / Phase 4 local acceptance — 2026-11-04

Backend baseline: `3651a095a174abe9cfe6e49f175708faa0288f10`.
Frontend baseline: `0f193c2c0a8bb484d24968e6ea68b8f9dc0fca31`.

Reviewed backend files:

- `src/app.js`
- `src/routes/sampleMonitoringInformation.routes.js`
- `src/routes/permanentSampleAnalytics.routes.js`
- `src/services/sampleMonitoringInformation.service.js`
- `src/services/permanentSampleAnalytics.service.js`
- `tests/sampleMonitoringInformation.test.js`
- `tests/permanentSampleAnalytics.test.js`
- `tests/helpers/emulatorTestTopology.js`
- `tests/helpers/emulatorCreatedResources.js`
- `tests/integration/phase3cBrowserServer.js`
- `tests/integration/phase3cBrowserFixtureCleanup.js`
- `tests/integration/phase3d4CleanupEmulator.test.js`
- `tests/integration/sampleMonitoringEvidenceFixtureEmulator.test.js`
- `tests/integration/evidenceWorkflowEmulator.test.js`
- This acceptance record.

## Contracts

Both new backend features require `VERIFIED_PLANTING_COHORT_ENABLED=true` plus their own gate. Gates default off. No deployed settings were changed.

`MONITORING_INFORMATION_ENABLED=true` enables:

- `POST /api/sample-monitoring-information`: Staff/Admin; `{visitId, question}` and `Idempotency-Key` (1–120 trimmed characters). Question maximum 2,000 trimmed characters.
- `GET /api/sample-monitoring-information?visitId=...`: owner Staff/Admin visit inbox. Participant inbox ignores visit filtering and includes only the authenticated recipient's records. Inboxes are bounded to the 50 newest requests; independently authorized notification links can open older records.
- `GET /api/sample-monitoring-information/:requestId`: owner Staff/Admin or intended requester only.
- `POST /api/sample-monitoring-information/:requestId/answer`: intended Participant only; `{answer, expectedVersion}` plus `Idempotency-Key`. Answer maximum 4,000 trimmed characters. Exact retries return the stored answer; altered retries/stale versions conflict.

The recipient is derived from the visit's cohort/site, `cohort.source.plantingReportId` and `source.requestId`, an authoritative approved/completed planting report with the same request ID, and `seedlingRequests.participantId`. An active Participant profile is required. Missing or changed relationships fail closed; no landowner is inferred from location, report submitter or client metadata. Staff ownership follows the accepted visit `createdBy` contract; Admin follows the existing MENRO Admin scope.

`sampleMonitoringInformationRequests` stores immutable visit/cohort/site/source bindings, requesting user/role, intended recipient, question, status (`OPEN`/`ANSWERED`), version, timestamps, private idempotency fingerprints and append-only request/reply history. Creation/answer and their notifications commit atomically using the existing notification writer. Public DTOs omit fingerprints, user identities and all private monitoring evidence. No visit, assessment, schedule, upload or KPI is mutated. Unanswered questions do not block any lifecycle action.

`PERMANENT_SAMPLE_ANALYTICS_ENABLED=true` enables `GET /api/permanent-sample-analytics` for Staff/Admin, with optional `siteId`/`cohortId`. Staff queries also require `createdBy === authenticated UID`. Only `APPROVED` visits with the current approved baseline/plan and matching site/version are comparable. More than 1,000 matched visits fails with a request to narrow filters rather than silently truncating counts.

The permanent identity is `(cohortId, sampleId)`. Each cohort's latest approved visit supplies condition counts once per approved baseline tree. Missing/unknown conditions are unassessed. Needs Rechecking, including Not Located After Rechecking, is unresolved and never converted to death. Coverage is assessed/approved-baseline samples. Chronological approved history records condition changes, explicit transitions from Unassessed and protected evidence revision indexes only. Duplicate sample IDs, ambiguous same-date approvals and invalid baseline records are excluded, with limitations disclosed. No whole-site estimate, official survival KPI, sampling percentage or scheduling rule was introduced.

## Executed results

| Suite/check | Result |
| --- | --- |
| New real-browser request/notification/reply and approved analytics workflows | 2/2 PASS |
| Existing Phase 3C real-browser aggregate | 5/5 PASS |
| Existing mocked frontend aggregate | 23/23 PASS |
| Existing credential-free backend suites, each in its own process | 135/135 PASS |
| New information/analytics service tests | 15/15 PASS |
| Per-tree emulator lifecycle/evidence regression | 7/7 PASS |
| Evidence-workflow emulator regression | 17/17 PASS |
| Independent Auth/Firestore/Storage cleanup sentinel test | 1/1 PASS |
| Frontend unit/safety/navigation regressions, including three new feature tests | 63/63 PASS |
| Changed frontend/config/test scoped ESLint | PASS |
| Normal Vite production build | PASS; existing large-chunk advisory |
| Backend JavaScript syntax and both worktree diff checks | PASS |
| Repository-wide frontend ESLint | FAIL: unchanged baseline, 2 errors / 1 warning |

The initial combined credential-free command shared CommonJS mock caches and failed. Running each existing suite in a separate Node process resolved that harness collision; all suites passed independently. Browser fixture corrections supplied actual required Participant profile fields and stable accessible filter names. No production authentication or monitoring validation was changed.

Real browser assertions cover request → real notification panel → Answer This modal → reply → Staff/Admin visibility, question/reply exact retry, changed payload conflict, stale reply, unauthenticated and non-owner denial, Participant analytics denial, unanswered-question approval, approved-only counts and unresolved-not-dead behavior. Backend tests additionally cover wrong requester/changed authoritative recipient, concurrent question retry, missing relationship, disabled gates, partial assessments, duplicate identities and approved history changes. The existing real browser verifies revisions 0/1 and private photos; the new analytics response exposes revision indexes rather than private object paths.

## Isolation and cleanup

All emulator writes used only `demo-menro-phase3c-isolated`, Auth `127.0.0.1:9299`, Firestore `127.0.0.1:8281`, Storage `127.0.0.1:9298`, Hub `127.0.0.1:4401`, bucket `demo-menro-phase3c-isolated.firebasestorage.app`, backend `5185` and frontend `5186`. Existing emulator regressions gained an explicit isolated selector while preserving their original shared-topology defaults and full application preflight. No shared dataset was queried, imported, cleared or modified.

Cleanup checks authoritative UUID ownership for information requests, notification bindings and source records in addition to accepted evidence cleanup. Explicit browser teardown runs twice. Final repeated cleanup removed zero users/documents/objects. Final Auth users and Storage objects were zero; Firestore listed no nonempty collections. A separate test proved repeated cleanup preserves independently owned Auth, Firestore and Storage sentinels, then removed only those sentinels. All eight verified launcher descendants were stopped after PID creation-time, exact command and listener ownership checks. Dedicated emulator/frontend/backend/mock ports were released. Unknown/shared processes were preserved.

## Exception and release requirements

`VerifiedPlantingCohortsPage.jsx` remains byte-identical to base `97087c9`, blob `0af80901a3f9722055ce3f457de5a8e34e619e09`: lines 48/52 `react-hooks/set-state-in-effect` errors, line 57 missing `selected` dependency warning. No suppression or unrelated edit was made. Local functional acceptance carries this documented exception; repository lint is not passing.

No credentials, generated media/logs/results, dependencies, manifests, legacy participant monitoring or official KPI changes belong in these commits. Production rollout still needs MENRO approval, API/index deployment and verification that direct client access to the new private collection is denied by deployed Firestore rules. Physical-device camera/GPS/EXIF remains separate. No production gates, scheduling/visit creation, push, merge or deployment were performed.
