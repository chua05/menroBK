# Phase 8G - live read-only GCS security preflight

21 October 2026. **Phase 8H decision: BLOCKED pending explicit shared-project IAM
risk review/acceptance, retention/cost acceptance and separate execution approval.**
Functional authentication, bucket identity/privacy and reported role requirements
passed. This is not a missing-permission or failed-connectivity finding. No IAM,
bucket or application change was made to resolve the remaining policy decisions.

Scope: one staged preflight for project `menrosystem-ddfac`, dedicated bucket
`menro-gcs-acceptance-20261021-6f8c2d91`, acceptance SA
`menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com` and operator
`chuakyla21@gmail.com`. Phase 8F and Phase 8D-8E were read before live execution.
The primary live pass ran 06:07:30-06:07:39 UTC (14:07 Manila), followed by bounded
same-resource policy-read corrections described below. Findings are point-in-time.

## Execution safeguards and authentication

- Local installation metadata confirmed SDK 590.0.0 and the expected gcloud.cmd.
  Active local configuration matched the approved project/operator; standard ADC
  existed. No gcloud process/login command was invoked, avoiding credential-cache
  writes. No new key, login, interactive prompt or credential file was created.
- An inherited DEBUG setting was detected. It was excluded ONLY inside the dedicated
  preflight Node child before loading SDKs, preventing SDK debug output. Parent
  environment, real .env files, running applications and credentials were unchanged.
- Existing reviewed standalone target and ADC validators were reused from the tested
  clean-lockfile copy with Node 22.14.0 and auth library 11.3.1. Source/package hashes
  were checked against the repository. No dependency installation or SDK migration.
- Standard ADC was read into memory and validated as authorized_user; no credential
  contents were printed or persisted. Google tokeninfo confirmed the exact approved
  operator, verified email, cloud-platform scope and approximately 3,599 seconds
  remaining in the initial operator token.
- The existing createKeylessAuth adapter impersonated ONLY the approved acceptance
  SA with no delegates and a requested 300-second lifetime. Google tokeninfo verified
  exact effective identity, verified email, required devstorage.read_write and
  userinfo.email scopes and expiry; approximately 298 seconds remained after checks.
  No Storage request preceded effective-SA verification. Storage metadata used the
  pinned token, with no refresh source passed to it.
- Tokens existed only in task-owned process memory and were not printed, saved,
  exported, hashed or logged. Additional operator authentication for bounded policy
  corrections likewise remained in memory. These were NOT second-identity denial
  tests; they used the same approved operator. No production/alternate identity was
  selected. No project, bucket, service-account or operator mismatch occurred.
- Fixed endpoint/method allowlists, timeouts, redirect denial, bounded response sizes,
  sanitized errors and no automatic metadata-request retries were used. The acceptance
  harness's runAcceptance entry point was NEVER invoked: no object operation occurred.

## Exact live metadata checks

P = menrosystem-ddfac; B = the approved acceptance bucket; S = the approved SA.
All calls below used only these resources. IAM principals unrelated to the approved
operator/SA are pseudonymized in this report; raw IAM policies were not saved.

| Check | REST operation | Result |
| --- | --- | --- |
| Project identity | GET cloudresourcemanager.googleapis.com/v1/projects/P | 200; ACTIVE; exact project ID |
| SA identity | GET iam.googleapis.com/v1/projects/P/serviceAccounts/S | 200; exact email/project; not disabled |
| Bucket metadata as acceptance SA | GET storage.googleapis.com/storage/v1/b/B | 200; exact name and matching projectNumber |
| Bucket allow policy as operator | GET storage.googleapis.com/storage/v1/b/B/iam | 200 |
| Project inherited allow policy | POST cloudresourcemanager.googleapis.com/v1/projects/P:getIamPolicy, requestedPolicyVersion 3 | 200 |
| Initial SA policy read | GET iam.googleapis.com/v1/projects/P/serviceAccounts/S:getIamPolicy | 404; incorrect HTTP method, not missing SA |
| Project ancestry | POST cloudresourcemanager.googleapis.com/v1/projects/P:getAncestry | 200; approved project only |
| Actual custom role definition | GET iam.googleapis.com/v1/projects/P/roles/menroGcsBucketMetadataReader | 200 |
| Project billing linkage | GET cloudbilling.googleapis.com/v1/projects/P/billingInfo | 200; enabled and account linked |
| Corrected SA policy read | POST iam.googleapis.com/v1/projects/P/serviceAccounts/S:getIamPolicy, empty body, requested policy version 3 | 200 |
| Explicit version-3 bucket policy reread | GET storage.googleapis.com/storage/v1/b/B/iam?optionsRequestedPolicyVersion=3 | 200; returned policy version 1; no conditions |

