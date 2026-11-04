# Permanent-sample release safeguards and operator handoff

This source preparation does not authorize deployment, production access, activation, physical-device acceptance or MENRO policy approval. No live IAM, credentials, bucket settings or index state were inspected. Historical source-remediation results remain in `production-readiness-source-remediation.md`; this document supersedes its statement that write pause and pilot controls are unimplemented.

## Control contract

Backend `src/config/permanentSampleRelease.js` validates these process-local settings before Firebase initialization and again at protected operations:

| Setting | Default | Contract |
| --- | --- | --- |
| `PERMANENT_SAMPLE_WRITE_PAUSED` | unset / `false` | Exact `true` rejects new permanent-sample mutations with HTTP 503. Authorized reads stay available. |
| `PERMANENT_SAMPLE_PILOT_ENABLED` | unset / `false` | Exact `true` requires both user and cohort membership. No Admin or Requester bypass. |
| `PERMANENT_SAMPLE_PILOT_USER_IDS` | unset | JSON array of 1–1000 distinct identifier-safe authenticated UIDs. Include approved Staff, Admin and intended Requesters. |
| `PERMANENT_SAMPLE_PILOT_COHORT_IDS` | unset | JSON array of 1–10 distinct identifier-safe existing cohort IDs. This query limit is an operational rollout bound, not a sampling rule. |

Unknown Boolean values, malformed JSON, duplicates, wildcards, empty/excessive lists and incomplete declarations fail closed with 503. Lists may be staged with an explicit `PILOT_ENABLED=false`; both must still validate. Membership is case-sensitive. A list without an explicit pilot Boolean is invalid. No browser setting can authorize pilot access.

Pilot scope supplements existing roles, Staff ownership, authoritative requester relationships and feature gates. An excluded user receives 403; an excluded cohort or related record receives a generic 404. Discovery, cohort catalogue, requester inbox and analytics constrain database queries before ordering/limits. Cursors are checked against the same scope. Question creation also checks the authoritative recipient is in the pilot before writing a notification. Removing a pilot member restricts their historical access; arrange retention/access decisions with MENRO before membership changes.

Pause covers visit create/draft/submit/review, per-tree upload, baseline registration/approval, sampling-plan save/review, permanent-sample capture-session create/verify, requester questions and replies. GET discovery/detail, historical information, approved-only analytics and authenticated private evidence continue under existing gates, roles and pilot scope. Pending mutations and completed upload retries return 503 while paused; their operation/result/capture ledgers are preserved. Read the existing result through authorized GETs or retry the same intent after an authorized resume. Do not silently alter versions, revisions or idempotency keys.

Automatic cohort provisioning during legacy report completion is deferred while paused or in pilot mode because that hook has no trusted pilot actor. Legacy report completion itself continues. This does not backfill skipped cohorts; any future provisioning/backfill requires a separately reviewed operator procedure. Participant aggregate monitoring, notifications unrelated to these questions, official KPIs and schedules retain their existing behavior.

The frontend uses authorized `writesPaused` responses to keep history visible and hide Staff editing, Admin decisions, questions and replies. The backend remains authoritative if a tab was opened before a pause. Invalid/malformed release configuration can prevent startup, intentionally; it is not a way to preserve read availability.

## Safe pause, resume and pilot operation (future authorized operator)

1. Record authorization, incident/release ticket, exact code revisions, current environment and rollback configuration. Do not put lists or credentials in public logs.
2. Drain mutation traffic and wait for in-flight transactions/uploads to finish or fail safely. Reconcile pending operations using their stored states; never delete evidence or SHA/session ledgers to make a retry work.
3. Set `PERMANENT_SAMPLE_WRITE_PAUSED=true` consistently on every backend instance, restart/redeploy all affected instances through the approved release process, and verify their sanitized startup policy fingerprints agree. Keep core and evidence-read gates unchanged to preserve authorized reads.
4. Using approved identities, verify GET visit/history/private image 200, new draft/capture/upload/question/reply/review 503, unrelated participant aggregate behavior unchanged, guest 401 and unauthorized role/owner denial unchanged. Never log tokens, private paths or photo bytes.
5. Observe 5xx, role-denial, upload/intent/lease and retrieval metrics. Alerts must distinguish intentional 503 pause responses from service failure. Logs emit only code plus policy fingerprint, not allowlists or evidence metadata.
6. To resume, drain again, validate configuration and all instances, set pause false, verify the same stable retry/ledger and a fresh permitted mutation. Keep pilot restrictions unless separately approved for expansion.
7. For a pilot, stage BOTH reviewed JSON lists, including responsible Admin and intended Requester identities; set pilot true only in an approved environment after indexes are READY. Test an allowlisted owner, excluded user, excluded existing cohort, non-owner, Requester and guest. An allowlist never grants a missing role or ownership.
8. Expand cohorts/users in explicit small batches with named approver, observation window and rollback criteria. Never use `*`, arbitrary client cohort metadata or a frontend-only gate.

