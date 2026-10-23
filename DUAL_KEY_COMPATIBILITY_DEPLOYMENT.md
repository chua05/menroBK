# Dual-key compatibility deployment candidate

Baseline: Render-live and remote `main` commit
`40e601df57226e5e913258e6fc3ecf3fb638d985`.

This candidate changes only request-identification encryption compatibility. It does
not include migration tooling, Firebase Storage code, monitoring, notifications,
geography or other unfinished workflows.

## Deployment

1. Review the candidate diff and test results. Record the currently live Render deploy
   ID and environment key names without revealing values.
2. Keep `REQUEST_IDENTIFICATION_ENCRYPTION_KEY` unchanged. Do not configure active or
   previous rotation variables yet.
3. Keep every Firebase Storage/GCS activation variable absent and the evidence provider
   local.
4. After separate approval, commit this exact candidate, merge/push through the normal
   reviewed path, and allow Render's `main` auto-deploy to create one new deploy.
5. Verify startup health, login/session verification and one existing authorized
   identification reveal. Submit one synthetic request and verify only the non-secret
   stored metadata `keyId=legacy-v1`; do not log or export its plaintext.

Stop on startup failure, Auth/Firestore regression, reveal failure, unknown key ID,
plaintext/key logging or any Storage-provider change.

## Rollback

Redeploy commit `40e601df57226e5e913258e6fc3ecf3fb638d985` with the environment unchanged. Records
written by the compatibility candidate use the same original key and remain decryptable
by the baseline code because the baseline ignores the additive `keyId` field and uses
the same AES-256-GCM envelope. Do not delete or rewrite identification records.

Migration is deliberately absent from this candidate, so no migration can run during
build, startup or deployment.

## Verification result

- `npm ci`: completed from the unchanged production-baseline lockfile.
- Focused compatibility tests: 5/5 passed.
- Existing seedling/request-identification tests: 17/17 passed.
- Corrected connected-workflow fixture file: 24/24 passed. The two affected approval
  fixtures now derive deterministic +7/+8 day Manila calendar dates; the application
  date-validation implementation is unchanged.
- Full `npm test`: 198/198 passed, with no skips or cancellations.
