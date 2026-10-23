# Request-identification encryption-key rotation runbook

Status: implementation ready for local review; no production change or migration has
been performed.

## Configuration contract

Legacy deployments continue to use `REQUEST_IDENTIFICATION_ENCRYPTION_KEY`. It must be
canonical Base64 encoding of exactly 32 bytes. New records written in this compatibility
mode receive the non-secret key ID `legacy-v1`; historical records without a `keyId`
continue to decrypt with this key.

Rotation adds these variables:

```text
REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE=<new 32-byte Base64 secret>
REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE_ID=<unique non-secret ID, 1-64 characters>
REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS=<old 32-byte Base64 secret>
REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS_ID=legacy-v1
```

Key IDs must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Active or previous key/value
pairs are rejected when incomplete. Duplicate IDs identifying different keys are
rejected. New encryption always uses the active key. Keyed records decrypt only with
the exact matching key ID; the service does not guess keys. Unkeyed records use the
legacy key, or the previous key when its ID is `legacy-v1`.

## Operator sequence

0. Isolate the change first. The current backend working tree contains unrelated and
   untracked work and is not deployable as-is. On a clean branch from the verified
   production/main baseline, apply only the dual-key service, inert migration service
   and CLI, focused tests, package-script line and credential documentation. Do not
   carry unrelated dependency, Storage, map, monitoring or notification changes into
   the compatibility commit. Run `npm ci`, focused tests and the full backend suite.
1. Review and test the exact isolated code revision. Record the current successful Render deploy
   and preserve the existing secret in the approved secret manager. Do not print it.
2. Deploy the compatibility code with the existing legacy variable unchanged and no
   migration gates. Verify startup, one new synthetic request, and one authorized reveal
   of a pre-existing record. Confirm the new synthetic record has `keyId=legacy-v1`
   through protected server-side metadata inspection; do not inspect its plaintext.
3. Generate a new independent 32-byte key through the approved secret process. Add the
   active/previous pairs above in one separately approved Render change. The old key is
   the previous `legacy-v1` key. The original legacy variable may remain during the
   migration window. Do not change Firebase Storage variables.
4. Deploy and verify health. Create one synthetic identification and confirm its
   non-secret key ID equals the new active ID. Verify one authorized old-record reveal
   and one new-record reveal. Stop and restore the prior environment/deploy if either
   fails.
5. Choose one immutable migration ID, such as `request-id-rotation-2026-01`. Temporarily
   set the two migration gates only for the controlled operator session:

   ```text
   REQUEST_IDENTIFICATION_MIGRATION_ENABLED=true
   REQUEST_IDENTIFICATION_MIGRATION_APPROVAL=AUTHORIZED_REQUEST_IDENTIFICATION_KEY_MIGRATION
   ```

6. Run bounded dry-run pages. The command emits aggregate status counts and a resume
   cursor only:

   ```text
   npm run migration:request-identification-keys -- --mode dry-run --migration-id request-id-rotation-2026-01 --limit 50
   ```

   Repeat with `--cursor <previous-nextCursor>` until `complete=true`. Expected statuses
   are `NEEDS_MIGRATION` and possibly `ACTIVE`. Stop for any unavailable-key, invalid
   format or generic failure status.
7. Before execute mode, record an explicit migration approval and verify the owner-confirmed
   deployed recursive Firestore deny rule remains active for all clients, including
   both `requestIdentifications` and `requestIdentificationKeyMigrations`; Admin SDK
   access is the only permitted path. With a reviewed Firestore backup/restore point
   and maintenance owner present, repeat
   the same pages using `--mode execute`. Each record and its private migration ledger
   are updated atomically. Repeating a page is safe: completed records report
   `ALREADY_MIGRATED`. Never change the migration ID mid-run.
8. Run every page with `--mode reconcile`. Completion requires all records to report
   `VERIFIED` or an explicitly reviewed `ACTIVE_WITHOUT_LEDGER` for records originally
   written by the active key. Any `NEEDS_MIGRATION`, `CONFLICT`, missing-key or failure
   count is a stop condition.
9. If rollback is required before retiring the old key, use the same pagination and
   migration ID with `--mode rollback`. Rollback succeeds only when the current encrypted
   envelope still matches the ledger digest. It restores encrypted old envelopes, never
   plaintext. Reconcile and investigate every conflict. Rollback requires the old key
   and the additional temporary gate
   `REQUEST_IDENTIFICATION_MIGRATION_ROLLBACK_APPROVAL=AUTHORIZED_REQUEST_IDENTIFICATION_KEY_ROLLBACK`.
10. After successful reconciliation and an authorized sample reveal, remove the two
    migration gates and deploy. After the retention/monitoring window, remove the
    previous and legacy key variables, deploy, rerun bounded reconciliation, and only
    then destroy the exposed old key under the incident process.

## Safety properties and stop conditions

- No command lists or logs plaintext ID numbers or encryption keys.
- Page size is limited to 1-100 and every page is resumable by cursor.
- The ledger stores the old encrypted envelope and cryptographic digests for guarded
  rollback. It is sensitive even though it contains no plaintext. Access to both
  collections must remain server-only.
- A Firestore transaction couples each record update with its ledger update. Failed
  commits leave both unchanged; retries are idempotent.
- Stop immediately on configuration errors, missing keys, digest conflicts, unexpected
  counts, authorization failures, service-health regressions or any suspected log leak.
- Never retire the old key while any unkeyed/old-key record or unresolved ledger entry
  remains.

