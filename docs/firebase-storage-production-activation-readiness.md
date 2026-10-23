# Firebase Storage production activation readiness

Date: 2026-10-23 (Asia/Manila)

**Final status: BLOCKED — do not activate or deploy.** The production-specific
application path is implemented and passes offline regression testing. The
2026-10-23 blocker-resolution pass performed authorized read-only Render and Google
Cloud metadata/IAM/billing checks. It made no mutation and accessed no Storage
object, production Firestore record, credential value or private evidence. Actual
findings below show that bucket hardening, runtime identity attestation and
deployment configuration are still unresolved. Storage Rules are now verified.

## Consolidated production-remediation checkpoint — 2026-10-23

### Current revision and deployment evidence

- Backend branch: `fix/validated-survival-analytics`; local HEAD
  `b615fd4a294b4c8a4babbe146a288938fa16c8ec`.
- The locally cached `origin/main` is
  `1735fbb9c4563c1db0c2d90a95b53556133c66e8`. It was not fetched because this pass
  was forbidden from modifying Git state, so it must not be represented as the current
  remote tip.
- Render read-only metadata confirms `menroBK-1` tracks repository `chua05/menroBK`,
  branch `main`, auto-deploys on commits, runs `npm ci` / `npm start`, has one Free-plan
  Singapore instance and no reported persistent disk. Its live deploy is commit
  `40e601df57226e5e913258e6fc3ecf3fb638d985`.
- The Render merge commit is not present in the local object database. Its message says
  it merged the local branch's monitoring/notification work, but exact tree equality
  cannot be established without an authorized fetch. Render therefore does **not**
  match the intended uncommitted remediation revision.
- The backend worktree is materially mixed: credential remediation, the full Firebase
  Storage implementation, geographic audit artifacts, monitoring/notification changes
  and other workflow work coexist. Many required Storage/remediation files are
  untracked. The frontend worktree is independently dirty with application changes and
  generated `graphify-out` artifacts. A blanket add/commit is unsafe.
- Tracked-file name and content scans found no committed private-key block, obvious API
  key pattern, service-account JSON or tracked real `.env`; only example environment
  files matched the sensitive-name scan. This is a bounded pattern scan, not a full
  secret-scanner certification.

### Dual-key compatibility conclusion

Source and tests confirm all compatibility requirements:

- the original `REQUEST_IDENTIFICATION_ENCRYPTION_KEY` remains sufficient for a
  compatibility-only deployment;
- old unkeyed ciphertext decrypts with that key and new writes receive
  `keyId=legacy-v1`;
- no new variable is required until actual rotation;
- once configured, only `REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE` encrypts;
- unknown IDs, unavailable keys and incomplete/invalid configurations fail closed;
- startup calls configuration validation, while the migration service/script is never
  imported or invoked by application startup;
- migration requires a separate command, exact gates, bounded page size and—only for
  rollback—an additional exact rollback approval;
- service/CLI output contains statuses and counts, not plaintext identifiers or key
  material; existing reveal auditing records only outcome metadata.

No application-code correction was necessary in this consolidation. The current
complete backend regression remains **613/613 passed**, including 7/7 focused
dual-key/migration tests and the existing request, Auth, authorization, Storage gating,
upload/retrieval and configuration suites. No source changed after that run. Frontend
tests were not repeated because this pass made no frontend change; the applicable
recorded result remains **117/117**.

### Firestore Rules closure

The owner verified the published Firestore Rules are a recursive deny-all rule for
client reads and writes. This covers both `requestIdentifications` and
`requestIdentificationKeyMigrations`; Admin SDK access remains IAM-controlled. This
closes the client-rules prerequisite for the future migration, but does not authorize a
production read, backup, write or migration.

### Deployment isolation requirement

Compatibility deployment is **NO-GO from the current worktree**. Prepare a clean branch
from the verified production/main baseline, then apply and review only the cohesive
dual-key slice:

- `src/services/requestIdentification.service.js`;
- `src/services/requestIdentificationKeyMigration.service.js`;
- `scripts/migrateRequestIdentificationKeys.js`;
- the matching package script only (do not copy unrelated dependency changes);
- `tests/requestIdentificationKeyRotation.test.js` and the relevant existing request
  tests;
- the four operator/readiness documents and only the credential-related example-env
  lines.

The compatibility deploy itself needs only the request-identification service change;
the migration service/script may ship inertly for later use. Do not include unrelated
Storage, map, analytics, monitoring, notification, generated graph or dependency-lock
changes merely because they are present. On the clean branch run `npm ci`, the focused
tests and the full backend suite; record the resulting commit. Because Render
auto-deploys `main`, merging/pushing that reviewed commit is itself a production-change
authorization checkpoint.

### Consolidated readiness decisions

| Area | Decision | Reason |
| --- | --- | --- |
| Compatibility deployment | **NO-GO** | Code passes, but the intended revision is not isolated/committed and does not match Render live commit |
| Identification-key rotation | **NO-GO** | Code/runbook ready; compatibility deploy, backup, secret change, production verification and migration approvals remain |
| Firebase Admin key rotation | **NO-GO** | Runbook ready; replacement creation, Render update, runtime attestation and disable/delete approvals remain |
| Frontend compatibility | **PASS IN SOURCE; DEPLOYED REVISION PARTIAL** | Public bundle has expected API/project markers and source uses authenticated backend blobs; Vercel commit/environment precedence remains unattested |
| PAP | **NO-GO** | Source-compatible, but effective organization policy and independent token-link consumer attestation remain open |
| UBLA | **NO-GO** | Source-compatible, but legacy ACL beneficiary/IAM mapping and full telemetry review remain open |
| IAM least privilege | **NO-GO FOR CHANGE** | Narrow transition is prepared; dependency analysis and approved grant-before-revoke test remain |
| Firebase Storage activation | **NO-GO** | Credential remediation, revision isolation, Render config, PAP/UBLA and IAM gates remain open |
| Local storage retirement | **NO-GO** | Keep compatibility/rollback until GCS production acceptance and a separate removal approval |

## Consolidated final readiness and blocker-resolution audit

### Executive summary

The application design is ready for private IAM-based GCS access, but the production
operation is **NO-GO**. Source inspection confirms fail-closed target/identity gates,
backend-mediated private retrieval, local-reference compatibility, immutable cloud
references and read-preserving rollback. Active Storage Rules deny every Firebase
client request. The current source does not require public access or ACLs.

The remaining blockers are operational: the actual Render identity and complete
environment are not attested; legacy ACL beneficiaries have not
been mapped to IAM; PAP's effective inherited policy and possible independently issued
download-token links remain unverified; and the deployed Vercel configuration has not
been inspected. Neither PAP nor UBLA may be changed, and the GCS provider may not be
activated, on the present evidence.

### 2026-10-23 credential-exposure and environment-completion update

The owner confirmed that `NODE_ENV=production`, `FIREBASE_PROJECT_ID` is the expected
project, and `FIREBASE_CLIENT_EMAIL` displays the expected Firebase Admin service
account. `FRONTEND_URL`, `FIREBASE_PRIVATE_KEY` and
`REQUEST_IDENTIFICATION_ENCRYPTION_KEY` are configured. This is useful configuration
evidence, but it is not cryptographic attestation of the identity used by the running
Render instance. The GCS activation variables remain intentionally absent, so the
write provider remains `local`.

Two configured credentials were exposed in a screenshot: the request-identification
encryption key and part of the Firebase service-account private key. Treat both full
credentials as compromised. No credential was read, printed, rotated or changed in
this audit.

#### Request-identification encryption-key impact and safe rotation

- The key protects persisted Firestore documents in `requestIdentifications`, not just
  transient data. Each record contains AES-256-GCM ciphertext, IV and authentication
  tag; `requestId` is authenticated as AAD. Admin reveal operations decrypt those
  existing records with the single current environment key.
- Startup accepts only canonical Base64 matching `^[A-Za-z0-9+/]{43}=$` and decoding
  to exactly 32 bytes. There is no key identifier, key ring or previous-key fallback.
  Directly replacing the environment variable would make every record written with
  the old key undecryptable.
- Zero-downtime/data-preserving rotation therefore requires a separately reviewed code
  change before the environment change: add an active key plus previous key/key ID,
  continue decrypting version-1 records with the old key, write new records only with
  the new key and a non-secret key ID, then run an authorized, resumable Firestore
  re-encryption migration. The migration must preserve each document ID and
  `requestId` AAD, verify decrypt/re-encrypt round trips without logging plaintext,
  record counts and failures only, and retain the old key until every record is
  reconciled and an authorized reveal test succeeds. Then remove the old-key fallback
  in a later deployment. A no-code direct swap is **not safe**.
- Until that capability and migration are authorized, do not rotate this value in
  isolation. Restrict access to the screenshot, remove it from shared locations under
  the incident owner's retention process, and avoid new identification submissions or
  admin reveals if incident policy requires immediate containment. Do not delete the
  only usable old key before the migration is complete.

#### Firebase Admin private-key rotation

- Create a new user-managed key for the same expected service account in Google Cloud;
  do not delete or disable the old key yet. Store/download the new key through the
  approved secret channel only and never paste it into chat, logs or source control.
- In one approved Render change, replace only `FIREBASE_PRIVATE_KEY` while retaining
  the already confirmed project and client-email values. Render environment changes
  take effect through a new deploy/restart; use the normal zero-downtime deploy path
  and do not combine this credential rotation with GCS activation or application-code
  changes.
- Verify the replacement deployment becomes healthy, login/session validation works,
  and a bounded existing Firebase Admin Auth/Firestore operation succeeds. Confirm
  Google Cloud audit evidence shows the new key ID authenticating, without displaying
  tokens or private material. If verification fails, restore the old Render secret and
  redeploy before taking any key-side action.
- After a monitoring window with no use of the old key, disable the old key first,
  monitor again, and only then delete it. Deletion is irreversible. This sequence also
  provides the required runtime-identity attestation when the successful new key is
  known to belong to the exact allowlisted service account.

#### Missing variables, linked groups and deployed frontend evidence

- `BACKEND_URL` is mandatory for production local planting-photo writes and for the
  local-write rollback path. There is no production fallback. Set it to the single
  origin `https://menrobk-1.onrender.com`: HTTPS, no credentials, path, query, fragment
  or comma, and an optional trailing slash is normalized by the write path.
