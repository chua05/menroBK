# Phase 9B — IAM and test-bucket isolation review

21 October 2026. **LOCAL GUARDS VERIFIED; LIVE IAM/ISOLATION REVIEW BLOCKED.**
The Phase 9A tuple is approved FOR REVIEW ONLY, not for setup, IAM grants, credentials,
test execution or allowlist activation. No cloud resource or private evidence was
accessed. No cloud mutations, application/configuration changes or new tests.

## Review-only target

- Project: menrosystem-ddfac (production-sensitive).
- Candidate bucket: menro-gcs-acceptance-20261021-6f8c2d91.
- Proposed location/class: asia-southeast1 / STANDARD.
- Candidate identity: menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com.
- Production evidence bucket remains excluded: menrosystem-ddfac.firebasestorage.app.

## Available inspection capability and safe stop

Enabled tool metadata was searched for Firebase, Google Cloud, gcloud and IAM.
**No matching Firebase/Google Cloud connector methods are exposed in this session.**
A connection in another UI/session is not proof of callable or authorized methods
here. Local command discovery found Firebase CLI, but no gcloud executable on PATH.
The installed Firebase CLI is not used as an IAM/Cloud Storage policy inspector;
broad project enumeration would not resolve the requested effective permissions.

No login, plugin installation, account discovery, token retrieval, credential-file
read, ADC discovery, SDK workaround, browser session access or raw Google API call
was attempted. No HTTP bucket-existence probe was made. Per the user's stop rule,
live inspection stops here. Public documentation retrieval is NOT a MENRO project
query. No existing emulator/server process was started/stopped or modified.

| Requested live check | Result | Reason |
| --- | --- | --- |
| Candidate bucket exists / name available | NOT VERIFIED | No safe authenticated metadata tool available |
| Bucket ownership/project, region/class/privacy | NOT VERIFIED | No bucket metadata read |
| Candidate service account exists/enabled | NOT VERIFIED | No IAM account read |
| Actual project/folder/org roles | NOT VERIFIED | No policy read; no actual roles/principals reported |
| Incoming/outgoing impersonation and keys | NOT VERIFIED | No service-account/effective-policy inspection |
| Production bucket exposure paths | NOT VERIFIED | Policy graph unavailable; no evidence objects accessed |
| Shared billing/quotas/current alerts | NOT VERIFIED | No billing access/change |

Unverified does NOT mean absent, safe or nonexistent. Existing resources must not
be reused based on their proposed names. A denied metadata lookup cannot establish
name availability or identity absence. In particular, Google's service-account
describe reference documents PERMISSION_DENIED for both nonexistent accounts and
insufficient permission; do not interpret that as proof the account is available.

## Confirmed local harness controls

Reviewed docs/firebase-storage-phase9a.md, the acceptance service, standalone CLI
and existing offline test file. No uncovered guard gap was confirmed, so no source
or test changes were made in Phase 9B.

| Control | Source verification |
| --- | --- |
| Execution approvals | service APPROVED_TARGETS is frozen and EMPTY; review approval does not populate it |
| Same-project target | validateTarget requires the exact project+candidate bucket+candidate identity tuple |
| Production/other buckets | Same-project mismatch rejected even with permissive injected test policy; production Firebase and appspot names forbidden |
| Identity | Config identity pinned; validateCredentials matches project and client_email, with restricted credential type/token endpoint |
| Environment | NODE_ENV=test and same-project-test-bucket marker; separate execution authorization; app credential/emulator/read/write/migration/bucket env rejected |
| No fallback | Explicit bucket supplied to standalone SDK; no default bucket/project, Firebase app, ADC or production provider fallback |
| Import/preparation | No SDK client at import/default CLI; target validated before credential-file access |
| Object operations | Fixed synthetic UUID prefix/image, condition-zero save, exact string generation/hash/private checks; no list/delete/automatic cleanup |

