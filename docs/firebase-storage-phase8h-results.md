# Phase 8H - authorized one-run GCS acceptance results

21 October 2026, Asia/Manila. **FINAL SINGLE SYNTHETIC GCS ACCEPTANCE: PASS.**
Exactly ONE acceptance execution completed, creating one fresh 95-byte synthetic
object in the dedicated acceptance bucket. The 29-byte overwrite was rejected;
integrity, exact generation and private retrieval checks passed. Cleanup remains
NOT AUTHORIZED. No retry, second execution, production access or activation occurred.
See "Final synthetic acceptance - actual execution" for the current result. Earlier
blocked/read-only stages below are historical, not additional acceptance runs.

The explicit shared-project IAM exception, possible charges, retained synthetic
object and seven-day soft-delete implications were accepted by the user. That
approval was not expanded into permission to retry a failed prerequisite. After
the ancestry guard failed, all live operations stopped. No acceptance prefix,
execution config or object manifest was created, and the execution marker was
never enabled.

## Original preflight scope and preserved boundaries

- Project: `menrosystem-ddfac`.
- Bucket: `menro-gcs-acceptance-20261021-6f8c2d91` only.
- Impersonated identity: `menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com`.
- Operator: `chuakyla21@gmail.com`, existing standard Windows ADC, no key files.
- Intended payloads: one fixed 95-byte synthetic PNG and one 29-byte rejected
  same-name overwrite attempt. Neither was sent.
- Intended PNG SHA-256:
  `c6237b04a3bc02f90c02786681d5a4df51e1703d11c9c6a85feeb8a4775787f4`.
- One foreground acceptance invocation, no automatic retry, no cleanup and no
  second-identity denial test. Actual invocations at the original blocked stage:
  **0**; the later final execution below is the only invocation.

The Phase 8H preparation report and Phase 8G/8F reports were inspected. The
standalone harness, its auth/policy adapters and CLI were reviewed, not replaced.
During that original attempt no source, dependency, real environment, credential
or frontend changes were made. The later offline-only correction is listed below.

## Original local prerequisites and offline verification

| Check | Result | Evidence |
| --- | --- | --- |
| Branch | PASS | `fix/validated-survival-analytics`; no branch operation |
| Staging | PASS | Empty before verification; no staging performed |
| Reviewed isolated copy | PASS | Package, lock, CLI, three harness services and eleven test files match repository SHA-256 hashes |
| Runtime | PASS | Existing isolated Node 22.14.0 |
| Installed locked dependencies | PASS | Admin 14.5.0, Firestore 9.3.1, Storage 8.4.0, auth library 11.3.1, Multer 2.4.0, Sharp 0.35.5 |
| Existing repository node_modules | NOT USED | Previously identified as stale; no installation or replacement |
| Local gcloud selectors | PASS | Active `default`, exact approved project/operator; unexpected selector/credential/emulator/execute overrides absent |
| Standard ADC | PASS | Existing file, 402 bytes; size and last-write unchanged after live inspection |
| Provider | PASS | `EVIDENCE_STORAGE_PROVIDER` absent in the task environment and never assigned; application's local default unchanged |
| Focused offline regressions | PASS | **190 passed, 0 failed, 0 skipped**, fresh run |

Package hash:
`17968012E0F912A306E0BD7CB5A7F2771092FE9AAD80C88CE4D480A7E91E3F89`.
Lockfile hash:
`A0ED188085B553DD9859ECE86EF7B43E823826FAE30695052E9CDFE6B00F3E0C`.

The focused command ran in the existing isolated dependency copy:

```powershell
& 'C:\Users\chuak\AppData\Roaming\fnm\node-versions\v22.14.0\installation\node.exe' --test --test-reporter=spec tests/nonproductionStorageAcceptance.test.js tests/nonproductionStorageAcceptanceAuth.test.js tests/nonproductionStorageAcceptancePolicy.test.js tests/firebaseStorageTransport.test.js tests/evidenceStorageConfig.test.js tests/firebaseEvidenceRetrieval.test.js tests/evidenceRetrievalResolver.test.js tests/evidenceWorkflow.test.js tests/evidenceProductionReadiness.test.js tests/storageInitialization.test.js tests/integrationEnvironment.test.js
```

An initial sandboxed launch failed to spawn all eleven test-file subprocesses
with `EPERM`; no individual assertions ran. With subprocess/loopback execution
permission, the same offline suite completed 190/190. This was not a real GCS
acceptance invocation or retry. Full-root and emulator suites were not rerun;
previous results remain historical. The known Storage Emulator generation-zero
precondition limitation remains unresolved, not hidden by these mock tests.

Fresh tests include the immutable per-upload no-delete guard and actual SDK CRC
failure against a loopback stub; the guard prevents implicit SDK cleanup without
disabling CRC validation. Rollback read capability, authorization-before-storage,
revision/local compatibility, exact uint64 strings, production isolation and
fail-closed identity/configuration checks remain covered offline.

## Original live read-only preflight results

Authentication and resource calls used the tested isolated dependencies and
existing keyless adapter. Inherited SDK `DEBUG` was removed only inside the
task-owned Node process before loading SDKs. No real environment file was edited.
Tokens were issued and introspected only in memory; they were not printed, saved,
exported or passed to gcloud. No gcloud process or credential-cache write occurred.

