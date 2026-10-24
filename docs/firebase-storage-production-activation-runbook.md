# Firebase Storage controlled production activation runbook

Date prepared: 2026-10-23 (Asia/Manila)

Status: **PREPARED, NOT AUTHORIZED, DO NOT EXECUTE YET.** This runbook targets only
project `menrosystem-ddfac`, bucket `menrosystem-ddfac.firebasestorage.app`, Render
service `menroBK-1`, and backend `https://menrobk-1.onrender.com`.

## 1. Preconditions and named approvals

Assign one activation operator, one Firebase/IAM approver, one MENRO business verifier
and one rollback owner. Record the change window, deployed commits and the owner's
historical-photo waiver. The waiver permits old photos to become unavailable; it does
not permit deletion, migration, Firestore edits or reference rewrites.

Do not begin until every item is true:

- the exposed Firebase service-account key has been replaced, its replacement has been
  verified in the running service, and the old key has been disabled then deleted;
- the exposed request-identification encryption key has been rotated through reviewed
  dual-key/key-ID support and a fully reconciled persisted-record migration; a direct
  environment-variable swap is forbidden;
- the exact backend source covered by the recorded 613/613 regression is identified;
- the exact frontend source covered by the recorded 117/117 regression/build is identified;
- Render Environment shows the expected project and service-account email, valid secret
  presence, exact stable HTTPS `FRONTEND_URL` and `BACKEND_URL`, and required guest/request
  secrets, without exposing values;
- normal authenticated Auth/Firestore operations work, establishing that the configured
  certificate pair is usable; the displayed client email exactly matches
  `firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com`;
- Vercel Production targets the exact MENRO Firebase project and
  `https://menrobk-1.onrender.com/api`, and its deployed commit matches the reviewed source;
- production Storage Rules still deny every Firebase client read/write;
- the bucket still has no `allUsers` or `allAuthenticatedUsers` binding;
- PAP consumer/token-link review and UBLA ACL/IAM mapping are signed off;
- the runtime account has approved object-create/get access to this bucket;
- billing, seven-day soft delete, monitoring, reconciliation and incident owners are accepted;
- no emulator, development-GCS, migration, ADC-selector or public-evidence URL variable
  is configured in Render;
- no historical migration, cleanup, deletion or Firestore rewrite is scheduled; and
- explicit approvals exist for each production mutation: PAP, IAM/UBLA, backend deploy,
  Render activation variables and bounded synthetic application checks.

Any mismatch is a stop condition, not a reason to weaken validation.

Revision gate: never deploy directly from the current mixed working tree. With explicit
operator approval, update remote references, create a clean branch from the verified
`main`/live baseline, apply only the reviewed cohesive change, run `npm ci` and all
tests, and record the exact commit. Render auto-deploys commits on `main`; a push or
merge is therefore part of the production deployment approval, not a harmless
preparation step.

## 2. PAP and UBLA gates

These are independent change approvals. Do not bundle an unresolved security decision
with provider activation.

### PAP gate

In Google Cloud Console, select the exact project and bucket. Reconfirm no intentional
anonymous, `allUsers`, `allAuthenticatedUsers`, Firebase download-token or public-hosting
consumer exists. The owner declaration alone is insufficient if any contrary log,
workflow or integration is found.

When separately approved, enforce bucket-level PAP. Verify metadata reports `enforced`,
authenticated Google IAM access still succeeds, and an anonymous object request is
denied using only a preapproved synthetic object/reference. Do not probe a private real
object. PAP does not disable signed URLs; MENRO does not create them.

Stop on any required anonymous/token-link workflow or unexpected principal. Reverting
bucket PAP to inherited is a separate rollback mutation and cannot override an enforced
ancestor policy or recover an undiscovered public-link workflow.

### UBLA gate

Review the full available `storage.googleapis.com/authz/acl_operations_count` metric,
grouped by operation type. Map every project owner/editor/viewer legacy ACL beneficiary
to a documented need and IAM equivalent, or document that no access is required.
Confirm the Render identity's bucket IAM before disabling ACL authorization.

When separately approved, enable UBLA. Verify bucket IAM and authenticated metadata/get
behavior with a synthetic reference. Stop on any ACL-required event or missing IAM
equivalent. UBLA can be disabled only before it has remained enabled for 90 consecutive
days; after that it is irreversible. Record its enablement timestamp and rollback
deadline. Do not rely on the rollback window as a substitute for dependency review.

## 3. Prepare and deploy inactive code

1. Freeze backend/frontend source and record commit hashes plus test evidence.
2. Deploy the reviewed backend code while production GCS remains inactive:
   `MENRO_GCS_PRODUCTION` absent/false, `EVIDENCE_STORAGE_PROVIDER` absent/`local`, cloud
   write/read gates absent/false, and no approval marker.