- `GUEST_INVITATION_SECRET` is operationally mandatory only when guest invitations are
  enabled. It is not a universal startup requirement: invitation creation is skipped
  when absent, while invitation retrieval/signing fails. The value must be a trimmed
  secret of at least 32 characters. Changing it invalidates the ability to regenerate
  every existing invitation token, so establish whether invitations already exist
  before creating or rotating it.
- Render's read-only service-detail interface exposes neither environment-variable nor
  linked-environment-group metadata. Therefore the screenshot absence does not prove
  either key is absent, and linked-group supply/precedence remains **UNVERIFIED**. In
  Render Dashboard, inspect both the service Environment page and each linked group;
  remember that a service-level key overrides a group key. Report names and source
  only, never values.
- The expected frontend origin `https://menro-xxtt-five.vercel.app` returned HTTP 200
  from Vercel and identified itself as MENRO Bulan. Its public deployed bundle contains
  the expected `https://menrobk-1.onrender.com/api` endpoint and project identifier.
  This confirms the configured `FRONTEND_URL` is consistent **only if** its hidden
  Render value exactly equals that origin. The owner must compare it in Render because
  its actual value was not exposed to this audit.

#### Safe Render update order

1. Before any change, record the current successful deploy ID and non-secret variable
   names/sources; confirm local mode by leaving every GCS activation variable absent.
2. Resolve `BACKEND_URL` and `GUEST_INVITATION_SECRET` source/precedence. Stage those
   completion changes together only if missing, then deploy once and verify health,
   CORS/login, one local evidence workflow that does not expose private evidence, and
   guest-invitation behavior if enabled. Stop and roll back on startup, auth, CORS,
   upload-link or invitation regression.
3. Rotate the Firebase private key in a separate deployment using the procedure above.
   Do not disable the old cloud key until the replacement deployment is verified.
4. Implement and validate dual-key request-identification support in a separate code
   change before staging its new key. Migrate only with explicit authorization and a
   rollback/reconciliation record; retire the exposed key last.
5. Do not add `FIREBASE_STORAGE_BUCKET`, `MENRO_GCS_PRODUCTION`, select `gcs`, or enable
   cloud read/write gates during any credential/configuration remediation. GCS
   activation remains a later, separately authorized change.

### 2026-10-23 credential-remediation implementation update

The source-level request-identification blocker is now implemented and locally tested:

- dual-key configuration supports a single active encryption key and one previous
  decryption key while retaining the original variable as a compatibility bridge;
- legacy unkeyed records remain decryptable through `legacy-v1`, while every new
  encrypted envelope includes a non-secret `keyId` and is written only by the active
  key;
- keyed decryption selects an exact ID and fails closed when that key is unavailable;
  it never guesses or cycles through keys;
- startup rejects incomplete pairs, malformed key IDs, invalid key material and one ID
  assigned to different key bytes;
- the bounded migration supports dry-run, execute, reconcile and guarded rollback,
  with 1-100 record pages, resume cursors, an atomic per-record ledger, encrypted
  rollback envelopes and ciphertext digests;
- failed Firestore commits leave the source and ledger unchanged; retries are
  idempotent, and reconciliation detects modified ciphertext or ledger conflicts;
- command output contains aggregate status counts, pagination state and the non-secret
  active key ID only. It does not emit plaintext identification numbers or key values;
- the command is inert unless production project checks and two exact migration gates
  are present. No production command was run and no production data was accessed.

Focused local results: **7/7 new rotation/migration tests passed** and **17/17 existing
seedling-request support tests passed**. Coverage includes old-key reads, active-key
writes, missing-key failure, dry-run non-mutation, retry after failed commit,
idempotent replay, reconciliation, rollback, CLI gates and output redaction. The first combined
test-run attempt was blocked by the local sandbox's child-process restriction; each
file then passed independently with Node test isolation disabled. The subsequently
authorized complete backend suite passed **613/613**. This is not production migration
evidence.

Operator procedures are now separated into:

- `docs/request-identification-key-rotation-runbook.md` for compatibility deployment,
  dual-key cutover, dry-run, migration, reconciliation, rollback and old-key retirement;
- `docs/firebase-admin-key-rotation-runbook.md` for create, Render replacement,
  runtime verification, disable-monitor and delete sequencing.

The credential exposure remains an operational blocker. Source readiness does not
authorize generating keys, changing Render, reading/migrating Firestore, deploying or
retiring either old credential.

This consolidation reused the current 2026-10-23 source, cloud, Render, Rules, Phase
8G/8H and test evidence. It made no application-code, cloud, Render, Vercel, object,
Firestore or deployment change. No live acceptance test was repeated.

### Consolidated findings

#### Firebase Admin and target selection

- In production, Firebase Admin requires `FIREBASE_PROJECT_ID`,
  `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`. It builds an explicit Admin
  certificate from those values; `FIREBASE_CLIENT_EMAIL` therefore selects the
  requested service-account principal. Escaped newlines in the key are normalized,
  and malformed credentials fail during Admin SDK initialization. Values were not
  read, so this does not attest the principal actually running on Render.
- For the current local-provider mode, Firebase initialization does not require a
  Storage bucket. If `FIREBASE_STORAGE_BUCKET` is absent, no Storage bucket is passed
  to Admin and the resolved bucket is `null`. There is intentionally no implicit
  production-bucket fallback.
- For production GCS activation, `FIREBASE_STORAGE_BUCKET` is mandatory and must equal
  `menrosystem-ddfac.firebasestorage.app`. The project must equal `menrosystem-ddfac`,
  and the client email must equal the hardcoded expected Firebase Admin service account.
  A missing or mismatched value fails closed before a Storage client is exposed.
- Outside the activated GCS path, the general Firebase Auth/Firestore initialization
  trusts the supplied project and certificate; it does not independently hardcode the
  MENRO project. The offline readiness validator checks the exact project, but only
  inspection/attestation of Render's actual values can prove the deployed target.
- Production GCS rejects development, integration, migration, emulator and
  `GOOGLE_APPLICATION_CREDENTIALS` selectors. It cannot silently select an alternate
  project, URL-shaped bucket, or development/acceptance bucket.

#### Evidence provider, retrieval and failure behavior

- `EVIDENCE_STORAGE_PROVIDER` defaults to `local`. Missing cloud variables therefore
  preserve the existing local behavior and do not accidentally activate GCS.
- GCS writes require every production flag, the exact approval marker, cloud reads,
  the exact target and the exact expected identity. Selecting `gcs` without the
  production gate is rejected.
- Local and GCS writes do not run concurrently. The supported modes are GCS writes plus
  cloud reads, or read-preserving rollback with local writes plus cloud reads. Both
  local and cloud references can coexist in records and are dispatched by the saved
  reference type. A failed cloud reference never falls back to a local path.
- Historical local references remain readable only while their referenced bytes still
  exist beneath `uploads/`. Switching new writes to GCS does not rewrite those records,
  but it also does not preserve ephemeral local bytes.
- Object writes are create-only and idempotency-ledger-backed. References pin the exact
  bucket, object name, uint64 generation, content type, size and SHA-256. Ambiguous
  failures become reconciliation work; automatic deletion and overwrite recovery are
  forbidden. Retrieval validates the pinned metadata and content before delivery.

#### Render deployment

- Read-only service metadata confirms `menroBK-1` is a Node web service with no attached
  persistent disk. Repository-relative `uploads/` is consequently ephemeral across
  restarts and replacement deploys.
- Operator evidence confirms only these Render key names are visible:
  `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_PROJECT_ID`,
  `FRONTEND_URL`, `NODE_ENV`, and `REQUEST_IDENTIFICATION_ENCRYPTION_KEY`. This proves
  name presence only, not values, source/precedence, validity, or runtime identity.
- That list is sufficient to initialize the current Firebase Auth/Firestore application
  if values are valid, and absence of Storage activation variables safely leaves the
  provider local. It is not a complete production-operational configuration: local
  planting-photo URL creation requires `BACKEND_URL`, guest invitation workflows
  require `GUEST_INVITATION_SECRET`, and the future GCS activation variables are absent.
- The expected service account has sufficient but excessive project-wide permissions.
  The source asserts the expected email during GCS activation, but an environment string
  is not cryptographic proof that the private key belongs to that account. Runtime
  identity remains **UNVERIFIED**.

#### Vercel frontend

- The accessible frontend initializes Firebase App/Auth. It includes
  `VITE_FIREBASE_STORAGE_BUCKET` in the Firebase options but never constructs a Storage
  client, imports `firebase/storage`, calls `getDownloadURL`, or uploads/downloads an
  object directly.
- Evidence previews send a Firebase ID token to the configured MENRO API, receive an
  authorized response blob, use a temporary browser `blob:` URL, and revoke it.
  Planting and monitoring pages use protected `/api/evidence/...` selectors rather than
  object paths or references.
- This source is compatible with PAP and UBLA. The actual deployed Vercel bundle,
  `VITE_API_URL`, Firebase project values and environment precedence remain
  **UNVERIFIED** because no authenticated Vercel configuration read was available.

#### PAP, UBLA, IAM and consumers

- Live bucket metadata remains PAP=`inherited`, UBLA=`false`; bucket/default ACLs grant
  legacy roles to project owners/editors/viewers. No public principal was found.
- Operator IAM evidence is consistent with the earlier API reads: the Firebase Admin
  service account has Storage Admin and related Firebase/Auth/Token Creator roles, and
  expected Google-managed service agents are present. No unknown third party is known.
  The owner declares MENRO the only intentional application. Neither source proves
  complete effective IAM, key custody, manually shared token URLs, or ACL-only use.
- The available ACL-operations metric has zero series/points for the production bucket's
  complete available lifetime. Visible audit methods contain only bucket creation.
  These are positive observations, not proof that no external/ACL consumer exists.
- PAP is compatible with MENRO. Historical local files are unaffected. Because object
  metadata was deliberately not inspected, independently issued Firebase download-token
  links cannot be excluded. The effective ancestor policy cannot be queried while the
  Organization Policy API is disabled; enabling it is not authorized. Bucket-level PAP
  can still be evaluated as a separate setting, but enforcement remains NO-GO until the
  consumer/token exception question is closed by accountable attestation.