| Check | Result | Sanitized evidence |
| --- | --- | --- |
| Source operator identity | PASS | Google introspection verified exact operator, verified email and cloud-platform scope; 3,598 seconds remaining |
| Effective acceptance identity | PASS | Exact approved SA, verified email, required Storage read/write and userinfo.email scopes; 299 seconds remaining |
| Project | PASS | HTTP 200; exact project ID, ACTIVE |
| Acceptance service account | PASS | HTTP 200; exact email/project, not disabled |
| Acceptance bucket metadata as acceptance SA | PASS | HTTP 200; exact bucket, projectNumber matches verified project |
| Region/class | PASS | `ASIA-SOUTHEAST1`, `STANDARD` |
| Privacy | PASS | Public access prevention `enforced`; uniform bucket-level access enabled |
| Retention/versioning | PASS | Versioning disabled; no bucket retention policy/default event-based hold; soft delete 604800 seconds; zero lifecycle rules |
| Bucket IAM | PASS | HTTP 200; exact accepted Phase 8G binding baseline, no conditions or public principals; bucket Object User and custom metadata role for exact acceptance SA |
| Project IAM | PASS WITH ACCEPTED EXCEPTION | HTTP 200; exact previously accepted binding baseline; operator Owner and existing Firebase Admin SA broad Storage Admin/Token Creator access unchanged; no direct acceptance-SA project roles |
| Acceptance SA IAM | PASS | HTTP 200; exact unconditional operator-scoped Token Creator binding, no unexpected binding |
| Project ancestry | BLOCKED | HTTP 200, but the task-local ancestry predicate failed; details below |
| Fresh custom metadata role definition | NOT VERIFIED | Not requested after stop; exact one-permission definition was verified historically in Phase 8G only |
| Fresh billing linkage/status | NOT VERIFIED | Not requested after stop; historical enabled/linked result is not a fresh verification |
| Complete effective IAM isolation | NOT VERIFIED | Direct-policy baseline equality does not prove all effective permissions, credential custody or administrative isolation |

Exactly **seven explicit metadata requests** occurred, in this order:

1. GET Resource Manager v1 `projects/P`.
2. GET IAM v1 `projects/P/serviceAccounts/S`.
3. GET Storage v1 `b/B`, authenticated as the acceptance SA.
4. GET Storage v1 `b/B/iam?optionsRequestedPolicyVersion=3`.
5. POST Resource Manager v1 `projects/P:getIamPolicy`, requested policy version 3.
6. POST IAM v1 `projects/P/serviceAccounts/S:getIamPolicy`, empty body and requested policy version 3.
7. POST Resource Manager v1 `projects/P:getAncestry`, empty body.

P/B/S refer exclusively to the approved tuple above. The POST policy and ancestry
methods are read operations, not configuration mutations. Token issuance and
introspection requests are separate from this metadata count. No object listing,
object metadata, media, missing-object or anonymous-object request occurred.

### Exact stop reason and uncertainty

The ad hoc read-only preflight (not the existing acceptance harness) required:

```javascript
ancestry.ancestor?.length === 1 &&
ancestry.ancestor[0].resourceId?.type === 'project' &&
String(ancestry.ancestor[0].resourceId?.id) === String(project.projectNumber)
```

The request returned HTTP 200, but this compound check evaluated false, producing
the local safe code `ANCESTRY_DRIFT`. It was not an API authentication/permission
error. The raw ancestry body was not logged or saved, so the failed conjunct and
actual resource ID are not available in the sanitized record. **Actual new
ancestors or cloud configuration drift have NOT been established.**

The guard assumes a numeric project number representation. Local installed
Cloud SDK v1 `ResourceId` schema describes a type-specific ID, without proving
that numeric-only assumption. A project-ID representation is a plausible false
rejection, not a confirmed explanation of the actual response. Do not claim an
IAM defect, change IAM or relax resource identity on this evidence.

In accordance with the explicit STOP instruction, no second preflight, corrected
live request, remaining billing/role request or acceptance invocation followed.
No attempt was made to bypass the guard. This is an inconclusive preflight
validation failure, not a demonstrated GCS upload/retrieval defect.

## Original blocked-attempt acceptance outcomes

| Acceptance check | Result | Reason |
| --- | --- | --- |
| Single authorized execution | BLOCKED / NOT EXECUTED | Prerequisite stop before CLI execution marker |
| Fresh UUID namespace / exact synthetic object | BLOCKED / NOT ALLOCATED | No run config or object created |
| Missing-object 404 | BLOCKED / NOT TESTED | No object operations |
| Create-only 95-byte upload | BLOCKED / NOT TESTED | No upload |
| Rejected 29-byte overwrite, HTTP 412 | BLOCKED / NOT TESTED | No second save |
| Metadata, exact generation and unchanged original | BLOCKED / NOT TESTED | No object exists from this task |
| Authorized private generation retrieval / SHA-256 | BLOCKED / NOT TESTED | No media request |
| Anonymous denial | BLOCKED / NOT TESTED | No anonymous probe |
| Second-identity test | BLOCKED / NOT AUTHORIZED | Not attempted |
| Cleanup | **NOT AUTHORIZED** | Not attempted, including SDK implicit cleanup |

Sanitized object reference: **NONE**. Object generation: **NONE**. Actual uploaded
payload bytes: **0**. No claim is made about objects from other tasks, since bucket
objects were never listed or inspected. No uncertain upload recovery is needed
for this attempt because no upload was initiated.

## Original billing and soft-delete implications

The user accepted possible charges; authentication and metadata operations may
incur charges. No zero-cost guarantee or verified currency cap is claimed. Fresh
billing status remains NOT VERIFIED because it was after the failed prerequisite.
No new synthetic object/storage charge was created by this task.

The freshly observed seven-day soft-delete setting retains deleted/overwritten
objects after a later deletion; it does not expire a live test object after seven
days. A future successful run would leave its object private and billable until
separately authorized generation-conditioned cleanup, followed by possible
seven-day retained-storage charges. No cleanup, policy change or lifecycle rule
was authorized or performed here.

## Original blocked-attempt recommendation

**BLOCKED for acceptance completion and development-only real Firebase Storage
activation.** Keep the existing local provider and production cloud activation
blocked. No MENRO workflow, historical evidence or production setting changed.
Existing isolated demo-emulator workflows are not newly activated by this report.

Before another live action, obtain explicit authorization for a corrected bounded
read-only ancestry preflight: retain exact approved project identity, validate the
API's project ID/number representation against the already verified project, and
record only sanitized ancestor types/identity-match booleans. Then freshly verify
the custom role definition and billing. Do not remove an ancestry check, broaden
the tuple, change permissions or infer all prerequisites from older reports.

If prerequisites pass under that authorization, the ONE acceptance invocation is
still unused and must remain subject to the user's stop/reconfirmation direction.
Do not run it automatically from this report. Second-identity testing, cleanup,
production activation, migration and deployment all remain separately unapproved.

