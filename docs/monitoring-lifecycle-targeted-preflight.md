# Monitoring lifecycle correction and target-scoped preflight

Local implementation and acceptance dated 19 November 2026. No production backfill has run.

## Confirmed causes

Automatic registration runs during Admin verification. It does not retroactively register reports verified before its deployment. Loading Survival Monitoring is read-only and does not migrate historical reports.

Production Console evidence supplied by MENRO identifies project `menrosystem-ddfac`, database `(default)`, reports `event_EVT-2026-025` (`RPT-2026-020`) and `event_EVT-2026-029` (`RPT-2026-024`), with `reportingPolicy.definition.monitoring = STAFF_SPOT_CHECK`. The earlier reader recognized only the flattened `reportingPolicy.monitoring`. The corrected reader supports both representations, preserves the snapshot, and refuses to resolve contradictory values silently. This mismatch explains the wrong method interpretation; it does not by itself prove why a historical lifecycle is absent, since the old registration also allowed unspecified tracking methods.

The collection not appearing in the supplied Console view is evidence of no visible records there, not a substitute for an authorized target preflight. Individual verification timestamps and matching historical records have not been read from production by this task.

## Registration behavior

- Only an eligible verified/completed, unarchived report is registered; `NONE` does not require monitoring registration.
- Nested and flattened snapshots remain compatible. Conflicting stored methods are left unresolved; report verification is not converted into a monitoring exemption or authorization.
- A deterministic lifecycle document ID and transactional Manila-year counter produce one sequential `MON-YYYY-NNN` number under normal concurrent registration.
- Existing numbers/history are retained. This correction does not relabel old lifecycle methods, repair historical duplicates, reset counters, or change existing schedules.
- Staff Spot-Check registrations remain `AWAITING_MONITORING_POLICY` / Awaiting Monitoring Setup, with null start/next/end dates and no observations or visits.
- A MON number is an identifier, not approval of a monitoring procedure. No Staff Spot-Check submission workflow is enabled.

## Safe preflight

The former global backfill command is replaced by a dry-run-only preflight. Its production scope is immutable:

| Document ID | Report number |
| --- | --- |
| event_EVT-2026-025 | RPT-2026-020 |
| event_EVT-2026-029 | RPT-2026-024 |

After separate approval, use an existing authorized operational context whose production environment and credentials are already configured. Do not copy a production service account into a developer checkout, change Firebase settings, or create a new connection.

```text
node scripts/backfillMonitoringLifecycles.js --expected-project=menrosystem-ddfac
```

This command was not executed against production during local acceptance. The CLI requires production mode and the matching configured project before Firebase initialization. The planner compares the resolved SDK project, declared project IDs and `(default)` database before any reads. Other projects, emulator/production mixtures, global options, target overrides, `--apply`, and write-confirmation options are rejected.

The SDK transaction is read-only. It reads the two explicit report IDs and checks report-number uniqueness, all related and canonical lifecycle documents including archived/noncanonical records, and stored policy/method/relationship consistency. It also scans a minimal projection of monitoring IDs across monitoringRecords and reads the current Manila-year counter for duplicate, malformed, stale, missing, wrong-type/year and exhausted-counter detection. This integrity scan includes number metadata beyond the two reports but never proposes changes to other reports. It emits no names, contacts, photos, coordinates, credentials or future allocated MON IDs.

Results are `REGISTER`, `ASSIGN_NUMBER`, `KEEP` or `BLOCKED`, with explicit reasons and counts. A missing or wrong legacy planting date, a conflicting policy, unrecognized method, malformed number, historical duplicate, archived lifecycle, changed relationship or invalid counter blocks the plan. Any blocking result requires review; do not rerun Admin approval, unarchive records, alter a stored policy or reset a counter to force registration.

## Deployment and later write sequence

