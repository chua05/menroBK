# Permanent-sample activation and historical cohort recovery

This note describes how the permanent-sample (Survival Monitoring) gates fit together. It does not authorize deployment, activation, production access or any MENRO policy decision. The release and incident controls stay in `permanent-sample-release-handoff.md`.

## Settings and dependencies

All settings are read by the backend process. Unset means off.

| Setting | Documented value | What it does | Depends on |
| --- | --- | --- | --- |
| `VERIFIED_PLANTING_COHORT_ENABLED` | `false` | Provisions one cohort when an Admin verifies an eligible Planting Report, and opens the cohort/visit routes. Off: routes return 409 `COHORT_WORKFLOW_DISABLED` and no cohort is created. | - |
| `PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED` | `false` | Visit 1 registers the 10% sample and the baseline. Off: a cohort with no plan and no baseline reports `FIRST_VISIT_POLICY_DISABLED`. | Cohort flag |
| `PERMANENT_SAMPLE_SCHEDULE_ENABLED` | `false` | Opens visits on the approved calendar. Off: every cohort reports `VISIT_SCHEDULING_POLICY_PENDING`. | Cohort flag |
| `VERIFIED_REPORT_FIRST_VISIT_ENABLED` | `false` | Every Admin-verified report with a valid quantity and site can start the simplified Visit 1, whatever method was stored. See "Verified-report rule". | Cohort, first-visit and schedule flags |
| `PERMANENT_SAMPLE_ORIGINAL_PHOTO_ENABLED` | `false` | Upload Existing Photo: accepts original JPEGs with embedded GPS, an unambiguous capture time on the Date Monitored, inside the planting site and not a duplicate. GPS accuracy is unknown, so Admin must acknowledge each one at approval. Off: Take Photo only. Exactly `true` or `false`; anything else answers 503. MENRO must approve these rules first. | Cohort flag |
| `PERMANENT_SAMPLE_PILOT_ENABLED` | `false` | Restricts all access to listed users AND listed existing cohorts. | Both pilot ID lists |
| `PERMANENT_SAMPLE_WRITE_PAUSED` | `true` | Rejects permanent-sample changes with 503; authorized reads stay available. | - |

Exact parsing:

- Cohort flag: only `true` (surrounding spaces and letter case ignored) is on. Anything else is off.
- First-visit, schedule and verified-report flags: spaces and letter case ignored; `true` is on, `false`, empty or unset is off, and any other value fails closed with 503.
- Pause and pilot flags: exactly `true` or `false`. Any other value, including an empty one, other letter case or extra spaces, refuses startup and answers 503.
- **An UNSET pause means writes are allowed.** Only an explicit `PERMANENT_SAMPLE_WRITE_PAUSED=true` pauses. Never remove the variable to "reset" it.

The pilot ID lists stay commented out in `.env.example`: a list without an explicit pilot Boolean, or an empty list, is invalid.

Local effect of `PERMANENT_SAMPLE_WRITE_PAUSED=true`: a developer who copies `.env.example` gets paused writes. Creating, saving, submitting or reviewing a visit, capture and upload answer 503, and verifying a report creates no cohort. For local work on these features set it to `false` in your own environment only. Tests that depend on writes set `false` explicitly.

`GET /api/verified-sample-monitoring/readiness` returns the same state to Staff and Admin as `gates` (`writesPaused`, `firstVisitBaselineEnabled`, `scheduleEnabled`, `pilotRestricted`), Booleans only.

## Which reports get a cohort

One rule (`src/services/verifiedPlantingCohortEligibility.js`) is used by automatic provisioning, readiness and recovery:

- Admin-verified with a positive whole-number quantity: a parent report with `reportingProgress` Completed and its `acceptedQuantity`, otherwise an Approved report and its `quantityPlanted`.
- Stored monitoring policy `PERMANENT_SAMPLE` in the flat value, the nested value, or both when they match. Different flat and nested values are `POLICY_CONFLICT` and fail closed. `STAFF_SPOT_CHECK`, `NONE`, `PENDING_MENRO_POLICY` and unknown values are not eligible.
- A report with no policy snapshot keeps its existing automatic provisioning, but is **not** recovered by the historical tool without MENRO approval.

A stored policy is never converted, and reports, existing cohorts, plans, baselines, visits, MON records and aggregate monitoring are never rewritten.

## Verified-report rule

With `VERIFIED_REPORT_FIRST_VISIT_ENABLED=true`, reports stored as `STAFF_SPOT_CHECK`, `PENDING_MENRO_POLICY` or `NONE` follow the simplified first visit too. Conflicting, unreadable and unrecognized methods stay closed, and quantity, verification, site, date, species (L1), photo, GPS, role, pause and pilot checks are unchanged.

- Staff start Visit 1 from the existing report (`POST /api/verified-sample-monitoring/verified-reports/:reportId/first-visit`). The single cohort is created in one transaction after every check, or reused; a retry is safe. No backfill, resubmission or re-approval is needed.
- The report is never written. The cohort keeps `eligibilityAuthorization`: policy `menro-verified-report-first-visit-v1`, the original stored method and policy values, what triggered it (an Admin verification or a Staff start), the Staff UID for a start, and when. Every later step up to baseline approval follows that record, and the earlier sampling-plan and baseline routes refuse such a cohort (`FIRST_VISIT_BASELINE_ACTIVE`).
- Admin verification of a new report also creates its cohort under this rule (cohort and rule flags on, not paused, no pilot); the visit itself still needs the first-visit and schedule flags.
- Turning the flag off blocks starting, submitting and approving Visit 1 again for cohorts whose stored method needs the rule. It deletes nothing, and approved baselines continue.
- A cohort ID is known before the cohort exists, so a pilot can list it in advance. The recovery dry run prints it as the expected cohort ID.
- The historical recovery tool keeps its stricter decisions and does not apply this rule.