Only `docs/firebase-storage-phase8h-results.md` was added in the original attempt. Existing
dirty work, credentials, `.env`, application/provider configuration, dependencies,
uploads, shared emulators and frontend remain untouched. No Firebase/Firestore
data or Render access, scheduler action, IAM/bucket/billing mutation, commit,
push, branch change or other Git write occurred.

## Offline ancestry correction - completed before live recheck

### Confirmed cause versus unresolved live evidence

The failed expression existed only in the task-local preflight, not in an MENRO
route, the acceptance executor or a checked-in ancestry validator. A source search
found its predicate only in this report. There was no existing reusable ancestry
validator or regression coverage. The HTTP helper had returned the response body
(`r.data`) after checking HTTP 200; the compound predicate then failed locally.

Google's public [getAncestry reference](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/getAncestry)
specifies POST, an empty request body, singular `ancestor[]`, and a first element
representing the project, followed by parents. Each entry has `resourceId.type`
and `resourceId.id`. The [Project/ResourceId schema](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects#ResourceId)
defines a string type-specific resource ID and separately defines projectId and
the int64-string projectNumber. It does not justify numeric-only ancestry identity.
These public documentation pages and the installed SDK schema were inspected;
no authenticated Google Cloud/resource API was called in this correction phase.

Confirmed defect: numeric-only comparison rejects an otherwise correct project-ID
representation. A synthetic fixture reproduces the old predicate returning false
for `{"ancestor":[{"resourceId":{"type":"project","id":"menrosystem-ddfac"}}]}`
despite the corresponding verified project metadata. This is a validation-logic
defect, not evidence that the API's documented nesting needs a different parser.

The actual prior response was not retained. Thus a project-ID representation is
NOT asserted as the proven cause of that specific live rejection. Malformation or
an unexpected hierarchy in that response cannot be excluded offline. HTTP 200 and
the local throw provide no evidence of a missing IAM permission; no permission
or cloud-drift diagnosis is established and no IAM change is recommended.

### Scoped correction

`validateProjectAncestry(response, project, target)` was added to the existing pure
offline policy module, not to application startup or an upload path. It requires:

- The actual JSON response body, not a Gaxios `{data: ...}` wrapper or a plural
  `ancestors` field. Missing, empty, non-array, sparse, oversized or malformed
  entries fail closed.
- A separately retrieved ACTIVE project's exact allowlisted projectId and a
  canonical positive int64-string projectNumber. No Number conversion, coercion,
  leading zeros or rounded-precision identity matching.
- First entry type `project` and exact equality to either that project's projectId
  or its verified projectNumber string. No suffix, path, case-folding or arbitrary
  alias matching.
- Exactly one entry and no parent in the project metadata, preserving the accepted
  project-only hierarchy. Folder/org parents and duplicate project entries still
  require renewed review, rather than being silently discarded.

The frozen result contains only safe match flags, count/types and which alias
representation matched. Errors distinguish `ANCESTRY_RESPONSE_INVALID`,
`ANCESTRY_PROJECT_MISMATCH`, `ANCESTRY_REVIEW_REQUIRED`,
`PROJECT_IDENTITY_MISMATCH` and `PROJECT_METADATA_INVALID`; they do not echo private
response values. This helper is not itself identity attestation or an allowlist:
the future caller must use the existing frozen target and freshly retrieved project.

The unchanged acceptance executor cannot select the production bucket, and no
production/provider gate, auth adapter, read-preserving rollback, upload, quota,
monitoring, evidence or MENRO workflow was changed. There is no new cloud executor.

### Files changed and fresh verification

1. `src/services/nonproductionStorageAcceptancePolicy.service.js` - pure validator
   and export; existing bucket/IAM/second-identity checks retained.
2. `tests/nonproductionStorageAcceptancePolicy.test.js` - 47 new synthetic ancestry
   regressions, including valid ID/number forms, precision, missing/malformed data,
   mismatches, unexpected inheritance, contradictory project metadata and safe output.
3. `tests/nonproductionStorageReadOnlyRecheck.test.js` - 17 mock-only checks of the
   exact prepared body below, including request bounds, auth failures, hierarchy,
   permission denial, role/billing failures, default disablement and sanitized errors.
4. `docs/firebase-storage-phase8h-results.md` - this correction and exact recheck plan.

| Fresh offline suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Policy, including 47 new cases | 67 | 0 | 0 |
| Documented read-only recheck body, synthetic mock transport | 17 | 0 | 0 |
| Final focused security/auth/isolation/rollback/SDK transport/recheck, 12 files | 254 | 0 | 0 |
| Final full backend root regression | 542 | 0 | 0 |

Counts overlap, not additive. Test-first diagnostic: the 20 original policy cases
passed and the 47 new cases failed before the helper existed; all 67 passed after
the correction. An initial attempt to use `--test-isolation=none` was rejected by
Node 22.14.0 before any test ran; the policy file was then run directly. The focused
and full suites used normal subprocess isolation with execution permission.
Before the additional documented-body tests, intermediate focused/full runs also
passed 237/237 and 525/525. Final counts above include those 17 new cases; no failed
case was skipped or weakened. All three changed JavaScript files pass syntax
checks. Explicit whitespace checks cover all four task files, including untracked
ones; git diff --check passes with existing LF/CRLF warnings only.

No packages were installed. Node 22.14.0 and the previously locked dependency tree
were reused through a node_modules junction in a fresh temporary source snapshot:
`C:/Users/chuak/AppData/Local/Temp/menro-phase8h-ancestry-09b407997459457193c2e1d4f0e6083c`.
Source, root tests, helpers and JS scripts were copied mechanically; no .env,
credential files, shared emulator fixtures or existing uploads were copied.
Both package hashes remain as recorded above. The tests use mocks and loopback
servers only; the Firebase SDK compatibility case builds a demo query without RPC.
No emulator suite, worker, scheduler or real acceptance command was executed.

Commands, from that snapshot, using the explicit Node 22.14.0 path above:

```powershell
node tests/nonproductionStorageAcceptancePolicy.test.js
node tests/nonproductionStorageReadOnlyRecheck.test.js
node --test --test-reporter=spec tests/nonproductionStorageAcceptance.test.js tests/nonproductionStorageAcceptanceAuth.test.js tests/nonproductionStorageAcceptancePolicy.test.js tests/nonproductionStorageReadOnlyRecheck.test.js tests/firebaseStorageTransport.test.js tests/evidenceStorageConfig.test.js tests/firebaseEvidenceRetrieval.test.js tests/evidenceRetrievalResolver.test.js tests/evidenceWorkflow.test.js tests/evidenceProductionReadiness.test.js tests/storageInitialization.test.js tests/integrationEnvironment.test.js
node --test --test-reporter=spec tests/*.test.js
```

## Minimal live recheck - historical prepared plan, executed once below

The following plan subsequently received the explicit one-recheck approval and was
executed once, as recorded below. It is retained for audit, NOT ongoing permission
to repeat it. Scope was fresh in-memory authentication of the exact operator and
only these four metadata requests, each at most once, sequential/fail-fast:

| Order | Method and exact resource | Required outcome |
| --- | --- | --- |
| 1 | GET `https://cloudresourcemanager.googleapis.com/v1/projects/menrosystem-ddfac` | Exact approved ACTIVE project; fresh number-string anchor |
| 2 | POST `https://cloudresourcemanager.googleapis.com/v1/projects/menrosystem-ddfac:getAncestry`, body `{}` | Corrected validator PASS; project-only hierarchy |
| 3 | GET `https://iam.googleapis.com/v1/projects/menrosystem-ddfac/roles/menroGcsBucketMetadataReader` | Exact live role name, GA, not deleted, ONLY `storage.buckets.get` |
| 4 | GET `https://cloudbilling.googleapis.com/v1/projects/menrosystem-ddfac/billingInfo` | Exact project, billingEnabled true, linked account; do not output its ID |

Project GET is necessary to bind both aliases to the same fresh verified resource;
do not use a guessed number, the ancestry's own number, or an old hardcoded number.
The [custom-role GET](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.roles/get)
and [billing GET](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo)
are metadata reads, not policy or billing changes. On denial, stop and request review;
no wider role, login, impersonation change or configuration mutation is authorized.

Authentication uses existing standard ADC, validates its approved format using the
existing adapter, verifies the exact operator through tokeninfo, and pins that token
in memory. No SA impersonation is needed for these operator-side metadata reads.
OAuth refresh/introspection are additional auth requests, not part of the four
resource-request count. Metadata retries and redirects are disabled. No GCS client,
Storage endpoint, Firestore, Firebase app, object, acceptance invocation, second
identity or cleanup is present in the following prepared body.

### Exact read-only body (17 mock tests; subsequently executed once)

<!-- phase8h-readonly-recheck:start -->
```javascript
delete process.env.DEBUG; // Child only; prevent SDK debug output.
const fs = require('node:fs'), path = require('node:path');
const { validateTarget, PROPOSED_SAME_PROJECT_TARGET: target } = require('./src/services/nonproductionStorageAcceptance.service');
const { validateAdc } = require('./src/services/nonproductionStorageAcceptanceAuth.service');
const { validateProjectAncestry } = require('./src/services/nonproductionStorageAcceptancePolicy.service');
const P = 'menrosystem-ddfac', O = 'chuakyla21@gmail.com';
const roleName = `projects/${P}/roles/menroGcsBucketMetadataReader`;
let stage = 'local', requests = 0;
const assert = (ok, code) => { if (!ok) { const e = new Error(code); e.safe = code; throw e; } };
const report = (check, detail = {}) => console.log(JSON.stringify({ check, status: 'PASS', ...detail }));
const endpoints = Object.freeze({
  project: { method: 'GET', url: `https://cloudresourcemanager.googleapis.com/v1/projects/${P}` },
  ancestry: { method: 'POST', url: `https://cloudresourcemanager.googleapis.com/v1/projects/${P}:getAncestry`, data: {} },
  role: { method: 'GET', url: `https://iam.googleapis.com/v1/${roleName}` },
  billing: { method: 'GET', url: `https://cloudbilling.googleapis.com/v1/projects/${P}/billingInfo` },
});
(async () => {
  assert(process.env.MENRO_GCS_READONLY_RECHECK === 'AUTHORIZED_ANCESTRY_BILLING_METADATA_ROLE_ONLY' &&
    process.env.MENRO_GCS_ACCEPTANCE_EXECUTE === undefined, 'READONLY_APPROVAL_REQUIRED');
  assert(['CLOUDSDK_CONFIG','CLOUDSDK_ACTIVE_CONFIG_NAME','CLOUDSDK_CORE_PROJECT','CLOUDSDK_CORE_ACCOUNT',
    'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT'].every(k => process.env[k] === undefined), 'LOCAL_SELECTOR_OVERRIDE');
  validateTarget({ ...target, prefix: 'menro-acceptance/00000000-0000-4000-8000-000000000000/' }, process.env);
  const base = path.join(process.env.APPDATA, 'gcloud');
  assert(fs.readFileSync(path.join(base, 'active_config'), 'utf8').trim() === 'default', 'LOCAL_CONFIG_MISMATCH');
  const ini = fs.readFileSync(path.join(base, 'configurations', 'config_default'), 'utf8');
  assert(/^account = chuakyla21@gmail\.com\s*$/m.test(ini) && /^project = menrosystem-ddfac\s*$/m.test(ini), 'LOCAL_CONFIG_MISMATCH');
  const adcFile = path.join(base, 'application_default_credentials.json'), before = fs.statSync(adcFile);
  assert(before.size > 0 && before.size <= 32768, 'ADC_INVALID');
  const adc = JSON.parse(fs.readFileSync(adcFile, 'utf8')), sourceOptions = validateAdc(adc, target);
  const { UserRefreshClient, OAuth2Client } = require('node:module').createRequire(require.resolve('@google-cloud/storage'))('google-auth-library');
  const opts = { transporterOptions: { timeout: 15000, retry: false, maxRedirects: 0, maxContentLength: 32768 }, universeDomain: 'googleapis.com' };
  stage = 'operatorAuthentication';
  const token = (await new UserRefreshClient({ ...opts, ...sourceOptions }).getAccessToken())?.token;
  assert(typeof token === 'string' && token.length > 0 && token.length <= 16384, 'OPERATOR_TOKEN_INVALID');
  const info = await new OAuth2Client(opts).getTokenInfo(token);
  assert(info.email === O && [true,'true'].includes(info.email_verified), 'OPERATOR_IDENTITY_MISMATCH');
  assert(Number.isFinite(info.expiry_date) && info.expiry_date > Date.now() + 30000 && Array.isArray(info.scopes) &&
    info.scopes.includes('https://www.googleapis.com/auth/cloud-platform'), 'OPERATOR_SCOPE_EXPIRY_INVALID');
  const client = new OAuth2Client({ ...opts, eagerRefreshThresholdMillis: 1, forceRefreshOnFailure: false });
  client.setCredentials({ access_token: token, expiry_date: info.expiry_date, token_type: 'Bearer' });
  report('operatorIdentity', { exactMatch: true });
  async function read(name) {
    stage = name;
    assert(Object.hasOwn(endpoints, name) && requests < 4, 'REQUEST_NOT_ALLOWED');
    requests++;
    const r = await client.request({ ...endpoints[name], timeout: 15000, retry: false, maxRedirects: 0, maxContentLength: 32768 });
    assert(r.status === 200, 'READ_STATUS_INVALID'); return r.data;
  }
  const project = await read('project');
  assert(project?.projectId === P && project.lifecycleState === 'ACTIVE', 'PROJECT_IDENTITY_MISMATCH');
  report('project', { exactMatch: true });
  const ancestry = validateProjectAncestry(await read('ancestry'), project, target);
  report('ancestry', ancestry); // Safe flags/types only, no raw hierarchy IDs.
  const role = await read('role');
  assert(role?.name === roleName && role.stage === 'GA' && !role.deleted && Array.isArray(role.includedPermissions) &&
    role.includedPermissions.length === 1 && role.includedPermissions[0] === 'storage.buckets.get', 'METADATA_ROLE_MISMATCH');
  report('metadataRole', { exactName: true, exactPermission: true, active: true });
  const billing = await read('billing');
  assert(billing?.projectId === P && billing.billingEnabled === true && typeof billing.billingAccountName === 'string' &&
    /^billingAccounts\/[A-Z0-9-]+$/.test(billing.billingAccountName), 'BILLING_NOT_READY');
  report('billing', { enabled: true, accountLinked: true });
  const after = fs.statSync(adcFile);
  assert(after.size === before.size && after.mtimeMs === before.mtimeMs, 'ADC_FILE_CHANGED');
  report('recheckComplete', { metadataRequests: requests, objectRequests: 0, acceptanceExecutions: 0, adcUnchanged: true });
})().catch(e => {
  const known = new Set(['ADC_REQUIRED','ADC_INVALID','ADC_IDENTITY_MISMATCH','UNSAFE_ENVIRONMENT','ANCESTRY_RESPONSE_INVALID',
    'ANCESTRY_PROJECT_MISMATCH','ANCESTRY_REVIEW_REQUIRED','PROJECT_IDENTITY_MISMATCH','PROJECT_METADATA_INVALID',
    'READONLY_APPROVAL_REQUIRED','LOCAL_SELECTOR_OVERRIDE','LOCAL_CONFIG_MISMATCH','OPERATOR_TOKEN_INVALID',
    'OPERATOR_IDENTITY_MISMATCH','OPERATOR_SCOPE_EXPIRY_INVALID','REQUEST_NOT_ALLOWED','READ_STATUS_INVALID',
    'METADATA_ROLE_MISMATCH','BILLING_NOT_READY','ADC_FILE_CHANGED']);
  const status = Number(e?.response?.status) || null;
  const code = e.safe || e.code;
  const reason = known.has(code) ? code : status === 403 ? 'READ_PERMISSION_DENIED' :
    status === 401 ? 'AUTH_CREDENTIALS_INVALID' : 'READONLY_RECHECK_FAILED';
  console.log(JSON.stringify({ status: 'BLOCKED', stage, reason, httpStatus: status, metadataRequests: requests, objectRequests: 0, acceptanceExecutions: 0 }));
  process.exitCode = 1;
});
```

The zero-UUID prefix is an offline validator placeholder only. No run namespace is
allocated or sent to an endpoint. There is no `runAcceptance()` or CLI invocation.

### Recorded PowerShell execution commands - one approval already consumed

This block was executed once under the later explicit read-only approval. Do not
rerun it from this report. It used a dedicated process, no credential copies, login
or provider assignment, and stopped on any failed prerequisite. No retry loop.

```powershell
$repo = 'C:\Users\chuak\Desktop\menrobackend'
$snapshot = 'C:\Users\chuak\AppData\Local\Temp\menro-phase8h-ancestry-09b407997459457193c2e1d4f0e6083c'
$node = 'C:\Users\chuak\AppData\Roaming\fnm\node-versions\v22.14.0\installation\node.exe'
foreach ($file in @('package.json','package-lock.json','scripts/acceptNonproductionEvidenceStorage.js',
  'src/services/nonproductionStorageAcceptance.service.js','src/services/nonproductionStorageAcceptanceAuth.service.js',
  'src/services/nonproductionStorageAcceptancePolicy.service.js','tests/nonproductionStorageAcceptancePolicy.test.js',
  'tests/nonproductionStorageReadOnlyRecheck.test.js','docs/firebase-storage-phase8h-results.md')) {
  if ((Get-FileHash -LiteralPath (Join-Path $repo $file) -ErrorAction Stop).Hash -ne
      (Get-FileHash -LiteralPath (Join-Path $snapshot $file) -ErrorAction Stop).Hash) { throw 'Source snapshot drift; STOP.' }
}
if (!(Test-Path -LiteralPath $node)) { throw 'Reviewed Node runtime missing; STOP.' }
if ((Test-Path Env:MENRO_GCS_ACCEPTANCE_EXECUTE) -or (Test-Path Env:MENRO_GCS_READONLY_RECHECK)) { throw 'Use a fresh shell; STOP.' }
$document = Get-Content -LiteralPath (Join-Path $repo 'docs/firebase-storage-phase8h-results.md') -Raw
$body = [regex]::Match($document, '(?s)<!-- phase8h-readonly-recheck:start -->\r?\n```javascript\r?\n(.*?)\r?\n```')
if (!$body.Success) { throw 'Reviewed read-only body missing; STOP.' }
$env:NODE_ENV = 'test'
$env:MENRO_GCS_ACCEPTANCE_ENV = 'same-project-test-bucket'
$env:MENRO_GCS_READONLY_RECHECK = 'AUTHORIZED_ANCESTRY_BILLING_METADATA_ROLE_ONLY'
Push-Location -LiteralPath $snapshot
try {
  $body.Groups[1].Value | & $node -
  if ($LASTEXITCODE -ne 0) { throw 'Read-only recheck BLOCKED; STOP. No acceptance or automatic retry.' }
} finally {
  Pop-Location
  Remove-Item Env:MENRO_GCS_READONLY_RECHECK -ErrorAction SilentlyContinue
}
```

## Authorized live read-only recheck - actual results

21 October 2026. The one newly authorized recheck completed successfully. Local
preflight was recorded at 22:59:29 +08:00, and post-run local inspection at
23:02:51 +08:00; these bound the live execution, not individual API timestamps.
No second recheck, diagnostic retry or additional resource request followed.

### Local and authentication prerequisites

- Branch remained `fix/validated-survival-analytics`; staging was empty.
- Nine reviewed package/source/test/document paths exactly matched the tested
  isolated snapshot before execution. Node 22.14.0 and the existing locked SDKs
  were used. No dependency installation or code correction was needed.
- Local gcloud configuration was `default`, with exact project `menrosystem-ddfac`
  and operator `chuakyla21@gmail.com`. Credential/config/emulator overrides and
  both execution markers were absent. No gcloud CLI or interactive login ran.
- The unchanged documented body validated the explicit standard ADC in memory,
  verified the exact operator/verified email, required cloud-platform scope and
  token expiry through tokeninfo, then pinned that short-lived token without a
  refresh source in the metadata client. This was existing ADC authentication,
  not credential-file/key creation or a service-account impersonation operation.
- Tokens and credential contents were never printed, saved or exported. The ADC
  file remained 402 bytes with the same last-write metadata, and the body reported
  `adcUnchanged: true`. Inherited DEBUG was removed only in the child process.
- `EVIDENCE_STORAGE_PROVIDER` was never assigned; it remained absent in the task
  environment, preserving the application's local default. No real .env was read
  or edited and no running service was changed.

The exact documented body matched the tested snapshot. Its source-body SHA-256 was
`06a773de6d940ba85f1d160bc99a61006efecd7fde5ab826ccb3049778997bc3`.
Only the unchanged four-endpoint body was executed; no replacement ad hoc predicate
or additional cloud inspection was introduced.

### Four executed checks

P = `menrosystem-ddfac`. All four resource responses passed the body's HTTP 200
check. Outputs below are validation summaries, not raw API bodies or credentials.

| Order / exact read | Result | Sanitized actual finding |
| --- | --- | --- |
| 1. GET `https://cloudresourcemanager.googleapis.com/v1/projects/menrosystem-ddfac` | PASS | Exact approved project, ACTIVE; fresh canonical int64-string project number validated by the ancestry helper; number omitted from output |
| 2. POST `https://cloudresourcemanager.googleapis.com/v1/projects/menrosystem-ddfac:getAncestry`, body `{}` | PASS | One entry, type `project`, exact `projectId` representation; no folder/org entries and no project parent; exact match to fresh project identity |
| 3. GET `https://iam.googleapis.com/v1/projects/menrosystem-ddfac/roles/menroGcsBucketMetadataReader` | PASS | Exact role name, GA, not deleted; includedPermissions has exactly one value: `storage.buckets.get` |
| 4. GET `https://cloudbilling.googleapis.com/v1/projects/menrosystem-ddfac/billingInfo` | PASS | Exact approved project, billingEnabled true and a linked billing account; account identifier omitted |