3. Do not change the Vercel deployment unless its verified production target/source is
   wrong. If it must change, deploy and verify it before Storage activation.
4. Verify `GET /` health, login, authenticated session verification, normal Firestore
   reads and representative non-evidence operations.
5. Verify a missing historical planting/monitoring photo produces the existing
   unavailable state without changing the record, status, counts or statistics. Do not
   search for or disclose a real photo merely for this check; use an already known
   missing reference or skip and record the limitation.

Stop if the inactive deployment attempts a GCS operation or if Auth/Firestore behavior
regresses.

## 4. Exact Render activation configuration

In Render → `menroBK-1` → Environment, preserve unrelated variables. Confirm these
existing values without copying them out of Render:

```text
NODE_ENV=production
FIREBASE_PROJECT_ID=menrosystem-ddfac
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=<existing valid secret>
FRONTEND_URL=<exact stable Vercel HTTPS origin>
BACKEND_URL=https://menrobk-1.onrender.com
REQUEST_IDENTIFICATION_ENCRYPTION_KEY=<existing valid secret>
GUEST_INVITATION_SECRET=<valid secret, at least 32 characters>
```

Stage this exact activation delta as one reviewed set:

```text
FIREBASE_STORAGE_BUCKET=menrosystem-ddfac.firebasestorage.app
MENRO_GCS_PRODUCTION=true
EVIDENCE_STORAGE_PROVIDER=gcs
EVIDENCE_CLOUD_WORKFLOW_ENABLED=true
EVIDENCE_CLOUD_READ_ENABLED=true
EVIDENCE_GCS_PRODUCTION_APPROVAL=AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION
EVIDENCE_UPLOAD_MAINTENANCE_ENABLED=false
```

Explicitly remove/reject `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_CONFIG`, emulator
hosts, `MENRO_GCS_DEVELOPMENT`, `MENRO_INTEGRATION_TEST`, `MENRO_HISTORICAL_MIGRATION`,
`EVIDENCE_PUBLIC_URL` and `FIREBASE_STORAGE_PUBLIC_URL`. Do not add credentials to
Vercel. Render variables are strings; use exact lowercase `true` values.

Use Render's reviewed save/deploy option so the complete set becomes active in one
deployment. `Save only` does not change the running instance until a later deploy; if it
is used for staging, label the pending activation and prevent unrelated deploys.

## 5. Startup and pre-write validation

After the activation deploy:

1. Confirm exactly one instance becomes healthy and the deploy completes.
2. Check sanitized logs for configuration rejection, credential, Firestore, Storage,
   quota or startup errors. Never print environment values or tokens.
3. Verify `/` health, Firebase login, token verification and representative Firestore
   reads before uploading anything.
4. Verify an authorized request for an existing cloud synthetic reference, if one was
   explicitly prepared for this bucket, and verify anonymous denial. If none exists,
   do not substitute a real object; proceed to the bounded application write below.
5. Confirm no local `photoURL`/`photoPath` is created for new cloud-mode operations.

Stop before writes on identity/project/bucket mismatch, `403`, unexpected `404`, public
access, initialization failure, unknown principal, excessive retrying or cost anomaly.

## 6. Bounded synthetic application acceptance

Use generated, non-personal JPEG/PNG evidence no larger than 100 KiB. Use a dedicated
synthetic business record and a fresh idempotency key per workflow. Never retry an
ambiguous request with a new key; reuse the same key only for reconciliation. Do not
directly upload with a GCS CLI because that bypasses MENRO authorization and ledgers.

Proceed one stage at a time and stop on failure:

1. **Planting report:** submit one authorized synthetic report with one image. Confirm
   one business record, one completed workflow ledger, a version-1 private reference,
   exact production bucket/prefix/generation/hash/size/type, authenticated preview and
   anonymous denial. Confirm response data exposes `hasEvidence`, not the private reference.
2. **Guest contribution:** use one authorized synthetic guest invitation/allocation and
   one image. Confirm session authorization, stable contribution linkage, allocation
   change exactly once, same-key recovery behavior and protected preview through the
   aggregated planting report. Do not use or expose a real invitation token.
3. **Early or official monitoring:** submit the currently eligible synthetic monitoring
   type with one image. Confirm scheduling/business validation, immutable reference,
   staff/owner authorization and protected preview. Do not bypass schedule rules merely
   to test Storage.
4. **Correction/revision:** exercise a synthetic returned observation. Prefer retaining
   the already authorized evidence to prove generation-stable reuse; if replacement is
   explicitly approved, allow one new image/object only. Confirm the revision history
   retains its evidence selector and no prior object/reference is deleted.