These are local execution safeguards, NOT an IAM boundary against other code or
proof the identity has no production permissions. Trusted test dependency injection
is not a sandbox against malicious in-process JavaScript. The same-project probe
cannot run through the CLI now. No real service credentials were read or printed.

## IAM permission recommendation

Use a dedicated custom role, granted ONLY on the candidate test bucket after
separate setup approval:

| Permission | Need |
| --- | --- |
| storage.objects.create | Create synthetic objects |
| storage.objects.get | Inspect metadata and retrieve private bytes |
| storage.buckets.get | Inspect uniform access/public prevention settings |

Do not grant project-level Storage roles, Editor/Owner, Firebase Admin, Auth,
Firestore, list/update/delete, IAM mutation or impersonation permissions to the
probe identity. The setup operator/auditor is a separate identity; its required
policy-reading authority must not be granted to the test account for convenience.

For the adversarial overwrite probe, replacement permission and precondition proof
are different: Google documents object create+delete for replacement. The current
harness requires 412 and does not accept 403 as immutability success. IAM rejection
may therefore make that probe inconclusive. Any temporary delete permission must
be a separately approved, test-bucket-only decision; do not expand the normal role
or grant production deletion. Current policy/actual GCS behavior remains untested.

## Potential access paths — risks, NOT confirmed deployed findings

The following graph checks are required before claiming isolation:

1. Direct and inherited grants: inspect project, folder, organization, custom-role
   definitions and conditions, broad principal sets, groups and relevant bucket
   policies. Storage permissions are additive; a narrow test-bucket grant does not
   cancel broader grants. Bucket-only CLI policy output omits project inheritance.
2. Incoming impersonation: identify who can obtain/sign credentials for the test
   account (Token Creator, Workload Identity User, delegation/trust bindings).
   Inspect key-creation and policy-management rights without creating or reading keys.
3. Outgoing escalation: determine whether the test identity can impersonate any
   more privileged identity, create its keys, change IAM or attach it to a workload.
   Service Account User/actAs alone is NOT token minting; combined workload creation
   rights can still allow execution as a privileged account. Do not exercise these paths.
4. Production exposure: reviewer must rule out direct production-bucket grants,
   inherited Storage access, group/convenience memberships and credential chains.
   Project policy alone cannot exclude direct bucket grants. If ACL-dependent legacy
   access cannot be ruled out without evidence-object inspection, mark it unresolved;
   do NOT download or enumerate production objects to complete this review.
5. Existing project administrators may access or change the new bucket. Uniform
   access/public prevention do not make it isolated from authenticated project admins.

No actual role assignment, impersonation path or vulnerability was demonstrated.
If effective access cannot be established, or inherited access is too broad, NO GO.
Do not repair production IAM under this review. A separate-project alternative or
separately authorized security work may be necessary.

## Exact next manual action — READ ONLY, not performed here

An authorized project security administrator should use an existing approved Cloud
Console session or workstation with gcloud to inspect only the named resources and
necessary policy graph. No new login/installation/permissions are authorized here.
Suggested bounded initial metadata pass (four commands, no object operations):

```powershell
$reviewProject = 'menrosystem-ddfac'
$reviewBucket = 'menro-gcs-acceptance-20261021-6f8c2d91'
$reviewIdentity = 'menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com'
$reviewAccount = 'REPLACE_WITH_ALREADY_AUTHORIZED_REVIEWER_EMAIL'

gcloud storage buckets describe "gs://$reviewBucket" --project=$reviewProject --account=$reviewAccount --format=json
gcloud iam service-accounts describe $reviewIdentity --project=$reviewProject --account=$reviewAccount --format=json
gcloud projects get-iam-policy $reviewProject --account=$reviewAccount --format=json
gcloud iam service-accounts get-iam-policy $reviewIdentity --project=$reviewProject --account=$reviewAccount --format=json
```