The actual safe ancestry summary was:

```json
{"projectMatches":true,"projectOnly":true,"ancestorCount":1,"ancestorTypes":["project"],"projectReference":"projectId"}
```

The real API therefore returned a valid project-ID representation on this recheck.
The old numeric-only comparison would reject THIS response, confirming the local
validator correction is necessary for the observed live format. The first failed
attempt's discarded body is still unavailable; this does not retrospectively prove
its exact failed conjunct. No new hierarchy drift or IAM failure was observed in
the four checks, and no IAM/configuration remediation is indicated by these results.

Final sanitized body result:

```json
{"check":"recheckComplete","status":"PASS","metadataRequests":4,"objectRequests":0,"acceptanceExecutions":0,"adcUnchanged":true}
```

There were exactly FOUR explicit cloud-resource metadata reads, in the approved
order, with metadata retries/redirects disabled and no manual or automatic recheck.
The documented OAuth refresh/tokeninfo authentication is separate from this metadata
count; no total wire-request/billing count is inferred from the four-resource count.
No SA impersonation, bucket metadata/IAM query, object operation, production data
access, Firestore query or additional resource endpoint was used in this recheck.

### Limits, remaining risks and GO decision

**GO for the separately authorized, one-run, bounded synthetic acceptance test
against the existing dedicated bucket and exact acceptance SA. Do NOT execute it
under this read-only authorization.** Ancestry, custom-role definition and billing
blockers are resolved by live evidence; no further local code fix is required.