Eleven explicit metadata requests: ten successful and one diagnostic 404. OAuth
refresh/tokeninfo and authorized ephemeral SA token issuance are separate from this
metadata count; transport internals are not represented as an exact network total.
The two POST policy/ancestry methods are reads, not resource mutations. The SA
getIamPolicy method was verified against its official REST documentation before
correcting the GET. There was no missing-resource/identity inference from the 404.

## Results matrix

| Requirement | Status | Evidence / remaining limit |
| --- | --- | --- |
| Operator and effective acceptance identity | PASS | Actual Google introspection; not just ADC/config claims |
| Required acceptance scopes and expiry | PASS | Adapter validation against actual minted token |
| ADC availability and format | PASS | Existing standard file, approved shape; unchanged size/mtime after reads |
| Exact project/SA/bucket ownership | PASS | API IDs match; bucket projectNumber equals project projectNumber |
| Region/storage class | PASS | ASIA-SOUTHEAST1 / STANDARD |
| Public access prevention | PASS | Explicitly enforced |
| Uniform bucket-level access | PASS | Enabled |
| Bucket public IAM principals | PASS | No allUsers/allAuthenticatedUsers in returned bucket allow policy |
| Object User binding | PASS | Unconditional bucket binding to exact acceptance SA |
| Custom metadata role | PASS | Exact live role definition contains ONLY storage.buckets.get; GA, not deleted |
| Metadata access under acceptance identity | PASS | Actual bucket metadata GET succeeded as that SA |
| Operator SA-scoped Token Creator | PASS | Unconditional direct binding to chuakyla21@gmail.com on acceptance SA |
| Acceptance SA direct project-wide roles | PASS | None in the returned project allow policy |
| Higher project ancestry | PASS | API returned project only; no folder/org ancestors reported |
| Strict administrative/identity isolation | BLOCKED | Broad project-level access paths below remain and need review/acceptance |
| Object versioning | PASS | Disabled at bucket level; this does not prove object-generation behavior |
| Bucket retention policy/default hold | PASS | No bucket retention policy; default event-based hold false |
| Soft delete | PASS | Enabled, 604800 seconds (7 days); cost/cleanup acceptance still required |
| Lifecycle rules | PASS | Zero rules returned; no automatic test cleanup configured |
| Billing linkage | PASS | billingEnabled true; billing account linked; account identifier omitted |
| Budget/alerts/spend cap and cost owner | NOT VERIFIED | No billing-account-wide budget/alert inspection; no hard cap inferred |
| Actual private object denial/retrieval | NOT VERIFIED | All object requests prohibited and omitted in Phase 8G |
| Actual create-only/generation/integrity behavior | NOT VERIFIED | Requires separately authorized Phase 8H synthetic object run |
| Complete effective IAM/credential custody | NOT VERIFIED | No exhaustive deny/PAB/key/delegation analysis beyond approved policies |
| Production local setting/deployment | NOT VERIFIED | No Render/production configuration access; prior user confirmation only |
| Phase 8H execution | BLOCKED | Risk/cost decisions and explicit execution authorization pending |

## IAM findings and isolation risks

### 1. Required direct test grants are correct

The bucket binds roles/storage.objectUser and
projects/menrosystem-ddfac/roles/menroGcsBucketMetadataReader directly to the
acceptance SA, without conditions. The live custom role contains exactly
storage.buckets.get. SA-scoped roles/iam.serviceAccountTokenCreator binds only the
approved operator in the returned direct SA policy, without conditions.

The actual custom role ID differs from the earlier proposed
menroAcceptanceBucketMetadata ID. This is NOT a runtime permission defect: the
permissions and live access are verified. The optional offline reviewIamSnapshot
helper hardcodes the earlier proposed role name and would report it unconfirmed
unless its snapshot assumptions were revised later. That helper is not in the
acceptance execution path; no source change was needed or made in this audit.

### 2. Existing project-wide administrative paths - security review required

- The approved operator has roles/owner at project scope, broader than the reported
  SA-scoped Token Creator binding. The source operator credentials therefore have
  production-sensitive administrative authority, even though this preflight selected
  only read-only approved endpoints.
- One other service account, pseudonym **serviceAccount#aabdd014ba**, has BOTH
  roles/storage.admin and roles/iam.serviceAccountTokenCreator at project scope,
  unconditionally. It also has Firebase SDK service-agent/Auth administration roles.
  Its purpose/custody was NOT independently investigated; do not assume it is unused
  or malicious. These grants provide broad bucket administration and an inherited
  impersonation path for project service accounts, including the acceptance SA.