- UBLA is compatible with MENRO's IAM-based Admin access and MENRO performs no ACL
  operation. It would disable every legacy bucket/object ACL. The intended runtime
  service account has ample IAM access, but owners/editors/viewers may currently receive
  access through legacy ACLs and their required IAM equivalents are undocumented. UBLA
  becomes irreversible after 90 consecutive days.

#### Historical evidence waiver and migration

- Local retrieval is root-confined, rejects unsafe paths/symlinks and preserves legacy
  report, contribution, monitoring and revision selectors. Cloud and local references
  remain stable and are never guessed from a client-supplied path.
- The owner explicitly waives recovery, backup, restore and migration of historical
  Render-hosted photos as activation requirements. This closes the former preservation
  blocker by business decision, not by technical recovery. It authorizes no read,
  deletion, mutation, reference rewrite or Firestore change. Existing bytes remain on
  an ephemeral filesystem and may disappear on restart/redeploy.
- Migration code has strong design safeguards: bounded manifests, source path/hash/type
  revalidation, stable operation IDs, attempt budgets, create-only cloud upload,
  transactional link checks, preserved originals, exact generation/hash verification,
  resumable ledger states and explicit reconciliation after partial/ambiguous failures.
- That migration implementation is intentionally emulator-only and namespace-gated.
  It is not an authorized production migration path. Its tests establish design behavior,
  not the existence, completeness or recoverability of production evidence.
- Normal rollback preserves cloud reads while returning new writes to local storage.
  It does not restore lost local bytes. Because the free Render service has no durable
  local storage, rollback to local writes is an emergency containment mode only; it is
  not acceptable as long-term evidence storage.
- Missing historical photos do not alter the saved planting/monitoring records,
  quantities, review history, observations or calculated statistics. The protected
  evidence endpoint returns 404 and the frontend shows “Photo is unavailable” or its
  existing unavailable/error state. Reviews that operationally require seeing an old
  photo may be impossible and must be handled as a documented historical exception;
  the application must not fabricate or relink evidence.

#### Tests and acceptance

- Latest recorded backend regression: **613/613 passed**. Frontend: **117/117 passed**,
  targeted lint and production build passed. Emulator aggregate remains 61/62, with the
  single documented native Storage Emulator `ifGenerationMatch=0` limitation.
- Phase 8H's one bounded real-GCS acceptance passed create-only overwrite rejection,
  exact generation/integrity, private retrieval and anonymous denial against the
  separate acceptance bucket. Its retained object was not touched in this audit.
- Relevant coverage includes production gate mismatches, provider modes, initialization,
  namespace isolation, immutable upload/reconciliation, authorization-before-read,
  historical local compatibility, retained/replaced correction evidence and rollback.
- Untested critical production facts are the actual Render identity/values, actual Vercel
  deployment values, real historical inventory/restore, production-bucket application
  workflow, PAP enforcement and UBLA cutover. Static inspection found no new issue in
  the reviewed paths. Because this audit changed documentation only and the working
  trees already contain the source previously covered by the recorded suites, those
  suites and the live acceptance were not repeated.

### Environment variable matrix

“Deployed” below means only that the operator saw the key name; no value is reproduced
or treated as verified.

| Variable | Purpose | Current local deployment | Future GCS activation | Safe fallback | Source verified | Deployed verified | Recommended action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | Select production credential/startup rules | Required | Required=`production` | No | Yes | Name only | Attest exact value |
| `FIREBASE_PROJECT_ID` | Admin Auth/Firestore project; production target | Required | Required exact MENRO project | No | Yes | Name only | Attest exact value without secrets |
| `FIREBASE_CLIENT_EMAIL` | Admin certificate principal | Required | Required exact allowlisted service account | No | Yes | Name only | Cryptographically attest runtime identity; do not reveal value if policy treats it as sensitive |
| `FIREBASE_PRIVATE_KEY` | Admin credential | Required secret | Required secret | No | Yes | Presence/name only | Keep confidential; attest identity in memory only |
| `FRONTEND_URL` | CORS and email-link origin | Required by readiness validator | Required | No production fallback accepted by validator | Yes | Name only | Attest exact stable HTTPS origin |
| `REQUEST_IDENTIFICATION_ENCRYPTION_KEY` | Encrypt request-identification material | Required secret | Required secret | No | Yes | Presence/name only | Keep confidential; validate format internally |
| `BACKEND_URL` | Canonical local upload URL origin | Required for production local planting uploads | Required operationally/rollback | No production fallback | Yes | Not visible | Add only after confirming exact stable HTTPS Render origin |
| `GUEST_INVITATION_SECRET` | Guest invitation signing/validation | Required for guest workflow/readiness | Required | No | Yes | Not visible | Configure as a secret if guest contributions remain enabled |
| `FIREBASE_STORAGE_BUCKET` | Admin/GCS bucket target | Optional while purely local | Required exact production bucket | No activation fallback | Yes | Not visible | Add during approved activation preparation only |
| `EVIDENCE_STORAGE_PROVIDER` | Select write provider | Optional; defaults `local` | Required=`gcs` | Safe current fallback=`local` | Yes | Not visible | Leave absent/local until activation approval |
| `MENRO_GCS_PRODUCTION` | Unlock production GCS resolver | Not required; absent/off | Required=`true` | Safe absent/off | Yes | Not visible | Add only in atomic approved activation delta |
| `EVIDENCE_CLOUD_WORKFLOW_ENABLED` | Enable cloud evidence writes | Not required; defaults false | Required=`true` | Safe false | Yes | Not visible | Add only in activation delta |
| `EVIDENCE_CLOUD_READ_ENABLED` | Enable private cloud retrieval | Not required; defaults false | Required=`true` | Safe false; rollback explicitly true | Yes | Not visible | Add only in activation delta |
| `EVIDENCE_GCS_PRODUCTION_APPROVAL` | Exact activation authorization marker | Must be absent while inactive | Required exact marker | Safe absent | Yes | Not visible | Add only after every gate is approved |
| `ALLOWED_ORIGINS` | Additional exact CORS origins | Optional | Optional | Stable allowlist plus `FRONTEND_URL` | Yes | Unverified | Keep absent unless an additional reviewed origin is needed |
| Evidence quota variables | Daily file/byte/global alert thresholds | Optional | Optional but operationally recommended | Bounded source defaults | Yes | Unverified | Approve defaults or configure reviewed numeric values |

#### Authoritative production environment matrix

This expanded matrix supersedes the compact matrix above for the activation runbook.
“Observed” means the owner saw the key name in Render; no value is treated as verified.

| Variable | Purpose | Local mode | GCS mode | Expected non-secret value / secret format | Secret | Default | Observed in Render | Actual value verified | Operator action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | Production initialization | Required | Required | `production` | No | No safe production default | Owner confirmed | Yes, operator attestation | Preserve |
| `FIREBASE_PROJECT_ID` | Admin Auth/Firestore/project target | Required | Required | `menrosystem-ddfac` | No | None | Owner confirmed | Yes, operator attestation | Preserve |
| `FIREBASE_CLIENT_EMAIL` | Admin certificate identity | Required | Required exact | Expected Firebase Admin SA email | Sensitive identifier | None | Owner confirmed match | Display value only; runtime identity unverified | Attest replacement key through successful runtime use/audit evidence |
| `FIREBASE_PRIVATE_KEY` | Admin certificate signing key | Required | Required | Matching PEM; escaped `\\n` newlines accepted | **Yes** | None | Configured; partially exposed | Compromised / runtime identity unverified | Rotate safely before activation; never reveal |
| `FIREBASE_STORAGE_BUCKET` | Production object target | Optional | Required exact | `menrosystem-ddfac.firebasestorage.app` | No | None; omitted resolves `null` | Not seen | No | Add only in approved activation delta |
| `MENRO_GCS_PRODUCTION` | Unlock production resolver | Absent/`false` | Required | `true` | No | Inactive when absent | Not seen | Absence based on screenshot only | Add only in activation delta |
| `EVIDENCE_STORAGE_PROVIDER` | New-evidence write provider | Optional | Required | local=`local`; activation=`gcs` | No | `local` | Not seen | Absence based on screenshot only | Leave absent/local until activation |
| `EVIDENCE_CLOUD_WORKFLOW_ENABLED` | Cloud writes | Optional | Required | `true` for activation | No | False when absent | Not seen | No | Add only in activation delta |
| `EVIDENCE_CLOUD_READ_ENABLED` | Private cloud retrieval | Optional | Required | `true`; remains true in rollback | No | False when absent | Not seen | No | Add only in activation delta |
| `EVIDENCE_GCS_PRODUCTION_APPROVAL` | Explicit approval marker | Must be absent | Required exact | `AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION` | No | None | Not seen | No | Add only after all approvals |
| `BACKEND_URL` | Canonical local-link/rollback origin | Required for production local photo writes | Operationally required | `https://menrobk-1.onrender.com` | No | None in production | Not seen | No | Confirm linked group or add before approved deploy |
| `FRONTEND_URL` | CORS/email origin | Required | Required | `https://menro-xxtt-five.vercel.app`; HTTPS origin only, no credentials/path/query/fragment | No | Readiness validator accepts none | Configured | Value hidden; live expected origin verified | Operator compares exact hidden value |
| `GUEST_INVITATION_SECRET` | Guest invitation integrity | Required for guest workflow | Required | At least 32 secret characters | **Yes** | None | Not seen | No | Confirm linked group or configure secret |
| `REQUEST_IDENTIFICATION_ENCRYPTION_KEY` | Encrypt/decrypt persisted request identity | Required | Required | Canonical Base64 of exactly 32 bytes (`43` Base64 characters plus `=`) | **Yes** | None | Configured; exposed | Compromised; single-key persisted-data dependency confirmed | Do not direct-swap; implement dual-key migration, then rotate |
| `ALLOWED_ORIGINS` | Additional CORS origins | Optional | Optional | Comma-separated exact HTTPS origins | No | Reviewed built-in origins plus `FRONTEND_URL` | Not reported | No | Leave absent unless specifically required |
| `ALLOW_VERCEL_PREVIEWS` | Preview-origin policy | Optional | Optional | Prefer `false` | No | False when absent | Not reported | No | Do not enable without review |
| `EVIDENCE_DAILY_FILE_LIMIT` | Daily upload quota | Optional | Optional | Positive integer; default `50` | No | `50` | Not reported | No | Approve default or set reviewed value |
| `EVIDENCE_DAILY_BYTE_LIMIT` | Daily byte quota | Optional | Optional | Positive integer; default `209715200` | No | 200 MiB | Not reported | No | Approve default or set reviewed value |
| `EVIDENCE_GLOBAL_DAILY_ALERT_BYTES` | Aggregate alert threshold | Optional | Optional | Positive integer; default `1073741824` | No | 1 GiB | Not reported | No | Approve default or set reviewed value |