5. Force no production failure deliberately. Validate ordinary user-facing errors only
   from naturally occurring rejected input or an approved non-production test. A failed
   upload must not produce a successful business record; ambiguous state must remain
   reconcilable under the same idempotency key.

Record only synthetic record IDs, intent IDs, generations, hashes, status codes and
boolean authorization results. Cleanup is not included; retain the synthetic objects
until a separate generation-specific cleanup approval is issued.

## 7. Acceptance criteria

Activation succeeds only if all of the following hold:

- every startup/identity/target/security gate matches exactly;
- PAP/UBLA decisions are implemented only as separately approved;
- all new evidence references point to private objects in the production namespace;
- authorized previews work and anonymous/cross-user access is denied;
- business records, quota and workflow ledgers reconcile exactly once;
- retries do not duplicate records, allocations or objects;
- missing historical images remain unavailable without corrupting records/statistics;
- no new evidence is stored permanently on Render's filesystem;
- no public URL, download token or ACL is added;
- monitoring shows no unexpected errors, retries, latency, operations or spend; and
- rollback ownership remains present through the observation window.

## 8. Stop and rollback criteria

Immediately stop new evidence submissions on any identity/project/bucket mismatch,
public access, authorization bypass, ACL dependency, startup failure, persistent 5xx,
ambiguous upload that cannot reconcile, duplicate linkage, generation/hash mismatch,
local-path creation in cloud mode, quota inconsistency, unexpected spend or missing
monitoring/rollback owner.

Do not delete objects, rewrite references, reset ledgers or disable cloud reads.

## 9. Read-preserving rollback

Because the free Render service has no persistent disk, first enable the backend's
evidence-upload maintenance gate. It returns HTTP 503 after authentication and
authorization but before rate limiting, multipart parsing, file processing, Storage
access or Firestore mutation. The source rollback mode selects local writes, but the
gate prevents requests from reaching that ephemeral path.

Apply this exact environment delta in one separately approved Render deployment:

```text
MENRO_GCS_PRODUCTION=true
FIREBASE_STORAGE_BUCKET=menrosystem-ddfac.firebasestorage.app
EVIDENCE_STORAGE_PROVIDER=local
EVIDENCE_CLOUD_WORKFLOW_ENABLED=false
EVIDENCE_CLOUD_READ_ENABLED=true
EVIDENCE_GCS_PRODUCTION_APPROVAL=AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION
EVIDENCE_UPLOAD_MAINTENANCE_ENABLED=true
```

Keep the exact Firebase project/account credentials. After deploy, verify health,
Auth/Firestore, authorized reads of already linked cloud generations, unavailable old
local photos, and zero new GCS writes. Preserve every intent, quota row, business record,
revision and object. Reconcile ambiguous operations before deciding whether to reactivate.

If cloud reads themselves must be disabled for a security incident, set production GCS
off and both cloud gates false only under incident approval. This intentionally makes
cloud evidence unavailable and is not the normal preservation-safe rollback.

Keep `EVIDENCE_UPLOAD_MAINTENANCE_ENABLED=true` for the entire local-mode rollback.
Do not resume new photo submissions in local mode on the free ephemeral service. Either
repair and reactivate the private GCS path or separately approve durable alternative
storage before setting the gate back to `false`.

## 10. Phased local-storage retirement

1. Keep local-reference reads and local-write support unchanged throughout credential
   remediation and the compatibility-only deployment.
2. Activate GCS only through this runbook after every security/configuration approval.
   Never combine activation with credential rotation.
3. During the observation window, prove all new planting, guest, early monitoring,
   official monitoring and correction/revision evidence references are GCS-backed and
   no new local `photoURL`/`photoPath` is created.
4. Complete bounded production acceptance and reconcile every ambiguous operation.
5. Retain local-reference read compatibility and the read-preserving emergency rollback
   mode. The historical-photo waiver does not authorize deleting records, paths or files.
6. After an approved observation period, use code search and aggregate telemetry—not
   private evidence listings—to identify unused local-write entry points.
7. Request a separate application change to disable local writes. Re-test rollback and
   unavailable-history presentation before deployment.
8. Remove local-write code only in a later separately approved release after accepting
   GCS-only rollback. Local-read compatibility may remain indefinitely. Never delete
   historical files or references as part of code retirement.

## 11. Post-change record

Record sanitized before/after bucket settings, IAM role names, Render/Vercel commit IDs,
environment key names (not values), deploy IDs, synthetic manifests, test outcomes,
observation interval, exceptions, rollback deadline for UBLA, and named owners. Link the
historical-photo waiver. Do not include tokens, private keys, invitation secrets, real
photos, personal data, private object names or signed/download URLs.