The approved shared-project IAM trust exception remains unchanged. This recheck
does not establish strict effective IAM isolation or re-audit inherited permissions.
The custom-role definition check does not independently reverify its bucket binding.
Bucket privacy, region, retention, soft delete, Object User/Token Creator bindings
and acceptance-SA identity were NOT newly queried: their earlier passed results
remain historical. The later authorized acceptance harness must retain its own
fresh effective-SA and bucket-security guards; never bypass them based on this GO.

Billing is enabled, but budget alerts, currency caps and exact costs remain NOT
VERIFIED. The accepted seven-day soft-delete and retained-live-object cost risks
are unchanged. There is still no synthetic object/reference/generation from these
tasks. Create-only upload, rejected overwrite, real generation/integrity checks and
private object retrieval remain NOT TESTED against GCS. The known Storage Emulator
precondition limitation remains visible, not resolved by metadata success.

Cleanup and second-identity testing remain NOT AUTHORIZED. Production activation,
application cloud-provider switching, migration and deployment remain blocked and
outside scope. The one synthetic acceptance invocation is still unused (0).

### Preservation and verification for this recheck

Only `docs/firebase-storage-phase8h-results.md` was updated. No application,
validator, test, SDK, package, credential, cloud policy or real environment file
changed. Accordingly no full regression or other test suite was rerun: the prior
17/17 prepared-body, 67/67 policy, 254/254 focused and 542/542 full results remain
historical, with their source snapshot verified unchanged before this execution.