1. Review and separately approve the local changes and test evidence. No commits, pushes or deployments are included in this task.
2. After approved deployment, verify the backend source version and frontend method display. Deployment alone will not register old reports.
3. Obtain separate approval for the production read-only preflight, including its numbering-integrity read scope. Verify project/database/identity and run the exact dry-run-only command above.
4. Review both report states, canonical/noncanonical/archived matches, all block reasons, counter integrity and exact intended side effects. New legacy registrations would derive existing legacy-rule dates; Staff Spot-Check registrations have no new schedule dates.
5. Obtain separate approval for a reviewed, target-scoped write operation using the existing registration service. This CLI deliberately exposes no apply path. Do not use an earlier version's global `--apply`. Any future writer must revalidate the target policy, relationships and numbering state transactionally, account for partial failure, and retain an operational snapshot.
6. After any separately authorized write, confirm exactly one valid numbered lifecycle per target, unchanged report policy/history/evidence/existing dates, null Staff Spot-Check schedule dates, and Awaiting Monitoring Setup. Repeat registration should return `NO_CHANGE`; monitoring creation and submissions remain blocked pending approved policy.

Local emulator acceptance is not permission to create production records or approve a MENRO monitoring procedure.

## Executed local acceptance

| Check | Completed result |
| --- | --- |
| Lifecycle registration and target historical preflight, real Firestore Emulator | 9/9 PASS |
| Participant/Staff report approval and automatic lifecycle registration, real Firestore Emulator | 4/4 PASS |
| Focused credential-free backend monitoring regressions | 95/95 PASS |
| Focused frontend monitoring unit regressions | 36/36 PASS |
| Focused mocked-browser monitoring regressions, including nested policy for Staff/Admin | 9/9 PASS |
| Scoped and repository-wide frontend ESLint | PASS |
| Frontend Vite production build to external output directory | PASS; chunk-size warning retained |
| Backend JavaScript syntax checks, seven affected files | PASS |
| Git diff checks | PASS in both worktrees |

The browser tests use the existing API/Auth mocks; they do not replace real browser-to-production acceptance. The two emulator suites use real Firestore transactions against a fresh, credential-free `demo-menro-legacy-monitoring-20261106` dataset: Auth 9399, Firestore 8381, Storage 9398 and Hub 4402, with loopback-only networking. The pre-existing Firestore process on 8281 was preserved. Clean Auth/Firestore/Storage was checked before tests. Fixture cleanup and owned-counter cleanup passed twice (second pass a no-op). The CLI exited zero; its leftover owned Firestore child was independently verified and stopped. All test ports were then confirmed released. A Storage rules-runtime warning occurred during shutdown after successful tests.

No production report, lifecycle or counter was read or written in this acceptance. The two production document/number pairs are based on the supplied Console evidence, not synthetic test outcomes. Existing unrelated modified/untracked files and the 72 recorded ignored artifacts remain byte-identical to their preservation manifests. No dependency, manifest, Git history or deployment changes were made.

One pre-existing issue outside these two Staff Spot-Check targets remains: `verifiedPlantingCohort.service.js` still checks only flattened monitoring policy when deciding whether to create a permanent-sample cohort. Nested-only `PERMANENT_SAMPLE` cohort provisioning needs its own scoped review; it was not changed here. It does not authorize Staff Spot-Check visits or affect the two-target preflight.

## Exact implementation files

Backend:

- scripts/backfillMonitoringLifecycles.js
- src/services/monitoringLifecycleRegistration.service.js
- src/services/monitoringLifecycleBackfill.service.js
- tests/monitoringLifecycleStatus.test.js
- tests/monitoringLifecycleBackfill.test.js
- tests/integration/monitoringLifecycleRegistrationEmulator.test.js
- tests/integration/plantingReviewWorkflowEmulator.test.js
- docs/monitoring-lifecycle-targeted-preflight.md

Frontend:

- src/utils/monitoringStatus.js
- tests/monitoringStatus.test.mjs
- tests/monitoringTracking.test.mjs
- tests/e2e/phase3c-routing.spec.js

Other modified/untracked files that predated this task remain excluded and unchanged. Test coordinators, logs, and the build output are local artifacts beneath the dedicated temporary evidence directory, not application or deployment configuration.