Forbidden in the production GCS runtime: emulator host variables,
`GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_CONFIG`, `MENRO_GCS_DEVELOPMENT`, active
integration/migration selectors, and public-evidence URL variables. Linked Render
environment groups remain unverified; a service-level key overrides a linked-group key.

### Final readiness matrix

| Area | Result | Basis / remaining gap |
| --- | --- | --- |
| Backend code | **PASS** | Fail-closed exact target/identity/gates; private immutable upload/retrieval; temp cleanup; rollback implemented |
| Frontend code | **PASS** | Authenticated backend blobs, explicit loading/unavailable states, no Storage client access |
| Render deployment | **UNVERIFIED** | Service/disk metadata known; complete key sources, actual values and runtime identity unknown |
| Vercel deployment | **UNVERIFIED** | Compatible source accessible; deployed values/commit not attested |
| Firebase bucket | **NEEDS VERIFICATION** | Exact live bucket known; hardening and least-privilege changes pending |
| PAP | **UNVERIFIED / NO-GO** | Source-compatible; inherited policy/token-consumer question remains |
| UBLA | **UNVERIFIED / NO-GO** | Source-compatible; legacy ACL/IAM mapping remains |
| IAM | **NEEDS REMEDIATION APPROVAL** | Runtime SA sufficient but project-wide roles are excessive; actual Render identity unverified |
| Historical photo waiver | **ACCEPTED / CLOSED** | Recovery, backup and migration waived; deletion/reference changes remain forbidden |
| New evidence protection | **PASS IN SOURCE; LIVE UNVERIFIED** | Private create/get, exact generations/hashes and authenticated backend delivery covered offline/acceptance bucket |
| Production activation | **NO-GO** | Deployment identity/configuration, PAP/UBLA and IAM gates remain open |

### Resolved in this final preparation pass

- Converted historical backup/recovery/migration from a blocker to an explicitly
  accepted owner waiver while preserving all records, references and files untouched.
- Documented exactly which planting, aggregated guest, monitoring and revision views
  can show unavailable historical photos without changing statistics or workflow state.
- Verified uploads use Multer memory buffers; private cloud retrieval uses a mode-0600
  OS-temporary staging file and removes the file/directory in `finally`, including error
  and disconnect paths. No durable Render disk is required for new GCS evidence.
- Verified sanitized 404/403/500 evidence responses and existing frontend loading,
  session, forbidden, missing and failure states.
- Completed the authoritative environment matrix and created the operator-executable
  activation/rollback runbook.

The earlier Storage preparation pass changed only its reports. The later credential
remediation pass added the dual-key/migration source and tests and established the
current 613/613 backend result. This consolidation changed documentation only; the
recorded 117/117 frontend result remains applicable because no frontend source was
changed here. Production-only facts listed as unverified remain gaps, not regression
claims.

### Blocker resolution matrix

| ID | Severity | Technical cause / evidence | Required resolution | Codex resolution | Operator action | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | Critical | Expected client email/project are operator-confirmed, but a displayed email does not prove the running private key's identity | Attest the replacement key through successful bounded Admin operations plus matching non-secret Cloud audit key identity | Rotation procedure prepared | Yes | Health/Auth/Firestore check and audit evidence after approved rotation | OPEN |
| B2 | Critical | GCS activation variables are absent, intentionally leaving local mode | Configure exact atomic activation delta only after all other gates | Prepared names/validation | Yes, later | Non-secret projection validator plus post-change startup/smoke test | OPEN / DO NOT SET YET |
| B3 | Accepted data-loss risk | Historical local photos are ephemeral and unverified | Owner waived recovery/backup/migration without authorizing deletion or record changes | Waiver documented | No further activation task | Preserve records; missing bytes render unavailable | **WAIVED — NOT A BLOCKER** |
| B4 | High | PAP inherited; effective ancestor policy and independent token-link use unresolved | View effective policy without mutation and attest no required public/token consumer | API cannot be enabled; object metadata prohibited | Yes | Console policy view plus accountable consumer exception record | OPEN |
| B5 | High | UBLA off; legacy project-team ACLs active despite zero observed metric use | Map each ACL beneficiary to required IAM or document no need | Source/telemetry reviewed | Yes | IAM Policy Analyzer/Console and full-period ACL metric review | OPEN |
| B6 | High | Firebase Admin SA has project-wide Storage Admin/Token Creator | Dependency review and approved bucket-scoped least privilege transition | Plan documented; mutation unauthorized | Yes | Policy Analyzer/audit logs, grant-before-revoke test | OPEN |
| B7 | High | `BACKEND_URL` and `GUEST_INVITATION_SECRET` not visible; Render read-only service metadata does not expose linked groups | Inspect service and linked-group key sources/precedence; add only if absent | Exact formats and operational impact confirmed | Yes | Dashboard name/source check, then bounded workflow checks after approved deployment | OPEN |
| B8 | Medium | Live MENRO origin, expected API and project identifier are present in the public deployed bundle; hidden Render `FRONTEND_URL` value and Vercel commit remain unattested | Compare Render value exactly and attest Vercel production deployment commit | Public deployment evidence improved | Yes | Exact origin comparison and deployment commit check | OPEN (NARROWED) |
| B9 | Informational | Production migration is emulator-only | No migration is required under the owner waiver | Safeguards and boundary documented | No | Verify no migration variable/job is configured | **NOT REQUIRED** |
| B10 | Critical | Exposed request-identification key still protects persisted records | Dual-key/key-ID code, bounded migration, reconciliation, guarded rollback and tests are complete; operator must deploy, rotate, migrate/reconcile, then retire old key | **IMPLEMENTED LOCALLY**; no production access | Yes | All pages reconciled, zero conflicts/unavailable keys, authorized reveal test, old key retired last | OPEN — OPERATOR ROTATION/MIGRATION REQUIRED |
| B11 | Critical | Firebase service-account private key was partially exposed; the full key must be treated as compromised | Create replacement on same SA, deploy/verify it, disable-monitor-delete old key | Separate exact runbook complete; mutation unauthorized | Yes | Healthy deploy, bounded Admin operation and Cloud audit evidence for new key before old-key disable/delete | OPEN — OPERATOR ROTATION REQUIRED |

### Production security decision

| Gate | Decision |
| --- | --- |
| Public Access Prevention | **NEEDS VERIFICATION — NO-GO** |
| Uniform bucket-level access | **NEEDS VERIFICATION — NO-GO** |
| Render runtime identity | **UNVERIFIED** |
| Vercel deployed configuration | **UNVERIFIED** |
| Historical evidence backup/restore | **WAIVED BY OWNER — NOT AN ACTIVATION BLOCKER** |
| Production GCS activation | **NO-GO** |

No application-code defect requiring a production fix was found in the reviewed Storage
path. The missing work is deployment attestation and approved security/IAM
operations—not another implementation or evidence-preservation phase.

### Authoritative prioritized operator checklist

This is the single action list; the older procedural notes below are retained only as
supporting detail.

1. **Contain the screenshot.** Location: every shared copy. Expected: access/removal
   incident record. Failure: any uncontrolled copy. Rollback: none. Approval: incident
   owner. Do not delete the only request-identification key.
2. **Isolate a reproducible compatibility revision.** Location: a clean Git branch from
   the verified `main`/Render-live baseline. Apply only the cohesive dual-key slice
   listed above; run `npm ci`, focused tests and `npm test`. Expected: clean tree and all
   tests pass. Failure: unrelated/untracked changes, lock drift or test failure.
   Rollback: discard only the clean branch. Approval: required before Git operations;
   push/merge is separately prohibited because it triggers Render.
3. **Deploy compatibility code only.** Location: reviewed commit -> Render `menroBK-1`.
   Keep the original key and all GCS/migration gates absent. Expected: healthy deploy,
   one authorized old reveal works and a new synthetic record has `keyId=legacy-v1`.
   Failure: startup/Auth/reveal/write regression. Rollback: recorded live commit and
   unchanged environment. Approval: production deployment required.
4. **Attest Render and Vercel configuration.** Location: Render service Environment plus
   linked groups; Vercel Production Environment/Deployments. Expected:
   `BACKEND_URL=https://menrobk-1.onrender.com`, frontend origin
   `https://menro-xxtt-five.vercel.app`, API `https://menrobk-1.onrender.com/api`, exact
   project and known precedence; guest secret is present if guest invitations are used.
   Failure: missing/mismatched/preview value or unknown override. Rollback: inspection
   is read-only. Approval: required only for corrections.
5. **Rotate the request-identification key.** Location: Render plus the dedicated
   runbook/CLI. Configure active/new and previous/`legacy-v1`, verify old/new reads,
   prepare a Firestore restore point, dry-run every page, explicitly approve execution,
   resume and reconcile. Expected: zero conflict/unavailable/failure statuses. Failure:
   any unresolved record. Rollback: guarded rollback using the same migration ID while
   the old key remains. Approval: secret change, backup, migration and retirement.
6. **Rotate the Firebase Admin key separately.** Location: Google Cloud exact service
   account, then Render. Expected: healthy Auth/Firestore operation and Cloud audit
   evidence for the new non-secret key ID. Failure: wrong identity or runtime regression.
   Rollback: restore old Render secret before changing old-key state. Approval: create,
   deploy, disable and irreversible delete are separate checkpoints.