The tested snapshot retains its pre-execution report. Appending these results
intentionally changes the repository report's full-file hash, not the executed
body. The recorded recheck command's document-hash guard should therefore stop an
unapproved copy-and-rerun; do not silently resnapshot or repeat a consumed approval.
Source modules/dependencies and their tested behavior remain unchanged.

No uploads/downloads/listing/deletion/overwrite, acceptance, second identity,
cleanup, IAM/bucket/billing modification, credential creation/modification, provider
change, Firebase production data access, Render action, scheduler, migration,
deployment, staging, commit, push or branch change occurred. Existing uncommitted
work was preserved. Both task admission markers were absent after execution.

## Final synthetic acceptance - actual execution

The user explicitly reaffirmed the still-unused ONE-run authorization after the
four metadata reads passed. The unchanged documented CLI was invoked exactly once
on 21 October 2026, **23:51:17.2473907 to 23:51:31.5233997 +08:00**. Exit code 0.
No subsequent cloud request, retry, second execution, cleanup or second identity
followed. The earlier config-only invocation was offline preparation, not acceptance.

### Pre-execution checks and precise command

- The latest report's four real metadata PASS results were reviewed: exact ACTIVE
  project, project-only ancestry using projectId, exact custom metadata permission
  and enabled/linked billing. They were not needlessly queried again.