These are startup/process controls, **not an atomic fleet-wide cancellation mechanism**. Repeated transaction checks narrow local races but do not cancel work on another instance or work already committed. Drain/consistent restart is required. For a suspected privacy incident, disable the affected core route/gate under incident authority if necessary; that sacrifices read availability and is a separate containment action.

Rollback preserves all new data/history and additive indexes. First pause and drain, then restore the last verified backend/frontend pair and compatible environment. Do not roll back only to code that lacks pilot enforcement while exposing the same pilot routes. Do not delete immutable revisions, consumed captures, hash reservations, completed operations or upload intents. If a safe compatible binary is unavailable, retain the guarded release paused and investigate. Disabling only a frontend flag never contains an API issue.

## Environment and feature-gate matrix

| Environment | Firebase / API | Required behavior |
| --- | --- | --- |
| Default / production settings | Existing approved identity/bucket and API configuration | All existing feature defaults remain OFF; pause/pilot default false. No activation performed by this task. No emulator variables in a real production process. |
| Existing shared test configuration | Original demo project and original approved ports | Validators preserved. Not contacted or modified by this task. |
| Release acceptance only | `demo-menro-phase3c-isolated`, Auth `127.0.0.1:9299`, Firestore `127.0.0.1:8281`, Storage `127.0.0.1:9298`, Hub `127.0.0.1:4401`, bucket `demo-menro-phase3c-isolated.firebasestorage.app`, backend 5185, frontend 5186 | Exact isolated flags, test mode and credential-free preflight. Never import shared data. Per-run UUID manifests, explicit cleanup twice and owned-process shutdown. |

Existing independent gates: backend `VERIFIED_PLANTING_COHORT_ENABLED`, `MONITORING_INFORMATION_ENABLED`, `PERMANENT_SAMPLE_ANALYTICS_ENABLED`; frontend corresponding `VITE_...` flags; cloud evidence provider/write/read settings `EVIDENCE_STORAGE_PROVIDER`, `EVIDENCE_CLOUD_WORKFLOW_ENABLED`, `EVIDENCE_CLOUD_READ_ENABLED`. Keep read enabled if authorized history is required. A cloud-write gate alone is insufficient to pause drafts/reviews/questions. Do not add emulator/test acceptance flags to deployed settings. Review actual environment resolvers before any authorized release; never paste secrets into a ticket or shell transcript.

## Source security and index review

Firestore and Storage client rules remain deny-all. They protect direct SDK/REST clients; Firebase Admin bypasses rules, so backend authorization and runtime IAM are essential. No permissive client rule was introduced for browser evidence. Streaming retrieves private objects after role/owner/cohort checks, with no public URL or client-controlled object name. Question recipients are derived from cohort → approved planting report → source request → current active Participant, never supplied by the caller. Analytics remains approved-only, owner-scoped for Staff, pilot-scoped for all permitted roles and explicitly non-official. Measurement/rechecking handling and immutable evidence revisions are unchanged.

Controller hardening makes authenticated capture actor/role, route session/cohort, file and idempotency header authoritative. Public cohort submissions whitelist fields and cannot inject internal workflow/consumption handles. Visit versions, revision binding, canonical operation identity, SHA uniqueness, nonce verification and replay checks are preserved.

The original six additive indexes in the frontend `firestore.indexes.json` match:

| Collection | Equality / ordering |
| --- | --- |
| `sampleMonitoringInformationRequests` | recipientUserId → createdAt DESC (implicit document ID DESC) |
| same | visitId → createdAt DESC (implicit document ID DESC) |
| `sampleMonitoringVisits` | visitDate DESC → document ID ASC |
| same | status → visitDate DESC → document ID ASC |
| same | createdBy → visitDate DESC → document ID ASC |
| same | createdBy + status → visitDate DESC → document ID ASC |

Nine further additive pilot indexes prepend cohortId to the four visit discovery shapes, cover cohortId + recipientUserId → createdAt DESC, and cover cohortId + status with each combination of createdBy/siteId → document ID ASC for analytics/filter pagination. Existing three notification indexes and field overrides are preserved. Cohort catalogue uses allowlisted document IDs. Staff visit information is authorized by the visit before its visitId query. Static contract tests cover the manifest; emulators do **not** prove managed composite indexes are built or optimized.

### Authorized production operator evidence required (not executed here)

