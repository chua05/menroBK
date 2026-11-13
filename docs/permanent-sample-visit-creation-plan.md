# Permanent sample monitoring: policy-driven visit creation plan

Status: **plan only**. Production visit creation remains blocked (`sampleMonitoringVisit.service.create()` refuses any
request that is not an isolated test). Nothing in this document is an approved MENRO policy, and no value below may be
treated as one until MENRO approves it.

## 1. Safeguards already implemented (policy-independent)

| ID | Safeguard | Where |
|---|---|---|
| T3 | Outside isolated tests (`NODE_ENV !== "test"`), a cohort without an Admin-approved purpose-policy snapshot cannot save a sampling plan (`SAMPLING_POLICY_SNAPSHOT_REQUIRED`); a pending plan built on the test-only provisional rule cannot be approved (`TEST_ONLY_SAMPLING_POLICY_REJECTED`) but can still be returned; such cohorts cannot start a visit. | `config/verifiedPlantingCohort.js` (`provisionalSamplingAllowed`), `verifiedPlantingCohort.service.js`, `sampleMonitoringVisit.service.js` |
| T4 | At most one open visit (`DRAFT`, `RETURNED`, `PENDING_ADMIN_APPROVAL`) per cohort. The creation transaction reads the cohort document and the cohort's visits and writes `monitoringVisitCreation` on the cohort, so concurrent creations serialize and the retried transaction is refused with `OPEN_VISIT_EXISTS`. Same-date retries stay idempotent. | `sampleMonitoringVisit.service.js` `create()` |
| T6 | `GET /api/verified-sample-monitoring/readiness` (Staff/Admin, feature-gated, pilot-scoped, read-only) lists up to 25 cohorts with plain reasons: `WRITES_PAUSED`, `SAMPLING_POLICY_SNAPSHOT_MISSING`, `SAMPLING_POLICY_PENDING` (with pending items), `SAMPLING_PLAN_NOT_APPROVED`, `TEST_ONLY_SAMPLING_POLICY`, `BASELINE_NOT_APPROVED`, `OPEN_VISIT_EXISTS` (`ownedByYou` only, never another Staff identity) and always `VISIT_SCHEDULING_POLICY_PENDING`. `canCreateVisit` is always `false` until the scheduling policy exists. | `sampleMonitoringVisit.service.js` `readiness()`, controller, route |

## 2. MENRO decisions required before production visit creation

1. **Sampling values** (Purpose Policy `sampling`): `percentage`, `minimum`, `speciesAllocationProcedure`, `physicalSelectionProcedure`. The initial template values (`percentage: 10`, `intervalMonths: 12`) are not approvals.
2. **Scheduling policy** (new fields; none exist today): `firstVisitDelayWeeks`, approved `intervalMonths`, programme length or number of visits, allowed window before/after each due date, and whether a missed visit shifts later due dates.
3. **Visit creation and ownership**: which actor creates a visit (authorized Staff when due, Admin assigning a named Staff member, or an Admin-approved generated visit with an assignee). Visits are visible and editable only by `createdBy`.
4. **Rechecking timing**: whether unresolved trees wait for the next scheduled visit or allow an earlier follow-up visit; the outcome after repeated "Not Located After Rechecking" (never automatically Dead).
5. **Existing cohorts**: purpose-policy snapshots are immutable, so cohorts created under the empty template stay blocked. MENRO must decide whether Admin may adopt an approved policy per cohort through an audited action, and whether reports approved while the gate was off may receive cohorts through an explicit Admin action. No silent backfill.
6. **Cohorts without a snapshot** (legacy or provisional): excluded, or handled through decision 5.
7. **Survival treatment** for unresolved and not-located trees before any official sample survival rate is published.

## 3. Technical design after approval

- **Visit #1**: allowed when the plan and baseline are `APPROVED`, the cohort's snapshot has no pending items, the approved scheduling fields exist, no visit is open (T4), and today (Asia/Manila) is inside the approved window around `plantingDate + firstVisitDelayWeeks`. The server derives `visitDate`, `visitNumber: 1`, `dueDate`, `windowStart`, `windowEnd`; the client never supplies them. The existing deterministic visit ID, approved-unit loading and `createdBy` (per decision 3) are reused.
- **Visit #n**: allowed when the previous visit is `APPROVED`, no visit is open, and the next due date from the approved interval is inside its window. Unresolved trees continue through the existing `priorApprovedVisit` carry-forward; Tree IDs, baselines and evidence history are unchanged.
- Each visit stores the policy version and the inputs used for its dates; later policy changes never rewrite existing visits.
- Historical aggregate/full-cohort monitoring (`monitoring.service.js`) and its cadence are not changed; permanent-sample results stay out of aggregate KPIs.

## 4. Minimum code changes (after decisions 1–4)

1. `purposePolicy.service.js`: add the approved scheduling fields to `initialPolicy`, `validatePolicy`, saved settings and snapshots (default `null` = pending).
2. `samplingReadiness()`: compute due date and window for visit number *n*; add pending codes for missing scheduling fields.
3. `sampleMonitoringVisit.service.create()`: replace the `testOnly` gate with the policy checks in section 3 while keeping T3/T4, release scope, write pause and the feature gate; persist `visitNumber`, `dueDate`, `windowStart`, `windowEnd`, `policyVersion`. Keep `testOnly` for isolated fixtures only.
4. `readiness()`: set `canCreateVisit: true` only when every check passes; replace `VISIT_SCHEDULING_POLICY_PENDING` with `NOT_YET_DUE` / `OUTSIDE_WINDOW` codes.
5. Frontend: a "Start Monitoring Visit" action on the existing page when `canCreateVisit` is true; Section 2 reads the stored schedule fields. The seven-section form is unchanged.
6. Optional per decision 5: audited Admin action to adopt an approved policy for a cohort or provision a cohort for an earlier report.

## 5. Verification required

- Unit: due-date and window arithmetic against MENRO's approved values; refusal before/after the window; refusal with any pending policy item; T3/T4 regressions; readiness codes.
- Firestore emulator: concurrent creation (exactly one visit), Visit #1 → approval → Visit #2 with carry-forward, RBAC (Participant 403, unauthenticated 401, non-owner Staff hidden), write pause, pilot scope.
- Browser (real emulator): Staff "Submit Monitoring Record" → "Start Monitoring Visit" → seven-section form → Save Draft → Submit → Admin Return → correction → Approve; aggregate monitoring unaffected.

## 6. Rollout and rollback

Deploy backend code with gates off → Admin enters the approved policy → Render `VERIFIED_PLANTING_COHORT_ENABLED=true` with a pilot (`PERMANENT_SAMPLE_PILOT_ENABLED`, user and cohort IDs; note pilots do not auto-provision cohorts) → Vercel `VITE_VERIFIED_PLANTING_COHORT_ENABLED=true` and redeploy → one pilot visit cycle → full release. Rollback: `PERMANENT_SAMPLE_WRITE_PAUSED=true` (reads remain), remove the Vercel flag and redeploy, then `VERIFIED_PLANTING_COHORT_ENABLED=false`. No visit or evidence is deleted.