- Thirteen relevant source/package/test paths matched the latest tested snapshot;
  package/lock hashes remain those recorded above. Node 22.14.0, Admin 14.5.0,
  Firestore 9.3.1, Storage 8.4.0 and auth library 11.3.1 were confirmed locally.
- The actual runtime was the latest fully tested isolated snapshot,
  `C:/Users/chuak/AppData/Local/Temp/menro-phase8h-ancestry-09b407997459457193c2e1d4f0e6083c`,
  not stale repository node_modules or the older pre-ancestry snapshot. This is a
  runtime-path selection, not a harness/dependency modification.
- The frozen exact project/bucket/SA allowlist, production-bucket exclusions,
  no-delete guard, authentication, generation and privacy checks were unchanged.
  Existing accepted IAM trust exceptions were retained, not treated as strict
  administrator isolation or an authorization to alter roles.
- Local gcloud config still matched the exact approved project/operator. The ADC
  remained the existing standard 402-byte file with its original modification time.
  No credential discovery override, emulator host or workflow/execute marker was
  present before admission. No credentials or access tokens were printed or saved.
- A fresh lowercase UUID was recorded offline. The zero-network CLI config check
  returned `mode: prepare`, `networkRequests: 0`, `cleanupAllowed: false`.
- The private manifest was marked `executionAttempted: true` before launch and a
  task-local one-use guard prevented a second invocation. There was no loop.
- Only the child NODE_ENV/test and acceptance admission markers were set. The
  inherited DEBUG was removed inside that Node child. Unlike the historical
  sample, **EVIDENCE_STORAGE_PROVIDER was never assigned**, preserving its existing
  absent/local-default state. No .env or running service was changed.

The same documented wrapper called `main()` with `safeFailure()` sanitization.
Its one live invocation, from the tested runtime above, was:

```powershell
$runner | & 'C:\Users\chuak\AppData\Roaming\fnm\node-versions\v22.14.0\installation\node.exe' - --config 'C:\Users\chuak\AppData\Local\Temp\menro-gcs-acceptance-cb80ff20-1d40-44f0-8931-95070c432c94\acceptance.json' --execute-authorized --adc-file 'C:\Users\chuak\AppData\Roaming\gcloud\application_default_credentials.json'
```

The required child markers were NODE_ENV=test,
MENRO_GCS_ACCEPTANCE_ENV=same-project-test-bucket and
MENRO_GCS_ACCEPTANCE_EXECUTE=AUTHORIZED_NONPRODUCTION_SYNTHETIC_ONLY. The execution
marker was removed on exit. This is an audit record, **NOT a command to rerun**.

The run config/manifest live outside Git in:
`C:/Users/chuak/AppData/Local/Temp/menro-gcs-acceptance-cb80ff20-1d40-44f0-8931-95070c432c94/`.
They contain only the approved tuple, synthetic namespace, expected hash/size,
sanitized result and recovery restrictions, never ADC contents or tokens. Preserve
these files and this report for any separately approved exact-generation cleanup.

### Actual acceptance results

| Test | Result | Actual evidence |
| --- | --- | --- |
| Execution bound | PASS | ONE live invocation; `resumed: false`, exit code 0; no retry or second execution |
| Exact effective identity | PASS | The unchanged keyless adapter verified the approved acceptance-SA email, verified-email flag, required scopes and expiry before constructing Storage; no source credentials reached the Storage client |
| Bucket identity/privacy | PASS | Fresh harness metadata validation accepted only the named bucket, asia-southeast1/Standard, enforced PAP and uniform access before any upload |
| Missing-object handling | PASS | The fixed never-created `missing.png` metadata probe returned the required 404; no object was created there |
| Create-only upload | PASS | Fixed 95-byte PNG save used `ifGenerationMatch=0`; first save succeeded, not same-prefix recovery |
| Rejected overwrite | PASS | Fixed 29-byte different payload to the SAME object with `ifGenerationMatch=0` received the required 412; no overwrite accepted |
| Metadata/privacy checks | PASS | Exact name/bucket, size 95, image/png, private no-store cache metadata, synthetic marker and SHA-256 matched; no public download token or public object ACL accepted |
| Authorized private retrieval | PASS | Both bounded generation-specific authenticated reads returned the expected 95 bytes and SHA-256 |
| Exact generation/unchanged original | PASS | Generation string `1792597882862915` was unchanged after the rejected collision; no Number conversion |
| Anonymous denial | PASS | Anonymous probe met the harness's 401/403-only requirement; the CLI does not expose which one and no specific status is invented |
| Cleanup/deletion | BLOCKED - NOT AUTHORIZED | Never attempted; `cleanupAllowed: false`; SDK implicit-delete guard retained |
| Second-identity test | BLOCKED - NOT AUTHORIZED | Not attempted; anonymous privacy probe is not a second authenticated identity |