## Pause and pilot effects on provisioning

Automatic provisioning during report verification is skipped while writes are paused **or** while the pilot is on, because that step has no trusted pilot actor. The report is still verified. Skipped cohorts are not created later by themselves: resuming writes or ending the pilot does not backfill them. Reports verified while the cohort flag was off are in the same position. Use the recovery dry run below to list them.

Recovery goes through the same provisioning function, so it is also gated: while paused, in pilot mode or with the flag off it reports `PROVISIONING_GATED` and writes nothing.

## Safe order

Starting state in production, as reported by the project owner: `VERIFIED_PLANTING_COHORT_ENABLED=true`, `PERMANENT_SAMPLE_WRITE_PAUSED=true`, and the first-visit, schedule and pilot flags unset.

**Every step needs its own MENRO authorization**, a named rollback owner and a check before the next step. Nothing in this document authorizes a step. **Production recovery execution is not available**: the tool refuses it, and it needs a separate approved plan.

A pilot needs cohorts that already exist, and provisioning does not run while the pilot is on. Without the pilot, turning on first-visit and schedule while unpaused opens Visit 1 to all Staff. So provision first, then restrict, then open:

1. Record the MENRO decisions below and the exact backend/frontend revisions.
2. Deploy code with the cohort flag on, writes paused, and first-visit, schedule and pilot off. Confirm `gates` in readiness. Run the recovery dry run and have MENRO review every decision.
3. Provision only: keep first-visit and schedule **off**, pilot off, and set the pause to `false`. Newly verified eligible reports get a cohort; no visit can be opened. The legacy sampling-plan and baseline routes are writable in this window, so keep it short and supervised. Historical reports are not backfilled.
4. Once the agreed reports are verified and have cohorts, set the pause back to `true`.
5. Stage both reviewed pilot lists with those cohort IDs and set `PERMANENT_SAMPLE_PILOT_ENABLED=true`. Check that excluded users and cohorts are refused.
6. Still paused: turn on `PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED`, then `PERMANENT_SAMPLE_SCHEDULE_ENABLED`. Check the reasons in readiness after each.
7. Set the pause to `false`. Only listed users can open Visit 1, and only for listed cohorts.
8. New cohorts later: pause, turn first-visit and schedule off, end the pilot, and repeat from step 3. Opening to all Staff (pilot off with first-visit and schedule on) is a separate MENRO decision.

## Recovery dry run

The dry run uses one Firestore read-only transaction and needs an explicit list of 1-20 report IDs. It prints report number, decision, reasons, quantity, expected cohort ID, notes and a 16-hex digest. It prints no names, photos or coordinates.

Google Cloud Shell, with your own sign-in and never a key file:

```sh
gcloud config set project menrosystem-ddfac
NODE_ENV=production FIREBASE_PROJECT_ID=menrosystem-ddfac \
  node scripts/recoverHistoricalCohorts.js --reports=<id>,<id> \
  --expected-project=menrosystem-ddfac --expected-principal=<you@example.com>
```

Demo emulators (validated MENRO integration environment): `node scripts/recoverHistoricalCohorts.js --reports=<id>,<id>`. Only there, in test mode, can `--execute --confirm-digest=<digest>` be added. There is no override flag.

| Decision | Meaning | Next step |
| --- | --- | --- |
| `ELIGIBLE_MISSING_COHORT` | Verified, compatible, no cohort | Candidate for a separately approved execution |
| `ALREADY_PROVISIONED` | Its cohort exists | None |
| `INCOMPATIBLE_POLICY` | `STAFF_SPOT_CHECK` or `NONE` | None; the method is not changed |
| `CONFLICTING_POLICY` | Flat and nested values differ | MENRO review of the source record |
| `REQUIRES_MENRO_APPROVAL` | No snapshot, pending, unspecified or unknown method | MENRO decision |
| `UNVERIFIED_REPORT` / `MISSING_AUTHORITATIVE_QUANTITY` | Not finally verified, or no positive whole-number quantity | Normal report workflow |
| `INVALID_SITE` | Site missing, not found, inactive, or different on report and event | Correct through the normal workflow |
| `COHORT_IDENTITY_CONFLICT` | The expected ID belongs to another report, or another cohort claims this report | Stop; investigate |
| `REPORT_ARCHIVED` / `REPORT_NOT_FOUND` | Archived or absent | None |

`MULTI_SPECIES` and `MISSING_PLANTING_DATE` are notes: the cohort could be created, but multi-species first visits remain blocked (`SPECIES_ALLOCATION_PENDING`).

Execution (emulator only) stops before any write if the digest differs, runs one transaction per report, re-reads and re-decides, and can create only the expected cohort document. A report that changed after the digest check is `REPORT_CHANGED`. A failed transaction stops the run and reports what completed; take a new dry run before repeating.

## MENRO decisions needed

- Approve the 10% first-visit sample rule and the visit calendar for official use.
- Species allocation for multi-species cohorts.
- Policy for verified reports with no, pending, unknown or conflicting monitoring policy.
- Whether historical reports may be recovered at all, the approved report list, approver and operator.
- Pilot users and cohorts, observation window, and who may resume writes.

## Rollback

1. Set `PERMANENT_SAMPLE_WRITE_PAUSED=true` on every instance and restart through the approved process. This stops new changes and keeps authorized reads.
2. Turn the schedule flag, then the first-visit flag, off. Existing plans, baselines and visits are kept; an unfinished first visit waits and reports its reasons.
3. Turn the cohort flag off only if reads must also stop.
4. Do not delete cohorts, plans, baselines, visits, evidence or ledgers. A cohort created by mistake is reported and left unused until MENRO decides.