7. **Close PAP, UBLA and IAM evidence.** Location: effective Organization Policy,
   bucket Permissions/Monitoring and IAM Policy Analyzer. Expected: no public/token/ACL
   consumer and an approved bucket-scoped grant-before-revoke map. Failure: unknown
   consumer/beneficiary or missing IAM equivalent. Rollback: inspection is read-only;
   each later mutation needs its own rollback approval.
8. **Harden and activate Storage only after every blocker closes.** Location: exact
   bucket and Render, following the activation runbook. Expected: private workflows pass,
   no local/public paths, and ledgers reconcile once. Failure: any runbook stop condition.
   Rollback: pause submissions and use read-preserving rollback. Approval: PAP,
   UBLA/IAM, Render activation and synthetic writes separately.
9. **Retire local writes only in a later release.** Expected: observation evidence shows
   all new writes use GCS while historical reads/unavailable states remain safe. Failure:
   any local dependency or rollback need. Rollback: keep local support; never delete
   files/records. Approval: separate code/deployment change.

### Archived procedural detail — not an additional action list

1. **Contain the exposed material now, without changing production.** Restrict and
   remove the screenshot from shared locations under the organization's incident
   retention policy, audit who received it, and treat both full credentials as
   compromised. Do not paste either value into tickets, chat or logs. Do not delete
   the only request-identification key.
2. **Prepare request-identification dual-key support before rotating.** Authorize a
   focused code change and tests for active/previous keys plus key IDs, followed by a
   resumable, count-only, no-plaintext Firestore re-encryption procedure. Deploy old-key
   compatibility first, introduce the new active key in a later approved deployment,
   reconcile every record, perform one authorized reveal check, and retire the old key
   only after zero unresolved records. A direct environment-variable replacement is a
   stop condition.
3. **Complete Render key-source inspection.** Dashboard -> `menroBK-1` -> Environment:
   inspect service variables and every linked environment group. Confirm whether
   `BACKEND_URL` and `GUEST_INVITATION_SECRET` are supplied and which layer wins.
   `BACKEND_URL` must be `https://menrobk-1.onrender.com`; the guest secret must have at
   least 32 trimmed characters if guest invitations are enabled. Confirm hidden
   `FRONTEND_URL` exactly equals `https://menro-xxtt-five.vercel.app`. Record names,
   sources and boolean validation only.
4. **If variables are missing, make one separately approved completion deploy.** Keep
   `EVIDENCE_STORAGE_PROVIDER` absent/`local` and every GCS activation variable absent.
   Record the current successful deploy ID first. After deployment verify health,
   CORS/login, one non-private local upload-link workflow and guest invitation behavior
   if enabled. Roll back to the recorded deploy/environment snapshot on any regression.
5. **Rotate the Firebase Admin private key separately.** Create a new key on the exact
   expected service account; replace only the Render private-key secret and deploy.
   Verify health plus bounded Auth/Firestore behavior and matching Cloud audit key
   evidence. On failure, restore the old secret. On success, monitor, disable the old
   key, monitor again, then delete it. Never combine this with GCS activation.
6. **Finish the previously listed PAP, UBLA and least-privilege checks.** Close effective
   PAP policy/consumer uncertainty, legacy ACL dependencies and broad project-role
   dependencies before requesting bucket hardening or GCS activation.
7. **Request GCS activation only after B1, B4-B8, B10 and B11 are closed.** Apply the
   reviewed GCS activation delta in its own controlled deployment and follow the
   bounded smoke tests and rollback runbook. Until then the final status remains
   **BLOCKED — do not activate or deploy for Storage**.

### Archived storage-hardening detail

1. **Complete Render configuration and identity attestation without changing it.**
   Render Dashboard → `menroBK-1` → Environment: confirm whether `BACKEND_URL` and
   `GUEST_INVITATION_SECRET` key names exist, and confirm the six reported names are
   service-level or inherited as intended. Expected: exact HTTPS origins, exact project,
   valid secret presence and no emulator/development/migration/ADC selector. Then use an
   Because the Free plan has no Shell/SSH, attest the displayed client email against the
   exact allowlist and pair that check with a successful existing authenticated Admin
   Auth/Firestore operation; do not add diagnostic code or redeploy merely to mint a
   token. Blocker: missing operational key, mismatch, forbidden selector or inability
   to establish the usable credential pair. Share names and boolean results only; never
   values, tokens or keys.
2. **Attest the deployed Vercel target.** Vercel → MENRO frontend project → Settings →
   Environment Variables (Production) and Deployments: verify the production deployment
   commit and that `VITE_API_URL` is the exact stable Render HTTPS `/api` origin and
   Firebase project fields target `menrosystem-ddfac`. `VITE_FIREBASE_STORAGE_BUCKET`
   may be present but must not imply a direct Storage workflow. Blocker: wrong target,
   preview value in Production or deployed source mismatch. Share key names, sanitized
   origins/project ID and commit only; keep unrelated variables confidential.
3. **Close PAP policy/consumer uncertainty.** Google Cloud Console → IAM & Admin →
   Organization Policies → Public Access Prevention: view the effective project policy
   without enabling any API. Do not repeat the already completed public-principal
   screenshot check; instead, record the owner's declaration that no public or Firebase
   download-token workflow is required. Expected: no exception. Blocker:
   required anonymous/token-link workflow or policy state that cannot be established.
   Share policy state and principal categories only; not object names or URLs.
4. **Close UBLA ACL dependencies and excessive IAM.** Google Cloud Console → exact
   bucket → Permissions and Monitoring; IAM & Admin → IAM/Policy Analyzer: map the
   legacy owner/editor/viewer ACL beneficiaries and review every dependency of the
   Firebase Admin service account's Storage Admin/Token Creator roles. Expected: MENRO
   runtime access can be expressed through reviewed bucket-scoped IAM and no consumer
   requires ACLs; ACL metric remains zero over all available history. Blocker: unknown
   beneficiary, ACL-required event or missing IAM equivalent. Share role/principal type
   and aggregate metrics; keep credential/key details confidential.
5. **Approve operational policy and then request a separate controlled change.** Record
   owners for cost, seven-day soft delete, the historical-photo waiver, reconciliation,
   monitoring and rollback. Only after open blockers close should an operator request the exact reviewed PAP,
   IAM/UBLA and Render activation changes. Expected: written approval and one bounded
   synthetic application smoke test plan. Blocker: any unresolved gate. Do not share or
   enter activation secrets until that separate authorized window.

## 2026-10-23 read-only blocker-resolution evidence

The configured Google Cloud operator and project matched the authorized values.
The exact project is ACTIVE and billing is enabled with a linked billing account.
The exact production bucket exists and belongs to that project. Sanitized results:

| Live check | Actual result |
| --- | --- |
| Project / bucket | `menrosystem-ddfac` / `menrosystem-ddfac.firebasestorage.app`, exact match |
| Bucket location / class | `US-EAST1` / `REGIONAL` |
| Uniform bucket-level access | **DISABLED — blocker** |
| Public access prevention | `inherited`, not explicitly enforced — **blocker** |
| Bucket public IAM principals | None (`allUsers`/`allAuthenticatedUsers` count 0) |
| ACL model | Legacy project owner/editor/viewer bucket/default ACLs are active because UBLA is disabled |
| Retention policy / default hold | No retention policy; no default event-based hold reported |
| Soft delete | Enabled for 604800 seconds (7 days) |
| Object versioning | Disabled/no versioning configuration returned |
| Lifecycle / CORS | No lifecycle policy and no CORS configuration returned |
| Runtime service-account resource | Exact expected account exists; not reported disabled |
| Direct bucket role for runtime account | None |
| Inherited project roles | `firebase.sdkAdminServiceAgent`, `firebaseauth.admin`, `iam.serviceAccountTokenCreator`, `storage.admin` |
| Billing | Enabled and linked |
| Firebase Storage Rules | PASS: one active bucket release; `storage.rules` denies all reads and writes (`allow read, write: if false`) |

The project policy also contains one project Owner binding. No principal identity
other than the already documented runtime account/operator is reproduced here.
`storage.admin` provides functional Storage access but is materially broader than
the application requires; it is not least-privilege evidence. Bucket IAM absence
of public principals is positive but does not offset ACL mode, inherited permissions,
and unverified external consumers.

## 2026-10-23 PAP and UBLA compatibility check

This pass inspected both application repositories and re-read the exact bucket without
listing, reading, uploading or downloading any object. It also queried only aggregate
Cloud Monitoring and Cloud Audit Logs metadata from the bucket's creation time
(`2026-10-20T06:35:53Z`) through this review.

### Application dependency findings

- The frontend imports Firebase App/Auth only. It does not import `firebase/storage`,
  call `getStorage`, `uploadBytes`, `getDownloadURL`, or construct a Google/Firebase
  Storage URL. Evidence display uses `ProtectedEvidenceImage`, attaches the signed-in
  user's Firebase ID token to a MENRO backend `/api/evidence/...` request, converts the
  authorized response to a browser-local `blob:` URL, and revokes that URL afterward.
- Planting Reports and Guest Contributions upload multipart evidence to MENRO business
  endpoints. Early Monitoring, Official Monitoring, and evidence corrections use the
  same backend workflow. Corrections either upload a new immutable generation or retain
  an already authorized saved generation; they do not expose a cloud URL to the browser.
- The production upload adapter performs an authenticated server-side create with
  `ifGenerationMatch: 0`, stores `cacheControl: private, no-store`, and validates that
  neither `firebaseStorageDownloadTokens` nor an `allUsers`/`allAuthenticatedUsers` ACL
  exists. There is no `makePublic`, `publicRead`, predefined public ACL, signed-URL
  creation, or Firebase token-URL creation in an application code path.
- Retrieval first authorizes the authenticated MENRO role/owner against the exact saved
  planting report, contribution, monitoring observation, or correction revision. The
  backend then reads the pinned private object generation using its Google identity,
  validates metadata/size/hash, and streams the result through the protected endpoint.
  A failed cloud reference never falls back to a local file.
- Historical `photoPath`, `photoURL`/`photoUrl`, and `/uploads/...` values are normalized
  only as same-backend local evidence references. They are not treated as public GCS
  URLs. User profile `photoURL` values are a separate Firebase Auth/profile feature,
  not MENRO evidence in this bucket.