- Bucket policy retains legacy convenience bindings for project Owners/Editors and
  Viewers (legacyBucketOwner/Reader and legacyObjectOwner/Reader). These are not
  public principals, but the test bucket does not exclude project-level trusted
  administrators. The project currently shows the approved operator as Owner.
- Other returned project principals hold Firebase/Firestore/Storage service-agent
  roles. No group/domain/principalSet or public member was returned in the inspected
  project policy. Their operational purposes, key custody and delegation policies
  were not audited through additional out-of-scope account/resource queries.

This is a confirmed broad-permission/trust-boundary finding, NOT proof of compromise,
public exposure or an MENRO authorization bypass. The acceptance SA had no direct
project role in the returned policy, but that alone is not proof it cannot access
any other resource or that other administrators cannot act as it. Production bucket
IAM and Firestore data were NOT queried. No negative production-access probe ran.

## Retention, cleanup and billing implications

Seven-day soft delete means an eventual ordinary conditional deletion can retain
recoverable, billable bytes for that interval. Versioning is disabled and no bucket
retention policy/default hold/lifecycle rules were returned. Individual historical
object state was deliberately not inspected. No cleanup or retention-policy change
is authorized by this report.

Billing is enabled for the project and a billing account is linked. That does not
verify alerts, budgets, a hard cap, billing-account-wide health or a named cost owner.
Approve the one tiny synthetic object and bounded operations with this known
seven-day cleanup implication. IAM scope or metadata success is not spend approval.

## Exact remaining actions and approvals

1. In project IAM, locate the principal with BOTH Storage Admin and Service Account
   Token Creator (pseudonym above), and document its trusted purpose/custody. Also
   acknowledge the operator's project Owner authority and bucket convenience grants.
   No production-data access is necessary to inspect these policies.
2. Decide explicitly whether that shared-project administrator trust boundary is
   acceptable for ONE synthetic Phase 8H run. If acceptable, record risk acceptance;
   do not label it strict isolation. If not, STOP and authorize a separate scoped IAM
   compatibility review or separate-project design. Do not automatically remove or
   narrow Firebase/production roles, which could break established services.
3. If any project-wide grant is unnecessary, a separately authorized remediation
   should replace it with the required bucket-/SA-scoped permissions after checking
   actual usages and regressions. This report authorizes no grant changes and gives
   no destructive blanket removal command.
4. Name a cost/recovery owner and explicitly accept the seven-day soft-delete
   retention, one-object/request/egress allowance and absence of a verified hard cap.
   Any different retention or billing configuration requires separate authorization.
5. Only then separately authorize Phase 8H using the exact tuple and reviewed clean
   runtime in Phase 8F. Assign/record ONE synthetic prefix and manifest; preserve it
   on an uncertain response. Fresh auth under the same guards is required; this
   preflight's in-memory tokens were not retained for reuse.
6. Second-identity testing and generation-conditioned cleanup each remain separate
   later approvals, not implied by Phase 8H or by token issuance in Phase 8G.

There are no confirmed missing functional permissions requiring broader access for
the tested preflight. Unknown effective-IAM/custody/budget items remain NOT VERIFIED,
not silently treated as PASS. Phase 8H remains blocked until the policy/cost and
execution decisions above, rather than another speculative code change.

## Preservation and verification

Only docs/firebase-storage-phase8g.md was added. No application/harness/config/test
or dependency changes; therefore no offline regression rerun was necessary under
this task. Phase 8F's 474/474 result remains historical, not freshly executed here.
Known native Storage Emulator generation-precondition limitation is unchanged and
does not establish real GCS behavior.

**Zero object API requests:** no listing, metadata lookup of an object, missing-object
probe, anonymous object request, download, upload, copy or deletion. Zero persistent
cloud resource/data/configuration/IAM mutations. The only credential issuance was
the explicitly authorized ephemeral, in-memory authentication/impersonation; no
credential creation on disk, login, credential-file modification or token output.
Standard ADC metadata remained 402 bytes / 21 October 2026 12:40:59 local after the
preflight. No gcloud credential-cache operations occurred. No production Firebase
Storage/Firestore data, Render, migration, worker/scheduler, real .env, branch, staging,
commit/push or deployment operations. Existing uncommitted work was preserved.

Official reference used to correct the read-only request method:
[serviceAccounts.getIamPolicy](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/getIamPolicy).

**Stop at Phase 8G. Phase 8H, second identity, cleanup and production remain unexecuted.**
