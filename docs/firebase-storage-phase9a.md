# Phase 9A — same-project GCS test bucket preflight

21 October 2026. **OFFLINE PREPARATION COMPLETE; CLOUD EXECUTION NOT AUTHORIZED.**
No cloud/plugin resource access, IAM query/change, bucket creation, credentials,
test upload, emulator operation, production evidence read, deployment or migration.
All existing resources in menrosystem-ddfac remain production-sensitive.

## Proposed configuration — subject to explicit approval

| Setting | Proposal |
| --- | --- |
| Project | menrosystem-ddfac (existing production-sensitive project) |
| Dedicated bucket | menro-gcs-acceptance-20261021-6f8c2d91 |
| Location | asia-southeast1, Singapore, single region |
| Class | STANDARD; no Autoclass, dual-region or replication additions |
| Test identity | menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com |
| Objects | menro-acceptance/<fresh lowercase UUID>/synthetic.png ONLY |
| Privacy | Uniform bucket-level access + enforced public access prevention |
| Encryption | Default Google-managed at rest; no new KMS/IAM dependencies |
| Retention | No retention lock, legal hold, versioning or automatic lifecycle deletion |
| Soft delete | Explicit 7 days, proposed for this NEW bucket only; costs persist after deletion |
| CORS/public URLs | None; server-side SDK only; no Firebase download tokens |
| Cleanup | Separate approval, exact synthetic names/generations and custody manifest; never automatic |

The randomized name is a CANDIDATE, not proof of global availability, ownership or
existence. No availability lookup was made. If occupied, STOP: approve another
name and update BOTH pinned guard and tests; never silently append a suffix or
reuse an existing bucket. Region requires MENRO approval for this synthetic test;
it does not describe the existing bucket's location, which was not inspected.
Do not add this bucket to Firebase, the frontend SDK, application .env or Render.

## Local source audit and changes

Reviewed Phases 7B/8A/8B, standalone CLI/service/tests and evidence storage config.
Application remains local by default; Phase 8B cloud reads/writes remain DEMO ONLY.
No application Firebase configuration, auth, Firestore, Rules or workflow changed.

The old standalone harness denied the entire project. Phase 9A prepares a narrowly
pinned exception ONLY for the proposed project+bucket+identity tuple. The CLI's
APPROVED_TARGETS remains frozen and EMPTY: neither the candidate nor any live
target can execute, even with the CLI execution flag. Tests inject fake approvals
only to exercise guards with fake transports, not to authorize live resources.

For this project a caller cannot choose another bucket or identity, even via a
permissive injected test policy. The existing production Storage bucket and its
legacy appspot name remain forbidden. Missing/wildcard/URL/alternate buckets fail.
The distinct MENRO_GCS_ACCEPTANCE_ENV marker must be same-project-test-bucket;
NODE_ENV=test, independent execution authorization and explicit matching identity
are still required. No ADC, Firebase app initialization, default project/bucket,
environment bucket fallback or automatic deletion. New guards reject application
cloud-read/migration/bucket environment settings to avoid a mixed test/runtime.
No-argument CLI remains a zero-network report; imports load no Storage SDK client.

Before any future execution, a separately reviewed code change must put ONLY the
approved tuple into APPROVED_TARGETS. CLI config alone cannot approve it. The
application's guards are NOT relaxed by this isolated acceptance service change.

## Minimum IAM and the same-project risk

Normal create/read/privacy inspection needs exactly:

- storage.objects.create
- storage.objects.get (metadata and bytes)
- storage.buckets.get (privacy settings)

Use a dedicated custom role, bound ONLY on the new test bucket. No project-level
role binding, Editor/Owner, Storage Admin, Firebase Admin, object list/update/delete,
Auth/Firestore, service-account impersonation or key-management permissions for
the test identity. Do not reuse the existing backend service account or plugin
identity. A separate authorized reviewer/operator inspects IAM; do not broaden the
probe identity to read/change project IAM or create buckets/accounts/roles.

Important real-service blocker: Google's permission reference says replacement
needs object create AND delete. Without delete, an attempted overwrite MAY be
denied by IAM instead of proving the expected 412 precondition. The existing
harness deliberately accepts ONLY 412 as create-only proof, never substitutes 403.
Before real testing, approve whether an additional short-lived, test-bucket-ONLY
delete grant is needed for the adversarial precondition probe. Do not grant delete
on production or silently expand the normal three-permission role. Record IAM
denial separately from precondition enforcement. No live result is asserted here.