Signed URLs, Firebase download-token URLs, and public ACL/IAM access are different:
Cloud Storage signed URLs use the signing identity's scoped authorization and are not
blocked by PAP; Firebase download-token URLs are bearer links served by Firebase's
download endpoint; public ACL/IAM grants use `allUsers` or `allAuthenticatedUsers`.
MENRO evidence uses none of these three mechanisms. It uses an authenticated backend
principal. The intended MENRO architecture is therefore compatible with both PAP and
UBLA and needs no application code change.

### Live compatibility evidence and limits

| Read-only check | Result | Meaning |
| --- | --- | --- |
| Bucket IAM policy | No explicit bucket bindings and no public principal | No observed IAM-public dependency |
| Bucket/default ACL | Project owners/editors are `OWNER`; project viewers are `READER` | Legacy ACLs are active and UBLA would disable them |
| PAP metadata | `inherited` | Does not prove enforcement; the effective organization policy could not be read because the Organization Policy API is disabled |
| ACL-operation metric | Zero time series / zero points over the bucket's complete available lifetime | No recorded ACL-dependent operation, but absence of a series is not proof that every external consumer was inventoried |
| Visible bucket audit methods | Only `storage.buckets.create` | Data-access logging provides no evidence of another consumer; it also cannot prove none exists |
| Repository dependency scan | No public, tokenized, signed-URL, direct-browser, or ACL-management evidence workflow | MENRO code is compatible |

The bucket is only three days old. Read-only IAM, metric, log and repository evidence
cannot establish ownership of every external application or manually distributed URL.
No object metadata was inspected, as required, so this pass also cannot attest whether
an independently created object carries a Firebase download token or special object ACL.
An accountable project/bucket owner must confirm that these two repositories and the
identified runtime account are the complete consumer set. That attestation is the
remaining dependency blocker; an empty or quiet bucket is not being used as proof.

The project owner now declares that MENRO is the only application intentionally using
this Firebase project. This is useful ownership evidence and makes an intentional
third-party integration less likely, but it is not conclusive technical proof. The
declaration does not identify credentials already distributed outside MENRO, manually
shared Firebase download-token links, or an ACL-only consumer absent from available
logs. It therefore narrows, but does not close, the external-consumer blocker.

### Consumer inventory and deployment compatibility

| Consumer or path | Status | Authentication / dependency |
| --- | --- | --- |
| MENRO Render backend source | Confirmed intended consumer; production Storage gate not activated | Firebase Admin certificate credentials; IAM-based private create/get; no public URL or ACL operation |
| MENRO Vercel frontend source | Confirmed MENRO client | Firebase Auth ID token to MENRO API; no Firebase Storage SDK or direct Storage request |
| Active Render deployment | Service and deployment metadata verified; actual secret value/runtime principal not attested | Expected service account exists and is hard-allowlisted, but Render secrets were not read and production provider remains inactive |
| Active Vercel deployment | Source compatible; deployed environment/bundle not directly attested | `VITE_API_URL` determines backend origin; `VITE_FIREBASE_STORAGE_BUCKET` is passed to Firebase app initialization but no Storage client is created |
| Firebase Admin service account | Known potential Storage principal | Project-level `storage.admin` plus Token Creator; sufficient but excessive and not proof it is the identity executing on Render |
| Project owners/editors/viewers | Known potential ACL/IAM consumers | Legacy project-team ACL grants remain active until UBLA; actual Storage use was not observed |
| Phase 8H acceptance service account/object | Known non-production test consumer, different bucket | Acceptance result validates transport behavior only; it does not use this production bucket and the retained synthetic object must not be cleaned up |
| Unknown external application, manually shared URL, or stale credential | Not identified, not disproved | Owner says none is intentional; available metrics/logs and prohibited object inspection cannot conclusively exclude one |

Production credentials are explicit service-account certificate credentials from
`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`; the
production gate rejects `GOOGLE_APPLICATION_CREDENTIALS`, emulator selectors, and a
project/bucket/service-account mismatch. Consequently the designed Render production
path is not ADC-dependent. The development and Phase 8H harnesses use separate,
explicitly isolated authentication paths and do not establish the live Render identity.

Bucket selection is also fail-closed. Production requires the hardcoded exact project,
bucket, service-account email, approval marker and production gates. Outside integration
mode, an environment bucket other than `menrosystem-ddfac.firebasestorage.app` is
rejected; there is no URL-shaped or alternate production fallback. The default evidence
provider remains `local`, so source compatibility does not claim that GCS is active on
the currently deployed service.

Separate decisions:

- **PUBLIC ACCESS PREVENTION: NEEDS VERIFICATION.** PAP is compatible with the MENRO
  private evidence architecture, no current MENRO code depends on public IAM/ACL access,
  and signed URLs would remain supported even though MENRO does not use them. Do not
  enable it yet because the effective inherited policy and the absence of external
  public/Firebase-token consumers have not both been technically verified.
- **UNIFORM BUCKET-LEVEL ACCESS: NEEDS VERIFICATION.** MENRO's server-side IAM access is
  compatible and the full available ACL metric contains no recorded ACL operations.
  Do not enable it yet because active project-team ACLs exist and the active ACL
  beneficiaries have not been mapped to required IAM equivalents. UBLA disables all
  ACLs and becomes irreversible after 90 consecutive days.

Current change-window decisions are therefore:

| Setting | Source compatibility | Production change decision |
| --- | --- | --- |
| PAP enforced | PASS for MENRO source, Render design, Vercel design and historical local evidence | **NO-GO / NEEDS VERIFICATION** until effective inherited policy and non-MENRO public/token consumers are attested |
| UBLA enabled | PASS for MENRO source's IAM-only object path and historical local evidence | **NO-GO / NEEDS VERIFICATION** until every legacy ACL beneficiary is inventoried or replaced with IAM and the runtime identity is attested |

Historical local evidence is not stored in this bucket, so PAP/UBLA do not alter its
path resolution or recoverability. Its separate Render-ephemeral risk is accepted by
the explicit historical-photo waiver. Existing cloud references, if any,
are compatible only when their authorized backend principal retains IAM `get` access;
neither setting repairs missing historical bytes or authorizes migration.

Rollback considerations do not justify premature activation. Bucket-level PAP can be
returned to inherited behavior in a later separately approved change, but that does not
recover an undiscovered public-link workflow or override an effective ancestor policy.
UBLA may be disabled only before 90 consecutive days and restores saved ACLs only within
that window; after 90 days it is irreversible. Before either change, preserve sanitized
before-state metadata/IAM/ACL evidence and define explicit stop/rollback ownership. No
object, Firestore, Render, Vercel, Rules, IAM, ACL or bucket rollback action was executed.

No security-setting change is confirmed safe at the whole-bucket level yet, so this
report intentionally supplies no click sequence that ends with **Save/Enforce/Enable**.
The safe next Console actions are verification-only:

1. Google Cloud Console → project `menrosystem-ddfac` → Cloud Storage → Buckets →
   `menrosystem-ddfac.firebasestorage.app` → Permissions: export/review inherited IAM
   principals and obtain the bucket owner's signed consumer inventory.
2. In the same bucket, open Protection and note (without editing) PAP=`Inherited` and
   UBLA=`Off`; open Monitoring and confirm the ACL-operations metric for the entire
   period beginning `2026-10-20T06:35:53Z`, grouped by operation type.
3. IAM & Admin → Organization Policies → search **Public Access Prevention** and view
   the effective policy for this project. If the UI cannot show it, grant a reviewer
   the minimum organization-policy read access or enable the Organization Policy API
   only under separate approval; API enablement is a production mutation.
4. Confirm in writing that no other app, integration, manual sharing workflow, Firebase
   download-token link, public principal, or ACL-only principal uses this bucket. For
   each legitimate project-team consumer, prove the required bucket-scoped IAM binding
   before scheduling UBLA.

After those checks pass, a separately authorized change window may enable PAP first,
validate authenticated backend retrieval and anonymous denial, then enable UBLA and
repeat retrieval. Stop on any unknown consumer, nonzero ACL-required metric, missing
IAM equivalent, token-link dependency, or failed authenticated read.

The first Firebase Rules API request returned 403 because local ADC had no quota
project, not because the Rules permission was absent. The API is enabled. A corrected
read used the exact project only as an in-memory `x-goog-user-project` header; ADC was
not modified. It found one exact Storage release and retrieved its ruleset. The
operator currently has the necessary read permissions. For a future dedicated
read-only reviewer, grant `roles/firebaserules.viewer` (not Rules Admin); it contains
`firebaserules.releases.get/list` and `firebaserules.rulesets.get/list`.

Render MCP read-only inspection selected the sole available workspace and exact
active backend `menroBK-1` (`srv-dalaqc65vjqs73dr9fo0`): Node, Singapore, free plan,
one instance, `npm ci` / `npm start`, branch `main`, auto-deploy on commit. Its latest
deploy is live at commit `40e601df57226e5e913258e6fc3ecf3fb638d985` (2026-10-18).
Service details contain no disk attachment and disk-event history contains no disk
creation/update event. The application writes normal production uploads to repository-relative
`uploads/`; those bytes are therefore on the ephemeral service filesystem.

Render deploy metadata records at least 25 successful replacements between
2026-09-24 and 2026-10-18. Because `uploads/` is Git-ignored and no disk was attached,
the current instance cannot be a source for local bytes written before its latest
replacement. Bytes written after the 2026-10-18 live deploy might still be present,
but their existence cannot be established from non-content operational metadata.
Earlier evidence could still be recoverable only from an independent backup/source
device or another separately authorized system; none was discovered or verified here.

