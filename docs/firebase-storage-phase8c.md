# Phase 8C - real GCS acceptance preparation

**Superseding preparation:** [Phase 8D-8E](firebase-storage-phase8d-8e.md) resolves
the downloaded-key requirement with explicit-file ADC impersonation and adds a
missing-object probe, bucket identity/region/class validation and offline IAM review.
This report's counts and key-only limitations are historical. Live IAM/security
inspection and execution authorization remain outstanding; production stays blocked.

21 October 2026. **BLOCKED for real execution; offline preparation complete.**
No live cloud operation, IAM/key creation, real environment edit, dependency change,
frontend change, migration, deployment or Git mutation was performed. Approval of
the resources below is preparation approval, not proof of their live configuration.
This report supersedes Phase 7B/9A/9B statements that the CLI allowlist is empty.

## Exact harness-only target

- Project: `menrosystem-ddfac`
- Bucket: `menro-gcs-acceptance-20261021-6f8c2d91`
- Identity: `menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com`
- Requested region/class: `asia-southeast1` / Standard
- Approved bucket role: `roles/storage.objectUser`
- Object: `menro-acceptance/<lowercase UUID>/synthetic.png`

The frozen default allowlist contains exactly this tuple. The existing exported
`PROPOSED_SAME_PROJECT_TARGET` identifier is preserved for compatibility; it now
also supplies the approved preparation tuple. No wildcard, alternative identity,
production bucket or caller-supplied CLI allowlist is permitted. Both production
bucket names (`menrosystem-ddfac.firebasestorage.app` and `.appspot.com`) fail closed
even with a permissive injected test policy. Preparation constructs no transport
and reads no credentials. Execution still requires BOTH explicit CLI arguments and
the independent authorization marker. No-argument execution reports that gate.

The standalone module is not imported by application startup, initializes no
Firebase Admin/Firestore/Auth client, loads no dotenv/ADC, and uses only the fixed
GCS API endpoint after validation. There is no Firestore operation in its transport.
This is a code boundary, NOT an IAM sandbox against arbitrary code or stolen keys.
Inherited project/org permissions and impersonation paths remain NOT VERIFIED.
Do not test their denial by touching production objects or Firestore.

## Phase 8B verification and production safety

Current source dispatches by saved private reference AFTER record authorization.
`cloudRead`, not the write gate/provider, controls private retrieval. Demo local
uploads plus explicit cloud reads, and firebase-provider/write-disabled/read-enabled
mode remain supported. Missing/corrupt/denied cloud objects do not fall back locally.
Root-only planting aliases, legitimate null-clearing and monitoring revision access
remain supported. Exact-generation strings, hashes, bounded private streaming and
authorization checks are unchanged.

Production application writes AND reads still cannot be activated: the resolver
requires credential-free demo isolation for either cloud capability. Default/local
does not enable cloud access. The new allowlist applies ONLY to the standalone
probe; it does not enable business uploads, idempotency, migrations or workers.
Live deployed environment values were NOT inspected. No real .env was read or edited.
Phase 8B's documented 13/13 authenticated rollback emulator result is historical;
it was not rerun or claimed as a fresh integration result here.

## Permission and authentication blockers

1. **Metadata permission:** the harness calls bucket.getMetadata BEFORE any save
   to require uniform bucket-level access and enforced public access prevention.
   `roles/storage.objectUser` does NOT include `storage.buckets.get`. The role alone
   therefore cannot satisfy the probe. A mock 403 verifies zero subsequent writes.
   Separately approve a narrow custom permission grant on THIS bucket (role defined
   at project level but binding at bucket level), or review a trusted alternative
   inspection design. Do NOT grant project-wide Storage Admin or remove the check.
   If the identity already inherits this permission, inspect why: that is not proof
   of least privilege. No permission change was performed or is authorized here.
2. **Authentication:** current harness accepts an explicit, existing service-account
   JSON key file with the exact project/email, Google's token endpoint and validated
   key type. It has NO keyless/impersonation/ADC implementation. No credential file
   was searched for or read. Do NOT create a key, reuse backend production credentials,
   paste a key, or use the connected Firebase plugin. If an existing securely managed
   dedicated credential is unavailable/unapproved, execution stays blocked pending
   separately approved keyless harness work or an approved existing-key method.
3. **Live privacy/isolation:** bucket/SA existence, region/class, actual binding,
   public prevention, uniform access, inherited IAM, impersonation and billing are
   NOT VERIFIED. They require separately authorized operator inspection. The approved
   Object User role has update/delete/list capabilities beyond this probe's needs;
   bind it only to the test bucket, not project-wide. Harness has no delete/list API.