| Check | Expected result / release evidence | Failure/rollback action |
| --- | --- | --- |
| Runtime Admin identity | Named approved service identity; only required project/bucket access; no unexpected default app or cross-project credentials | Keep gates off; remediate identity before release |
| IAM | Reviewed least-privilege Firestore/Auth/Storage permissions; no unnecessary project Owner/Editor; identities separated by environment | Obtain IAM/security approval; no automated broad grants |
| Credential handling | No committed service account/private key, no client-side Admin secrets; protected secret store, rotation/revocation owner and tested rollover | Rotate/revoke under operator authority; verify all instances and audit logs |
| Bucket | Exact approved project/bucket; no public IAM/ACL or download tokens exposing private evidence; uniform/private access, public-access prevention and approved location/retention | Halt exposure; keep write pause; do not make objects public to fix retrieval |
| Rules | Deployed Firestore and Storage deny-all client policies match reviewed source | Keep release disabled; review/deploy only under separate authorization |
| Indexes | Approved additive manifest reviewed; all required indexes READY; execute real role/status/site/cohort/inbox/cursor queries without missing-index errors | Do not enable pilot until READY; retain original notification indexes |
| HTTPS/CORS | Correct Vercel origin, Render API and Auth domain configuration; allowed auth/content/idempotency headers; private no-store responses, no remote mixed environment | Restore last approved origins/configuration; no wildcard workaround |
| Logging/monitoring | Redaction checked for auth headers, session nonces, tokens, private paths, requester answers and photos; alerts for denied access, stale versions, failed intents/retrieval and abnormal latency | Pause writes and investigate; restrict log access/retention |
| Recovery | Named rollback owner, compatible code pair, backups/restore validation and immutable-ledger reconciliation plan | No release without recovery rehearsal |

Rules-only auditor result (source only):

```json
{"score":5,"summary":"Firestore and Storage deny all direct client reads and writes; no create/update, self-role or ownership-rule bypass. This score covers only those client rules, not runtime IAM or the whole application.","findings":[]}
```

Runtime IAM, effective bucket policies, deployed rules, credential rotation and production index readiness remain unverified external dependencies. No production-readiness score is inferred from the rules-only result.

## User-executed physical Android / iPhone checklist

Record device/model, OS, browser/version, HTTPS test environment, date/time/timezone, authorized test identity, fixture site and explicit consent. Use disposable approved data. Never publish coordinates, credentials, photos or private paths. The user performs and signs off these tests; Chromium automation is not physical-device proof.

| Scenario | Android Chrome | iPhone Safari | Expected evidence |
| --- | --- | --- | --- |
| Successful front/rear camera, orientation, retake/cancel and track shutdown | Pending user | Pending user | Real camera preview, nonzero frame, generated JPEG, backend-verified capture, no continued camera use after close |
| Camera permission denied, revoked, unavailable/in-use | Pending user | Pending user | Accessible error/recovery; no upload or fallback file fabrication |
| Geolocation permission denied / approximate location | Pending user | Pending user | Capture blocked or explicit accuracy error; no invented GPS |
| Fresh GPS at capture after preview movement; stale cache, indoors/poor accuracy | Pending user | Pending user | Fresh location request; real accuracy/time within current backend constraints, retry improves accuracy without weakening threshold |
| Outside assigned site / Bulan boundary | Pending user | Pending user | Correct backend rejection, no evidence linkage |
| Clock skew, old/future timestamp, expired/wrong/replayed nonce | Pending user | Pending user | Unchanged server timestamp/session rejection; new capture when required |
| JPEG/EXIF/GPS edge cases, browser canvas EXIF absence | Pending user | Pending user | Existing source-specific backend policy enforced; browser verification provenance retained, no forged EXIF or claim of native-camera metadata |
| Same photo/session replay and duplicate bytes | Pending user | Pending user | Duplicate/replay protections remain active; stable exact completed retry returns original result only where allowed |
| Offline, radio change, app background/lock, interrupted verification/upload | Pending user | Pending user | Clear failure/pending state, no duplicate linkage; stable intent retry or explicit new capture after expiry/stale revision |
| Returned correction and resubmission | Pending user | Pending user | Revisions [0,1] independently retrievable by authorized Staff/Admin; original history unchanged |
| Approved, paused and wrong-owner views | Pending user | Pending user | Read-only approved/paused UI; authorized private history; denied Participant/nonowner/guest evidence; no public URL |

Measure actual time/accuracy failures and document accessibility and mobile layout. A physical failure blocks activation until resolved and rerun on both platforms. No device result is marked PASS in this package.

## MENRO decisions and production gates

- Approve permanent sample selection method/percentage, permanence/replacement rules and representative scope. Existing provisional helpers are not an official approval.
- Name the authorized visit creator/scheduler, approved intervals, escalation/rechecking responsibilities and missing/not-located investigation treatment. No production creation UI or automatic schedule exists.
- Approve any use of sample analytics in official reporting; current analytics must not replace participant aggregate survival KPIs or imply population estimates.
- Approve requester information visibility, purpose, role scope, retention/deletion/access requests and evidence/log retention. No new TTL/deletion policy is introduced.
- Name pilot users/cohorts, recipient identities, responsible Admin, observation window, support/incident/rollback owners and expansion criteria.

Production PREPARATION requires reviewed local source/tests, scoped lint/build/syntax/diff acceptance and a recorded unchanged repository-lint exception. Production ACTIVATION remains NO-GO until physical-device evidence, MENRO decisions, approved production identity/IAM/bucket/rules/index evidence, environment review, secure credential rotation, staging rehearsal and signed rollback/pilot authorization exist. Do not substitute local emulator success for those approvals.

## Executed acceptance record

Final local test totals, exception evidence, process cleanup and commit references are recorded in the accompanying `release-safeguards-acceptance.md`. No push, merge, deployment or production gate activation is included.