Bucket IAM does NOT isolate against existing project/folder/org-wide grants.
Uniform access removes object ACL behavior; public access prevention does not
exclude authenticated inherited administrators. An authorized security reviewer
must examine effective policies/conditions/group membership, broad principal sets,
service agents and impersonation/key creation rights. Certify that the NEW test
identity has NO effective Auth/Firestore/production Storage/admin access. This
must be established by authorized policy analysis, NOT by probing production
objects or listing the production bucket during acceptance testing.

**Isolation cannot currently be guaranteed:** no live IAM inspection is authorized
or performed. If inherited grants prevent least privilege, STOP the same-project
path. Do not rewrite production IAM as a workaround; obtain a separate-project
decision or separately authorized security remediation. Backend/project admins may
still access a test bucket; do not call it a fully isolated security boundary.

## Exact future manual setup — NOT EXECUTED / requires separate approval

The following mutate cloud resources. They are instructions ONLY, not authorization.
Do not paste/run the block until resource creation AND new role/account/bucket IAM
changes are explicitly approved. Use an authorized operator session, never a Codex
plugin mutation or a backend credential. Every command pins its project and target;
do not change global gcloud project config or enable APIs/billing to make it work.
If any proposed name/identity/role exists already, STOP and inspect under separate
read-only authorization; never reuse or update it without review.

```powershell
$testProject = 'menrosystem-ddfac'
$testBucket = 'menro-gcs-acceptance-20261021-6f8c2d91'
$testIdentity = 'menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com'
$setupAccount = 'REPLACE_WITH_SEPARATELY_AUTHORIZED_OPERATOR_EMAIL'

gcloud storage buckets create "gs://$testBucket" --project=$testProject --account=$setupAccount --location=asia-southeast1 --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=7d

gcloud iam service-accounts create menro-gcs-acceptance --project=$testProject --account=$setupAccount --display-name='MENRO synthetic GCS acceptance only'

gcloud iam roles create menroGcsAcceptanceProbe --project=$testProject --account=$setupAccount --title='MENRO GCS test bucket probe' --description='Create and read synthetic objects and inspect test bucket metadata only' --permissions=storage.objects.create,storage.objects.get,storage.buckets.get --stage=GA

gcloud storage buckets add-iam-policy-binding "gs://$testBucket" --project=$testProject --account=$setupAccount --member="serviceAccount:$testIdentity" --role="projects/$testProject/roles/menroGcsAcceptanceProbe" --condition=None
```

These create NEW resources/role and one binding on the NEW bucket only. The role
definition lives at project scope but is NOT granted at project scope. No existing
principal's role is modified. If new project-scoped definitions are not approved,
STOP before setup. Never use projects add-iam-policy-binding for this identity.
No key-creation/download command is provided. No existing Firebase Rules deployment
or Firebase bucket registration is involved; Admin/Google SDK uses IAM, not client Rules.

After creation, a separately authorized operator may inspect ONLY the new bucket:

```powershell
gcloud storage buckets describe "gs://$testBucket" --project=$testProject --account=$setupAccount --format=json
gcloud storage buckets get-iam-policy "gs://$testBucket" --project=$testProject --account=$setupAccount --format=json
```

Store resulting operational metadata in a restricted review location, not public
chat/logs/Git. Confirm project number maps to approved project, location/class,
uniform access, enforced public prevention, expected soft-delete policy and no
unexpected lifecycle/retention/versioning/CORS/public grants. IAM bucket output
alone is NOT a complete inherited-permission audit. No command in this phase
reads or lists the existing production bucket, production evidence or Firestore.

### Credentials/execution are a separate gate

The existing future execution arm accepts explicitly supplied service-account
credentials and rejects ambient ADC. No keys were read, created, printed or stored
here; tests use pre-existing fake placeholder strings only. Prefer a separately
reviewed keyless/impersonation design if organizational policy prohibits keys, but
the current harness does not implement it. Do not weaken credential guards or use
plugin/backend credentials. Credential provisioning policy and future execution
authorization remain blockers; this document authorizes neither. No real execution
command is supplied for Phase 9A, and the CLI approval list remains empty.

## Synthetic budget and cleanup proposal — needs MENRO approval

- Initial scope: at most ten approved fresh prefixes total, one tiny fixed PNG per
  prefix; one operator, no parallel workers or unattended jobs. Each invocation
  makes two bounded save attempts at the SAME object name and finite verification
  reads; automatic SDK retries are disabled. Never upload local MENRO evidence.
- Maintain a private run manifest of approvals, prefix, object generation string,
  checksum, status and operation counts. No raw credentials/private evidence logs.
- These are proposed operator bounds, NOT a durable cross-run quota in the harness.
  CLI remains blocked until their enforcement/review is approved. Do not claim a
  hard dollar cap, global request cap or isolation from shared project quotas.