The normal successful harness path performs nine logical Storage operations:
one bucket metadata read, one missing-object metadata probe, two save attempts,
two object metadata reads, two bounded authenticated generation reads and one
anonymous probe. This is not an exact transport-internal/billing-request count;
in-memory OAuth refresh/impersonation/tokeninfo traffic is separate. Storage
automatic retries remained disabled; no manual or automatic second run occurred.

### Sanitized object reference and result

```text
gs://menro-gcs-acceptance-20261021-6f8c2d91/menro-acceptance/cb80ff20-1d40-44f0-8931-95070c432c94/synthetic.png
generation: 1792597882862915
size: 95 bytes
SHA-256: c6237b04a3bc02f90c02786681d5a4df51e1703d11c9c6a85feeb8a4775787f4
```

The never-created probe name is
`menro-acceptance/cb80ff20-1d40-44f0-8931-95070c432c94/missing.png`.
It must not be treated as a cleanup target. No real photos, business identifiers,
Firestore records, evidence linkage, participant/guest quota or migration ledger
were involved.

Actual sanitized CLI result, preserved without changing its fields:

```json
{"mode":"acceptance","resumed":false,"createOnly":true,"integrity":true,"anonymousDenied":true,"generation":"1792597882862915","missingObject":true,"cleanupAllowed":false,"realServiceVerified":false,"limitation":"Transport assertions only; operator must attest real-service target, inherited IAM and execution provenance."}
```

`realServiceVerified: false` is the harness's intentional non-attestation flag,
not a failed assertion. The CLI can also run with injected transports in offline
tests and never self-certifies administrative isolation. This report separately
records the actual unmocked SDK/ADC execution, exact allowlisted resource,
authenticated guards and observed result. It attests this bounded real GCS contract
run, NOT universal IAM isolation or production/application-workflow readiness.

### Cleanup, costs and remaining blockers

**Cleanup status: NOT AUTHORIZED.** The one private 95-byte object was left in
place. No deletion, restore, lifecycle change or uncertain-object retry was made.
The object remains billable until separately approved cleanup. The previously
inspected seven-day soft-delete policy may retain/charge bytes after a later
deletion; it does not expire a live object after seven days. This run freshly
validated bucket privacy/region/class, not retention-policy drift or cost caps.
The accepted request/metadata/egress and shared-project billing risks remain.

No execution failure or functional blocker remains for the tested create-only,
generation, integrity and private-read contract. This real-service result does
not repair or hide the separate known Storage Emulator precondition limitation.
Full effective IAM/custody isolation, second-identity denial, exact cost/budget
limits and production/Render durability/backup/reconciliation remain outside this
run's evidence. No extra live queries were used to investigate them.

**Development-only recommendation:** GO to separately approved, scoped real-cloud
development-integration/activation planning using the dedicated test bucket, not
unconditional application activation. The standalone probe does not exercise all
MENRO record-level authorization, quota, upload/retrieval/revision and recovery
workflows against real GCS. Existing application cloud gates remain demo-only;
do not bypass them, switch provider or point business uploads at this project
without an explicit reviewed development-only plan and authorization. Local evidence
and read-preserving rollback remain unchanged. Production activation is BLOCKED.

### Files and verification in this execution task

Only `docs/firebase-storage-phase8h-results.md` changed in the repository. Two
non-secret private run files outside Git were created/updated: acceptance.json and
manifest.json. All source, tests, package/lock files, local evidence, real .env and
credentials were preserved. No new unit/full regression run was necessary because
the tested code/dependencies were unchanged; previous 67/17/254/542 results remain
historical. The actual new acceptance count is **1 run passed, 0 failed**, with the
individual checks and intentionally unexecuted tests distinguished above.

No production bucket or Firestore operation, IAM/bucket/billing/credential-file
modification, provider change, real-evidence migration, frontend change, scheduler
activation, Render operation, deployment, staging, commit, push or branch switch
occurred. Stop here; no further cloud call is authorized by this completed run.

## Current readiness and remaining approvals

| Item | Current disposition |
| --- | --- |
| Corrected ancestry validator and offline regressions | PASS |
| Authorized bounded read-only recheck | PASS; executed ONCE, 4 metadata reads; authorization consumed |
| Actual live ancestry representation / absence of new ancestors | PASS; exact projectId string, one project entry, no project parent |
| Fresh custom metadata role definition and billing | PASS; exact one-permission active role; billing enabled/linked |
| Prior accepted shared-project IAM exception | Preserved; not expanded into a claim of full isolation |
| Bounded synthetic acceptance | PASS; actual create-only/collision/integrity/generation/private-read contract verified |
| Single synthetic acceptance invocation | Used ONCE; no retry, recovery invocation or second execution authorized |
| Synthetic object | One private 95-byte object retained; generation `1792597882862915` |
| Development-only real-cloud evidence activation | GO for separately reviewed development-only integration planning; activation itself NOT AUTHORIZED |
| Cleanup / second identity / production activation / migration / deployment | NOT AUTHORIZED |

The offline correction involved no authenticated cloud API or ADC use. The
separately approved recheck performed four metadata reads. The final, separately
approved synthetic run then created only the test object and rejected its overwrite
as documented. No other cloud resource/configuration mutation occurred. Historical
results and known emulator limitations remain visible. Stop here; do not rerun
acceptance, clean up the object or enable storage.