Current Render documentation was retrieved during the consolidated audit. It confirms
that a service without a persistent disk has an ephemeral filesystem and loses runtime
file changes on restart/redeploy, while only bytes under an attached disk's mount path
persist. The blocker also rests on the inspected service's actual absence of a disk;
no changing price or capacity assumption is needed. Source:
[Render persistent disks](https://render.com/docs/disks).

The available Render connector can update environment variables but cannot safely
read existing secret values. It was not used to mutate or reveal them. Consequently,
the deployed `FIREBASE_CLIENT_EMAIL` cannot be attested as the account selected by
the code solely from Render state; the cloud account's existence/roles and the code
allowlist are verified separately, not joined into a runtime attestation.

## Activation checkpoint

| Gate | Required target / current result |
| --- | --- |
| Project | Exact allowlist `menrosystem-ddfac`; code and live identity PASS |
| Bucket | Exact allowlist `menrosystem-ddfac.firebasestorage.app`; exists, exact project PASS |
| Runtime identity | Expected account exists and has sufficient but excessive project roles; actual Render secret/runtime identity NOT ATTESTED |
| Privacy/IAM | Rules deny all browser access and no public bucket IAM member exists, but UBLA is disabled, PAP is merely inherited, legacy ACLs are enabled and project-wide Storage Admin remains — BLOCKED |
| Existing evidence | Owner waived historical local-photo recovery/backup/migration; records and references remain untouched; missing images may render unavailable |
| Tests | Backend **613/613**; frontend **117/117**, build and targeted lint PASS; emulator results remain the previously recorded 61/62 with the known native precondition limitation |
| Billing/operations | Billing linked; location/class, retention, soft delete, versioning and lifecycle verified; budgets/alerts and cost owner NOT VERIFIED |
| Deployment | Prepared only; no live environment or deployment changes authorized |

The earlier real-GCS acceptance result applies only to
`menro-gcs-acceptance-20261021-6f8c2d91`. It proves the bounded GCS transport
contract, not the configuration, custody, contents or suitability of the production
Firebase bucket.

## Existing production architecture

- Firebase Admin is initialized once in `src/config/firebase.js` using the server-only
  `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` values.
  Auth, Firestore and the newly gated production Storage handle share that exact app.
- The browser authenticates with Firebase Auth and calls Express. It does not upload
  directly to Storage and contains no GCS bucket credential or service-account key.
- Existing routes reuse server-side RBAC, trusted record resolution and private
  `/api/evidence` delivery. No public object URL, signed URL or Firebase download
  token is introduced.
- Local evidence is written beneath the backend repository's `uploads/` directory.
  `MENRO_UPLOAD_ROOT` is intentionally ignored outside integration mode. Repository
  configuration declares no disk, and the live Render service has no attached disk.
  Existing deployed local bytes are therefore ephemeral and at risk on every restart
  or deploy. Attaching a future disk would not retroactively recover them.
- Firestore can contain legacy `photoPath`, `photoURL`/`photoUrl` references and
  additive version-1 `privateEvidence` references. Cloud references pin bucket,
  object name, uint64 generation string, content type, size, SHA-256, intent and
  upload time. The resolver dispatches by persisted reference and never falls back
  from a failed cloud reference to a same-named local file.

## Production code changes

`src/config/productionGcs.js` adds an independent production gate. It requires:

- `NODE_ENV=production`;
- the exact project, bucket and current Admin service-account email;
- existing Admin credential presence;
- no development, integration, emulator, migration or ADC selector;
- the exact activation marker; and
- either exact cloud-write mode or exact local-write/cloud-read rollback mode.

The existing storage configuration, Firebase Admin handle, immutable upload adapter,
private retrieval adapter, durable workflow ledger and quota ledger now accept the
production project only through that gate. Development and emulator rules remain
unchanged. Production objects use the fixed `menro-production/evidence/v1/...`
namespace; local, emulator, development and production names cannot cross-match.
All real-GCS submissions require an 8–128 character idempotency key.

The production readiness validator accepts only a non-secret projection and never
self-certifies cloud readiness. `.env.example` documents the disabled settings.
New tests cover wrong target/identity/approval/environment/provider/gates, namespace
separation, adapter compatibility and read-preserving rollback.

Files changed for this production task:

- `.env.example`
- `src/config/productionGcs.js`
- `src/config/evidenceStorage.js`
- `src/config/developmentGcs.js`
- `src/config/firebase.js`
- `src/services/evidenceWorkflow.service.js`
- `src/services/evidenceUploadQuota.service.js`
- `src/services/firebaseEvidenceStorage.service.js`
- `src/services/firebaseEvidenceRetrieval.service.js`
- `scripts/validateEvidenceProductionReadiness.js`
- `tests/productionGcs.test.js`
- `tests/evidenceProductionReadiness.test.js`
- `tests/storageInitialization.test.js`
- this report

All pre-existing dirty work in both repositories was preserved. No frontend source
change was required.

## Security review

The backend Admin SDK bypasses Firebase Storage Rules; production authorization is
therefore Express RBAC plus Google Cloud IAM. Storage Rules still matter to prevent
direct Firebase client access. The repository contains only the emulator's explicit
deny-all rule and no deployable production rules file. The active production release
was read through the Firebase Rules API and independently contains the same deny-all
policy. Admin/GCS IAM still bypasses these Rules as designed.

Firebase security-rules audit result:

```json
{
  "score": 5,
  "summary": "The single active production Storage release denies every client read and write. The application correctly keeps evidence behind authenticated server endpoints; Admin/GCS access is governed separately by IAM.",
  "findings": []
}
```

The current read-only project policy confirms that the Firebase Admin service
account still has project-wide Storage Admin and Token Creator roles. Before
activation, determine whether those roles are required. Prefer bucket-scoped create/get/metadata
permissions and no delete/list/update permission, but do not remove roles until
their dependencies are reviewed. Do not create a new JSON key. If a different
least-privilege runtime identity is selected, revise the code allowlist and repeat
offline tests before changing Render.

Safe least-privilege transition plan (preparation only):

1. Review Cloud Audit Logs and the Cloud Monitoring ACL-operations metric for the
   bucket. A zero `OBJECT_ACCESS_REQUIRED_OBJECT_ACL` count over the available history
   supports UBLA migration; any nonzero result requires an IAM equivalent or explicit
   deprecation decision. Do not list objects merely to perform this review.
2. Inventory every use of the runtime account's Storage Admin and Token Creator grants
   through IAM Policy Analyzer and audit logs. Keep its Firebase/Auth/Firestore roles
   out of the Storage-role change unless separately reviewed.
3. Define a custom role with only `storage.objects.create` and `storage.objects.get`
   for application traffic, plus `storage.buckets.get` only if the approved operational
   health check will inspect bucket metadata. Bind it on this bucket only.
4. Grant-before-revoke, then perform a separately authorized identity/permission
   attestation and one bounded synthetic application smoke test. Revoke project-wide
   Storage Admin/Token Creator only after every dependency is proven unnecessary.
5. Enable UBLA only after ACL-dependent access is migrated. Google documents that ACLs
   cease to grant access and the setting becomes irreversible after 90 consecutive
   days. Enforce bucket PAP independently so a later ancestor-policy change cannot
   silently remove protection.

Sources: [Firebase Rules Viewer permissions](https://docs.cloud.google.com/iam/docs/roles-permissions/firebaserules),
[UBLA migration and ACL-use metric](https://docs.cloud.google.com/storage/docs/uniform-bucket-level-access),
and [public access prevention inheritance](https://docs.cloud.google.com/storage/docs/public-access-prevention).

## Workflow compatibility

| Workflow | Offline result / preservation rule |
| --- | --- |
| Planting reports and AI/geotag checks | Compatible; validated image bytes and existing EXIF/GPS rules retained |
| Guest contributions | Compatible; stable contribution idempotency and allocation recovery retained |
| Early monitoring | Compatible; private evidence and scheduling rules retained |
| Official monitoring | Compatible; cohort calculations and review lifecycle retained |
| Corrections/resubmissions | Compatible; immutable revisions and retained-evidence verification retained |
| Staff/Admin review | Compatible; existing RBAC and Return for Rechecking / final decision rules unchanged |
| Private previews | Compatible through authenticated backend resolver; no public URL |
| Historical local evidence | Read-compatible while the byte exists; loss accepted by explicit owner waiver; records/statistics remain preserved |
| Failed upload recovery | Durable intent, lease, quota and reconciliation state retained |
| Rollback | Exact local-write/cloud-read mode implemented; cloud failures never become local success |

Frontend inspection confirmed bearer authentication, stable idempotency keys,
401 retry reuse, explicit pending handling, no false success on HTTP 202, private
preview handling, and no direct Firebase Storage SDK use. The Google Sign-In
single-flight implementation remains intact; no 15-second authentication timeout
was introduced.

## Historical evidence waiver and superseded preservation procedure

The owner now explicitly waives historical photo recovery, inventory, backup, restore
and migration as production-activation requirements. This closes the former blocker
by accepted business risk, not by technical recovery. It authorizes no deletion,
Firestore/reference mutation or migration. The procedure below is retained only as a
superseded recovery reference and is **not required or authorized** by this waiver.

Before the waiver, activation would have required all of the following:

1. A read-only production Firestore inventory covering planting roots/reports,
   guest contributions, early/official monitoring, every revision, and pending
   upload/reconciliation ledger entry.
2. A filesystem inventory from the currently deployed Render instance and proof of
   whether `/uploads` is on a persistent disk. Do not redeploy before this capture.
3. A versioned backup containing Firestore exports and every referenced local byte,
   with checksums, access restrictions and a named custodian.
4. A restore rehearsal into an isolated nonproduction environment, including private
   retrieval and record-to-byte reconciliation.
5. Resolution or quarantine of missing, unsafe, conflicting and orphaned references.

### Backup and restore procedure — prepared, not yet executed or verified

This procedure requires a separate authorization because it inventories and copies
private production evidence and writes backup artifacts:

1. Prevent deploys/restarts and enter an approved evidence-write maintenance window.
   Record the current live deploy ID. Do not attach a disk or redeploy first; either
   action can discard the current ephemeral bytes.
2. In the running `menroBK-1` instance, resolve the actual application working
   directory and `uploads/` realpath. If Render Shell/SSH is unavailable on the free
   plan, STOP and obtain a Render-supported recovery path; do not redeploy a helper.
3. Generate a no-follow manifest of regular files only: relative path, byte size and
   SHA-256. Reject symlinks, traversal, device files and paths outside the upload root.
   Do not print filenames or hashes into public logs.
4. Create an encrypted archive in an approved restricted destination and transfer it
   off the instance. Record archive hash, file count/bytes, encryption/custody owner,
   timestamp and deploy ID. Keep the original instance untouched.
5. Under separately approved Firestore export authority, export the exact production
   database to a restricted, versioned backup destination. Record the export ID and
   reconcile every supported evidence reference class against the file manifest;
   never fetch or rewrite evidence during classification.
6. Restore both backups into an isolated nonproduction project and filesystem. Run
   the existing historical scanner there, verify manifest/archive hashes and exercise
   authorized private retrieval for synthetic/reviewer-selected samples. Confirm
   root-only planting, guest, early/official monitoring and every revision class.
7. Retain a signed exception list for missing/orphaned/conflicting evidence. Activation
   would have remained blocked until every real reference was verified or explicitly quarantined
   by an authorized data owner.

This pass did not execute those steps. Backup remains not created/not restore-verified,
which is now an accepted historical-photo outcome rather than an activation blocker.

The existing scanner and migration tooling are non-destructive and emulator-only.
They do not authorize a production scan or migration. Historical migration remains
separate: never delete originals, replace entire documents, silently relink records,
or upload real evidence without a separately approved manifest and reconciliation
plan. Missing historical bytes produce existing unavailable/error UI states; the
planting/monitoring records, review history and statistics remain intact. Reviews that
require an old image need a documented administrative exception, never a fabricated or
silently relinked replacement.

## Verification results

- This blocker-resolution pass changed documentation only. It did not change code,
  so the previously completed suites were not needlessly repeated.
- Backend full offline regression after the later credential-remediation additions:
  **613/613 passed**, no skips. The earlier Storage-only checkpoint was 606/606.
- Frontend regression: **117/117 passed**, no skips.
- Frontend targeted ESLint (`src`, `tests`, Vite and ESLint configuration): PASS.
- Frontend production build: PASS; existing >500 kB chunk warning remains.
- Phase 8H real-service acceptance: historical PASS against the acceptance bucket;
  deliberately not rerun.
- Storage/Auth/Firestore emulator services were not running on 8080/9099/9199.
  They were not started because the repository Storage config alone does not define
  the shared Auth/Firestore state needed by the workflow suites. The latest recorded
  emulator aggregate remains 61 passed / 62 with one genuine known failure: the
  native Storage Emulator does not enforce `ifGenerationMatch=0`. No assertion was
  weakened or skipped.
- Repository-wide frontend lint still encounters an unrelated unreadable
  `.docx-work` temporary directory; application-scoped lint is clean.
- Backend `git diff --check` reports pre-existing trailing whitespace in
  `src/middleware/upload.middleware.js`; production-task files are clean.

## Exact deployment preparation — commands/settings only

Do not apply these until every blocker is closed and the user explicitly approves
the reviewed activation in a separate instruction.

Required existing Render secrets/configuration:

```text
NODE_ENV=production
FIREBASE_PROJECT_ID=menrosystem-ddfac
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@menrosystem-ddfac.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=<existing Render secret; never print or replace here>
FIREBASE_STORAGE_BUCKET=menrosystem-ddfac.firebasestorage.app
FRONTEND_URL=<exact stable HTTPS Vercel origin>
BACKEND_URL=<exact stable HTTPS Render origin>
```

Activation delta, to be applied atomically only after approval:

```text
MENRO_GCS_PRODUCTION=true
EVIDENCE_STORAGE_PROVIDER=gcs
EVIDENCE_CLOUD_WORKFLOW_ENABLED=true
EVIDENCE_CLOUD_READ_ENABLED=true
EVIDENCE_GCS_PRODUCTION_APPROVAL=AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION
```

Explicitly remove all emulator, development-GCS, migration and ADC selector variables.
Do not add Storage credentials to Vercel. No frontend deployment is required for the
provider switch if the currently tested frontend bundle is already deployed; only
the backend code/config requires deployment. If frontend source differs from the
tested artifact, deploy it first with normal production variables and verify login,
then deploy the backend with storage still local.

Deployment order after approval:

1. Record the signed historical-photo waiver and prohibit migration/deletion jobs.
2. Verify production project/bucket metadata, Rules, effective IAM, runtime identity,
   billing/policies and monitoring; save sanitized evidence.
3. Deploy backend code with provider still `local`; verify health, Auth/Firestore,
   local historical reads and no Storage calls.
4. Apply the activation delta and restart one backend instance.
5. Verify `/` health and normal authenticated reads before any evidence upload.
6. Run exactly one bounded synthetic user workflow with one fresh idempotency key
   and one generated PNG no larger than 100 KiB. Allow one create attempt and only
   same-key reconciliation if the response is ambiguous; never choose a new key or
   object name after uncertainty. Verify the linked Firestore reference, exact generation/hash,
   private authenticated preview and anonymous denial. Do not use real evidence.
7. Observe errors, latency, quota/reconciliation counters and GCS operations. Expand
   traffic only after the single result is reconciled.

No generic CLI command is supplied to upload directly: the smoke test must exercise
the authenticated application endpoint so RBAC, business linkage and idempotency are
tested together. Record the synthetic business record, intent, object generation,
hash and recovery owner. Cleanup requires separate approval and must never be a
wildcard deletion.

## Rollback and recovery

Read-preserving rollback environment delta:

```text
MENRO_GCS_PRODUCTION=true
FIREBASE_STORAGE_BUCKET=menrosystem-ddfac.firebasestorage.app
EVIDENCE_STORAGE_PROVIDER=local
EVIDENCE_CLOUD_WORKFLOW_ENABLED=false
EVIDENCE_CLOUD_READ_ENABLED=true
EVIDENCE_GCS_PRODUCTION_APPROVAL=AUTHORIZED_CONTROLLED_PRODUCTION_ACTIVATION
```

Restart the backend and verify: new submissions create only local references; existing
authorized cloud references still stream exact generation/hash; legacy local files
still resolve; no cloud failure falls back to local. Preserve all intents, quota rows,
workflow ledgers, revisions and objects. Reconcile ambiguous uploads before any later
write reactivation. Do not delete cloud bytes or reverse references automatically.
Because local writes are ephemeral on the Free service, pause new evidence submissions
during rollback and do not treat this mode as durable operation. The authoritative
procedure is `docs/firebase-storage-production-activation-runbook.md`.

If cloud reads themselves must be revoked, set provider `local`, set both cloud gates
false, set `MENRO_GCS_PRODUCTION=false`, and remove the activation marker. This makes
cloud evidence unavailable and is not a preservation-safe normal rollback.

Stop immediately on identity/project/bucket mismatch, public access, unknown IAM
principal, ambiguous upload, generation/hash
mismatch, linkage uncertainty, unexpected spend, or failed private authorization.

## Exact remaining actions

### Automatically completed versus approval-required

| Completed read-only in this pass | Still requires explicit operator approval/access |
| --- | --- |
| Exact project/bucket identity and metadata | Any PAP/UBLA/bucket/IAM mutation |
| Bucket and inherited project IAM policy read | ACL-use/audit-log dependency analysis if access is not already granted |
| Billing linkage read | Budget/alert or retention-policy changes |
| Active Firebase Storage Rules and ruleset read | Independent Console attestation only if required by policy |
| Render service, deploy and disk metadata | Render secret-name/runtime token attestation |
| Code/env/rollback/smoke-plan review and historical-photo waiver documentation | Any evidence inventory, recovery or migration (not required and not authorized) |
| Recoverability time-bound from deploy history | Deploy, restart, activation, object operation or cleanup |

1. Rules verification is complete. For an independent operator record, open Firebase
   Console → project `menrosystem-ddfac` → Storage → Rules and confirm the published
   source denies all paths. A CLI/API reviewer needs `roles/firebaserules.viewer` and
   a quota project (or in-memory `x-goog-user-project`); do not grant Rules Admin.
2. In Cloud Console → Storage → the exact bucket → Permissions/Protection, independently
   confirm the findings above. Plan separate changes to enable enforced PAP and UBLA.
   Before enabling UBLA, review and translate every required legacy ACL dependency;
   enabling it is consequential and time-sensitive, not an automatic cleanup step.
3. In IAM & Admin, review dependencies of the runtime account's project-wide
   Storage Admin and Token Creator roles. Prepare a bucket-scoped least-privilege
   replacement sufficient for bucket metadata plus immutable object create/get.
   Do not remove roles until Auth/Firestore/Firebase dependencies are proven safe.
4. In Render Dashboard → `menroBK-1` → Environment, verify key names and compare the
   service-account email to the exact allowlist without copying secret values. Confirm
   all production activation variables are currently absent/false. Record who controls
   the existing private key and rotation/revocation procedure; create no new key.
   The Free plan has no Shell/SSH. Do not add diagnostic code or redeploy solely for
   token introspection. Instead, compare the displayed email to the exact allowlist and
   confirm the same deployed credential pair successfully performs an existing
   authenticated Admin Auth/Firestore operation. Never print/save the key or token.
5. Record the historical-photo waiver with the deployment change record. Confirm no
   migration, deletion or Firestore-reference rewrite is scheduled.
6. Approve the observed US-EAST1 regional placement, seven-day soft delete, disabled
   versioning, no retention/lifecycle policy, cost owner, budgets/alerts, monitoring
   and reconciliation ownership—or approve separately reviewed policy changes.
7. After all evidence is recorded and blockers closed, review this checkpoint and
   explicitly authorize only the exact Render environment delta, backend deployment
   and the bounded staged synthetic production checks in the activation runbook.

## Final answers

1. **Is the existing production bucket ready?** No. Rules are verified deny-all and
   bucket IAM has no public principal, but actual metadata shows UBLA off, PAP not
   enforced and legacy ACLs enabled; the runtime account remains project-wide
   Storage Admin.
2. **Is historical evidence protected?** No. The active Render filesystem is ephemeral;
   the owner waived recovery/backup/migration and accepted unavailable old photos while
   preserving every database record and statistic.
3. **Are MENRO workflows compatible?** Yes in offline/emulator-tested architecture;
   production-provider configuration is now compatible and fail-closed. Real
   production workflow behavior is intentionally untested.
4. **What remains?** Deployment identity/configuration attestation, Vercel attestation,
   PAP/UBLA dependency closure, least-privilege review and explicit change approval.
5. **Can activation proceed safely now?** **No — BLOCKED.** Stop before changing
   Render/Vercel, IAM, Rules, objects or Firestore.