- Billing, quotas, audit streams, organization policies and outages are SHARED
  with production. Test egress/operations/soft-delete retention can cost money.
  Request a small explicit cost allowance (proposal USD 1 total, subject to current
  pricing/operator approval) and human stop rules. Alert-only budgets are not hard
  caps. No billing/quotas/alerts are changed here; never disable project billing or
  production services as a test cost-control mechanism.
- Review within seven days of test acceptance. Keep objects until outcomes and
  any interrupted retry are reconciled. Cleanup requires separate approval, proven
  synthetic ownership, exact object+generation, no MENRO business/ledger references
  and conditional deletion by a separate authorized operator. No wildcard, bucket
  emptying, automatic lifecycle or deletion by the probe identity. No cleanup now.
- Retain sanitized test results; soft-deleted bytes can remain billable for the
  proposed seven-day period. Bucket/account/role teardown is another approved
  action, not automatic. Never delete or change production resources.

## Approval checklist / go-no-go

- [ ] Approve exact candidate bucket/identity, Singapore/Standard, soft-delete and cost scope.
- [ ] Authorize separate read-only effective-IAM/org-policy/service-capability review.
- [ ] Confirm global name availability/ownership without using any existing bucket as fallback.
- [ ] Certify no inherited production privileges for test identity; otherwise NO GO.
- [ ] Approve NEW bucket/account/custom-role creation and bucket-only binding separately.
- [ ] Verify resulting bucket project/privacy/config and effective IAM; do not assume creation proves safety.
- [ ] Resolve three-permission versus scoped adversarial overwrite-probe permission decision.
- [ ] Approve secure credentials or a separately reviewed keyless harness adaptation.
- [ ] Review/pin ONLY approved tuple in currently EMPTY CLI approval list; repeat offline negatives.
- [ ] Separately authorize real-service synthetic acceptance and bounded run manifest.
- [ ] Approve cleanup later after reconciliation; never automatic or production-wide.

Current verdict: GO for offline preparation; **NO GO for resource setup or live
testing** until the above approvals/reviews. A separate bucket inside the same
project cannot guarantee complete production isolation from local code inspection.
The smallest next action is approve the proposed tuple/design and authorize the
bounded manual IAM/isolation review, not run gcloud or the acceptance harness now.

## Focused verification and preserved work

```powershell
node --test --test-reporter=spec tests/nonproductionStorageAcceptance.test.js
node --check src/services/nonproductionStorageAcceptance.service.js
node --check tests/nonproductionStorageAcceptance.test.js
git diff --check
```

Node 22.14.0: **34 passed / 0 failed / 0 skipped**, including seven new Phase 9A
cases and existing mocked upload/precondition/retry/generation/privacy checks.
New cases prove no approved live tuple, exact candidate matching in fake policy,
wrong/production buckets and identities rejected even by permissive test policy,
independent execution/environment guards, credential identity mismatch and
zero-network preparation. No real SDK client initialized or credentials discovered.
Syntax and scoped whitespace checks pass. No emulator, full backend regression,
frontend build or real-service tests run: this phase requests OFFLINE tests only.
Known SCHEDULE_STALE and native Storage Emulator precondition failures remain
unchanged, not skipped/reclassified by this focused test run.

Only four Phase 9A files changed: isolated service guard, its offline tests,
Phase 7B superseding notice and this document. Branch remains
fix/validated-survival-analytics, nothing staged/committed/pushed. All previous
Phase 8B and unrelated dirty work preserved. No .env/dependency/runtime/frontend
changes; no cloud plugin calls, service restarts, scheduler or resource access.

## Public primary references consulted (21 October 2026)

- [Bucket creation CLI](https://docs.cloud.google.com/sdk/gcloud/reference/storage/buckets/create): location/class/privacy and soft-delete flags.
- [Bucket IAM binding CLI](https://docs.cloud.google.com/sdk/gcloud/reference/storage/buckets/add-iam-policy-binding) and [custom role creation](https://docs.cloud.google.com/sdk/gcloud/reference/iam/roles/create): command syntax only; none executed.
- [Storage permissions](https://docs.cloud.google.com/storage/docs/access-control/iam-permissions): create/get/delete distinctions used in least-privilege and overwrite-test analysis.
- [Locations](https://docs.cloud.google.com/storage/docs/locations): Singapore location option, not current resource location verification.
- [Soft delete](https://docs.cloud.google.com/storage/docs/soft-delete) and [billing budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets): retention/cost review, not assurance of current billing settings or a hard cap.

Public documentation retrieval is not access to the MENRO project's live data or
configuration. Stop before cloud creation, IAM changes, credentials or real testing.
