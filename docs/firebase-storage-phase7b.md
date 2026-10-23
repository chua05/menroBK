# Phase 7B — nonproduction GCS acceptance preparation

**Current preparation update:** [Phase 8D-8E](firebase-storage-phase8d-8e.md) adds
explicit-file keyless ADC impersonation, effective-token verification and security
checks. Its commands supersede the historical authentication instructions below.
[Phase 8C](firebase-storage-phase8c.md) pins the
user-approved dedicated acceptance tuple in the standalone harness. The empty
allowlist and separate-project instructions below are historical, not current
execution instructions. Live execution is still NOT authorized. Use Phase 8C's
same-project marker, permission/authentication blockers and readiness checklist.

21 October 2026. Preparation only; **NO real cloud calls or resource changes**.
Production and real-service acceptance remain BLOCKED. Historical phase reports
describe their own scope; current Phase 6C/7A closure supersedes earlier blockers.

Phase 9A proposes a dedicated test bucket INSIDE the production-sensitive project,
superseding only the separate-project planning preference below. See
[Phase 9A](firebase-storage-phase9a.md). No bucket/identity is execution-approved;
the CLI allowlist is still empty and production evidence buckets remain forbidden.

## Implementation and trust boundary

Standalone `scripts/acceptNonproductionEvidenceStorage.js` imports only built-ins
and `nonproductionStorageAcceptance.service.js`. No dotenv, Firebase app, ADC,
startup registration, application endpoint or scheduler. No-argument invocation
prints a non-executing preparation report. No credentials are read in preparation.

The committed `APPROVED_TARGETS` allowlist is EMPTY: the user has not approved an
exact nonproduction project/bucket/service-account tuple. This is a deliberate
execution blocker, not a guessed cloud target. A separately authorized reviewed
change must pin that exact tuple before any live invocation can work. The CLI
cannot supply/override an allowlist. Dependency injection is for trusted offline
unit tests, not a sandbox against malicious JavaScript running inside the process.

All checks precede lazy Storage SDK loading: exact allowlist tuple, nonproduction
environment marker, NODE_ENV=test, explicit execution flag AND independent
authorization marker, production/demo project/bucket denial, absence of emulator
hosts/ambient credential/config variables, project aliases consistent, valid
synthetic UUID prefix, explicit matching service-account credential JSON. No ADC
fallback or custom endpoint. Credential endpoint is restricted to Google's token
endpoint; only the validated identity fields reach the SDK. Credentials must stay
outside Git, protected by operator ACLs; never paste them into reports or shell args.

The harness uses a fixed tiny synthetic PNG, private/no-store metadata, SHA-256,
nonresumable CRC32C save and `preconditionOpts: {ifGenerationMatch: 0}`. It requires
bucket uniform access and enforced public access prevention before writing. It
checks actual metadata/size/type/no download tokens, reads the exact generation,
checks full bytes, attempts a DIFFERENT-byte create at the SAME name, requires 412,
then verifies unchanged generation/hash. Uint64 generations remain strings; no
File({generation}) numeric conversion. Anonymous HTTPS has no auth/cookies/redirects;
only 401/403 passes (404 is ambiguous and fails). It never lists or deletes objects.
No SDK automatic retries; uncertain writes require a separate same-prefix rerun.
Same-prefix retry may recover only the identical context/image metadata and bytes.
An existing conflicting object fails; no new suffix hides a collision. The report
keeps realServiceVerified=false: operator provenance/IAM attestation is separate.

## Future authorized Windows execution — NOT RUN

1. Obtain approval for dedicated nonproduction project, bucket, test identity,
   cost allowance, synthetic prefix, retention and later cleanup. Do not use
   menrosystem-ddfac or its production bucket/identity. Pin the reviewed tuple in
   the empty code allowlist; rerun negative guards. No target approved today.
2. An authorized cloud operator independently verifies project/bucket ownership,
   uniform access, enforced public access prevention and IAM (including inherited
   project/org bindings and allUsers/allAuthenticatedUsers). The harness does not
   certify inherited IAM, account membership or unrelated objects.
3. Use a fresh private shell with no inherited application config, DEBUG, ADC,
   Firebase credential variables or emulator hosts. Set only:

   ```powershell
   $env:NODE_ENV='test'
   $env:MENRO_GCS_ACCEPTANCE_ENV='nonproduction'
   $env:MENRO_GCS_ACCEPTANCE_EXECUTE='AUTHORIZED_NONPRODUCTION_SYNTHETIC_ONLY'
   node scripts/acceptNonproductionEvidenceStorage.js
   # After separate approval and allowlist review ONLY:
   node scripts/acceptNonproductionEvidenceStorage.js --config C:/private/acceptance.json --execute-authorized --credentials C:/private/nonproduction-identity.json
   ```

   Config contains ONLY projectId, bucket, serviceAccountEmail, prefix. Prefix is
   `menro-acceptance/<fresh lowercase UUID>/`. Neither config nor credentials has
   a default. Protect config as operational metadata, credentials as secrets.
4. Capture sanitized result and private custody manifest of the chosen tuple,
   prefix, SDK/Node versions, actual generation/hash and authorization reference.
   On timeout/interruption retain prefix and credentials securely, inspect then
   rerun SAME config. Do not blindly use a new prefix or automatically delete.
5. Execute application-level nonproduction Auth/record-access tests in a later
   approved integration: this harness is a Storage contract probe, NOT production
   MENRO auth/workflow activation. Preserve emulator assertion failure separately.
6. Cleanup is NOT implemented. A separately authorized operator must prove exact
   synthetic object ownership, no business/ledger/revision references, and exact
   current generation before conditional deletion. No wildcard/prefix deletes.

## Least privilege acceptance procedure

Custom bucket-scoped identity: `storage.objects.create`, `storage.objects.get`
(metadata + private media), plus `storage.buckets.get` for privacy config inspection.
No delete, overwrite, list, IAM mutation, Storage Admin/Owner, signing or public URL
permission. Separate read-only auditor may need `storage.buckets.getIamPolicy` and
appropriate project IAM visibility; do not broaden the upload identity for convenience.
Inspect inherited bindings as well as bucket settings. Actual identity denial and
revocation tests require an approved second identity and real-service execution.
Admin SDK bypasses Firebase client Storage Rules; deny-all rules do not replace
server authorization or least-privilege IAM. No IAM or rules were changed here.

Sources consulted 21 October 2026: [GCS preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
and [IAM permissions](https://docs.cloud.google.com/storage/docs/access-control/iam-permissions).
Generation-match zero rejects an existing live object with 412; object create/get
permissions cover the narrow probe operations. Real GCS enforcement remains NOT TESTED.

## Verification

New fake-transport tests cover create-only forwarding/success/rejection, max uint64,
same-prefix retry, interrupted upload response, checksum mismatch, public/ambiguous
anonymous responses, unsafe privacy metadata, missing credentials/flags, invalid
prefix, project/bucket/identity mismatch, ambient ADC/emulator rejection and no
automatic deletion. Existing SDK loopback test checks actual multipart query/412.
These are MOCK/LOCAL TRANSPORT results, never proof of GCS behavior or production IAM.
Exact final counts and commands are consolidated in Phase 8A.

Native emulator ifGenerationMatch=0 failure remains unchanged and visible. Neither
that test nor this harness is a workaround for required real-service acceptance.