References (public documentation only):
[GCS role permissions](https://docs.cloud.google.com/storage/docs/access-control/iam-roles),
[generation preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions).

## Coverage and bounded cost

| Check | Prepared verification | Live status |
| --- | --- | --- |
| Create-only | Fixed PNG; CRC32C; ifGenerationMatch=0 | NOT RUN |
| Collision | Different bytes at same name must fail 412; recheck original generation/hash | NOT RUN |
| Exact generation | Canonical uint64 string, response generation equality, no numeric conversion | NOT RUN |
| Integrity/privacy | Size/MIME/SHA-256/private metadata, no download tokens, bucket privacy | NOT RUN |
| Anonymous access | No credentials/cookies/redirects; only 401/403 passes, 404 fails | NOT RUN |
| Missing/unauthorized | Offline metadata 404/read 403 fail closed, no replacement/fallback | Mock verified only |
| Cleanup | No automatic deletion; operator ownership/generation approval required | NOT RUN |

The existing real probe does NOT actively request a nonexistent object or a second
unauthorized authenticated identity. Those real negative cases require a separately
approved harness extension/identity; anonymous denial is not proof of all IAM paths.
It also does not exercise MENRO record-level API authorization; Phase 8B covers that
in demo only. `realServiceVerified` intentionally remains false even after transport
assertions; retain operator provenance and IAM review separately.

One invocation has at most two explicit saves, two metadata reads, two bounded
media reads, one bucket metadata read and one anonymous probe. SDK automatic retries
are off. At most one fixed tiny 2x2 PNG should be created; the second save is required
to fail. Stop immediately if it does not. No uploads of user files, no listings,
wildcard operations or bulk loops. Token acquisition/SDK transport internals are not
an exact billable-request guarantee. Costs include requests, egress, retention and
shared project billing; this harness has no durable global budget or spend cap.
Approve one prefix/run, monitor costs, and authorize any rerun explicitly. On uncertain
upload retain SAME prefix for recovery; do not hide orphaned objects with fresh UUIDs.

Cleanup requires separate authorization: verify exact bucket/prefix/object, synthetic
marker, known bytes/hash and captured generation; prove no business/ledger/revision
references; conditionally delete ONLY that exact generation with an approved tool.
If generation/ownership differs, stop. No wildcard/prefix-recursive deletion or bucket
policy changes. Retention, soft delete and versioning can retain billable bytes;
inspect/approve those policies separately. No cleanup command was executed/prepared
as an automatic part of acceptance.

## Exact commands and future authentication - NOT execution authorization

Offline tests (existing clean-dependency copy, Node 22.14.0):

```powershell
node --test --test-reporter=spec tests/nonproductionStorageAcceptance.test.js tests/evidenceStorageConfig.test.js tests/firebaseEvidenceRetrieval.test.js tests/evidenceRetrievalResolver.test.js tests/evidenceWorkflow.test.js tests/evidenceProductionReadiness.test.js tests/storageInitialization.test.js
```

After blockers and separate live execution approval ONLY, use a fresh dedicated
shell without application secrets, Firebase config, ADC, DEBUG, emulator hosts or
cloud workflow/read/migration flags. Do not clear another process's environment.
Config at `C:/private/menro-gcs-acceptance.json` must contain ONLY:

```json
{
  "projectId": "menrosystem-ddfac",
  "bucket": "menro-gcs-acceptance-20261021-6f8c2d91",
  "serviceAccountEmail": "menro-gcs-acceptance@menrosystem-ddfac.iam.gserviceaccount.com",
  "prefix": "menro-acceptance/<fresh-lowercase-UUID>/"
}
```

The UUID placeholder must be replaced and recorded privately before invocation.
Configuration is not a credential. Protect any separately approved existing key
outside Git with restrictive filesystem ACLs; do not create one for this preparation.

```powershell
$env:NODE_ENV='test'
$env:MENRO_GCS_ACCEPTANCE_ENV='same-project-test-bucket'
$env:EVIDENCE_STORAGE_PROVIDER='local'
# Offline configuration-only command, no credentials/cloud operations:
node scripts/acceptNonproductionEvidenceStorage.js --config C:/private/menro-gcs-acceptance.json
# FUTURE separately authorized live command ONLY; NOT RUN in Phase 8C:
$env:MENRO_GCS_ACCEPTANCE_EXECUTE='AUTHORIZED_NONPRODUCTION_SYNTHETIC_ONLY'
node scripts/acceptNonproductionEvidenceStorage.js --config C:/private/menro-gcs-acceptance.json --execute-authorized --credentials C:/private/menro-gcs-acceptance-existing-key.json
```

## Fresh verification results

- Focused harness/config/readiness: **75 passed, 0 failed, 0 skipped**.
- Expanded harness + Phase 8B config/retrieval/resolver/workflow/readiness/init:
  **116 passed, 0 failed, 0 skipped**, including the above (not additive).
- Existing clean install reused; package/lock hashes match repository. No install.
- Three scoped JavaScript syntax checks, five scoped files' whitespace checks and
  git diff --check passed. Default CLI returned zero network requests with execution
  blocked; staging remains empty and branch is unchanged.
- Initial sandbox runner could not spawn (EPERM); rerun with subprocess permission
  completed. That diagnostic did not execute tests and is not a product failure.
- No emulator started or contacted; no migration quota consumed/reset/bypassed.
- Known historical SCHEDULE_STALE fixture failures and native Storage Emulator
  generation-precondition failure are unchanged and NOT retested/hidden by this phase.

## Readiness checklist / next action

- [x] Exact tuple pinned only in standalone harness; independent execution gate.
- [x] Offline wrong-target/identity, privacy, missing/denied and rollback checks pass.
- [x] Production application activation remains blocked by existing guards.
- [ ] Approve narrow bucket metadata permission resolution without broad inherited access.
- [ ] Verify live bucket/SA/region/privacy/IAM/impersonation isolation separately.
- [ ] Approve available authentication method; current harness needs an existing key.
- [ ] Approve one bounded prefix/run, shared billing exposure and manual cleanup custody.
- [ ] Separately authorize real execution and any additional real negative-test coverage.

**BLOCKED for a real GCS acceptance run.** Preparation is complete; no cloud request
is authorized by setting a local marker. Stop here pending the above approvals.