Read results privately; do not paste raw policies/principals into chat, Git or logs.
Do not print access tokens or use --log-http. Limit the initial review to these four
targeted metadata requests; stop on denied/ambiguous results rather than enumerating
all buckets/accounts. If the candidate bucket exists, review its policy separately:

```powershell
gcloud storage buckets get-iam-policy "gs://$reviewBucket" --project=$reviewProject --account=$reviewAccount --format=json
```

These commands alone do NOT complete effective IAM analysis. In the authorized
IAM Console, review necessary ancestor/group/role/delegation policies and obtain
a sanitized effective-permissions determination for this identity against the
production bucket, WITHOUT listing/reading evidence. Cap supplemental review to
the target project and relevant ancestors/identities; stop and report any broader
inspection required. Do not impersonate an account or mint a token to test access.
If the account does not yet exist, broad-principal/inheritance risks can be reviewed,
but final identity-specific verification must occur after a separately approved
creation step. Report only existence status, role categories, dangerous permission
categories, scope, conditions and unresolved checks—not unrelated private project data.

## Manual setup and approval gates

Phase 9A's "Exact future manual setup" section retains the pinned bucket-creation,
new service-account/custom-role creation and bucket-only binding commands. They are
NOT authorized by this review. Do not execute those mutating commands now.

After effective-policy review, the safe setup sequence still requires separate
approval: (1) confirm name/identity status; (2) approve creation or explicitly review
any existing resource before reuse; (3) create the private Singapore/Standard test
bucket with uniform access/public prevention and approved retention; (4) create a
dedicated identity and three-permission custom role; (5) bind ONLY at test-bucket
scope, never project scope; (6) recheck effective permissions/config privately;
(7) resolve credentials and adversarial-probe permissions; (8) separately approve
allowlist activation and real synthetic testing. Cleanup remains another approval.
No Rules, Auth/Firestore, frontend, production bucket or project billing changes.

Shared project billing, service quotas, organization policy and administrator access
remain risks. Tiny synthetic objects do not isolate charges or eliminate egress and
soft-delete retention costs. The proposed operator run/cost limits are not a durable
global cap. Do not alter billing or disable project services to enforce a test budget.

## Verification, changed files and verdict

Only NEW file: docs/firebase-storage-phase9b.md. Source, tests, existing docs,
application config and execution allowlist remain unchanged. No genuine new guard
gap was found; no tests were added. Existing focused offline tests were rerun:

```powershell
node --test --test-reporter=spec tests/nonproductionStorageAcceptance.test.js
```

Node 22.14.0: **34 passed / 0 failed / 0 skipped**. Fake transports only, no cloud
SDK client/credential discovery or emulator access. This verifies local guard
regression, NOT live IAM or resource existence. No full suite/build/live acceptance
was run. Known SCHEDULE_STALE and emulator precondition failures remain unchanged.
git diff --check and new-document whitespace checks pass. Branch remains
fix/validated-survival-analytics; nothing staged/committed/pushed; all dirty work
preserved. No cloud mutation, secrets, deployment or process changes.

**Verdict: IAM/ISOLATION NOT VERIFIED — STOP BEFORE SETUP OR LIVE TESTING.**
Next required input is the authorized administrator's bounded metadata/effective-IAM
review with redacted findings. Review-only approval does not authorize bucket/account
creation, role grants, credentials, harness activation, migration or deployment.

Public primary references consulted 21 October 2026:

- [Cloud Storage IAM](https://docs.cloud.google.com/storage/docs/access-control/iam): additive hierarchy and limits of bucket-only policy output.
- [Storage permissions](https://docs.cloud.google.com/storage/docs/access-control/iam-permissions): create/get and replacement requirements.
- [Service-account authentication roles](https://docs.cloud.google.com/iam/docs/service-account-permissions): impersonation versus attachment and privilege-chain review.
- [Service-account describe](https://docs.cloud.google.com/sdk/gcloud/reference/iam/service-accounts/describe): ambiguous permission-denied result.
