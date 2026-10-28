# MENRO Request-Letter Reconciliation Runbook

This runbook covers private request-letter upload intents. It is an operator procedure, not an automated cleanup policy. Never delete Storage objects or Firestore records under this procedure.

## Scope and access

- Use an authorized MENRO technical operator with read-only Firestore and Storage metadata access for routine review.
- Do not download document bytes during routine reconciliation.
- Record the operator, timestamp, intent ID, request ID, observed state, metadata comparison, decision, approval reference, and outcome in the restricted operational audit log.
- Escalate any suspected tampering, public access, hash mismatch, generation mismatch, or cross-request linkage immediately. Do not relink it.

## Review schedule

- Review `RECONCILIATION_REQUIRED` intents each business day.
- Review stale `UPLOADING` and `UPLOADED` intents each business day while the feature is active.
- Review aggregate counts and Storage/API error rates weekly.
- Suggested owner: designated MENRO system administrator. A separate approving officer must authorize any production mutation.

The owner, approving officer, staleness thresholds, escalation contacts, and response SLA require formal MENRO approval before activation.

## Read-only comparison

For each intent, compare only the following trusted fields:

1. Firestore intent: status, request ID, participant ID, object name, expected SHA-256, expected size, expected MIME type, expected generation, created/updated timestamps.
2. Firestore Seedling Request: owner, active private-document descriptor, immutable history descriptors, request version and revision history.
3. Storage metadata for the exact object and generation: object existence, generation, size, content type, cache control, custom SHA-256, absence of Firebase download tokens, and absence of public ACLs.

Never accept an object discovered by listing or filename similarity. The exact intent-bound object path and generation must match.

## State handling

### `UPLOADING`

- Recent: leave unchanged; an upload may still be in progress.
- Stale with no object: classify as interrupted before persistence. Retain the intent for audit and allow the client to retry with the same submission key.
- Stale with an exact matching object: classify as uncertain completion and escalate for approved reconciliation.
- Object metadata mismatch: security/integrity incident; do not link or retry with a different object.

### `UPLOADED`

- Exact object metadata matches, but no Seedling Request descriptor links it: candidate orphan or lost-response state. Confirm request ownership, request lifecycle, idempotency key, and that no different document is already active.
- Exact request already links the same object/generation: candidate status-only repair.
- Any mismatch, competing active document, wrong owner, or changed request lifecycle: manual investigation; no relink.

### `LINKED`

- Request active descriptor or immutable history must reference the same object and generation.
- Exact match: healthy; no action.
- Missing request linkage or mismatch: integrity incident. Do not automatically rewrite either side.
- Missing Storage object: availability/data-integrity incident requiring escalation and recovery review.

### `RECONCILIATION_REQUIRED`

- Re-run the read-only three-way comparison.
- Exact intent, request, and Storage match: candidate status-only repair after approval.
- Exact intent and Storage match with no request linkage: candidate relink only when ownership, request ID, request version, idempotency key, and absence of a competing document are independently confirmed.
- Any content, generation, ownership, path, privacy, or lifecycle discrepancy: keep quarantined for manual investigation.

## Mutations requiring explicit approval

Every production write requires a ticket/change record and separate approval:

- Relinking a verified object to a request.
- Repairing an intent status.
- Adding a missing immutable-history descriptor.
- Restoring metadata after a confirmed partial transaction.
- Any credential, IAM, bucket, or feature-gate change.

Deletion, object replacement, metadata rewriting, history removal, bulk repair, and automatic cleanup are outside this runbook and prohibited until MENRO approves a retention/destruction policy and a separate change plan.

## Relink approval criteria

Relinking is eligible only if all are true:

- Exact request and participant IDs match the intent.
- Exact object name and immutable generation match.
- SHA-256, size, MIME type, and private metadata match.
- No download token or public ACL exists.
- The request has no competing active private document for that revision.
- The upload intent/idempotency key belongs to the same request operation.
- Request revision history supports the intended linkage.
- Two-person review approves the mutation.

Otherwise, retain all records and escalate.

## Rollback and evidence preservation

- Disabling new uploads must leave cloud reads enabled.
- Existing descriptors and version history remain unchanged.
- Do not move objects to local or public storage.
- Do not delete orphaned or superseded documents automatically.
- After any approved repair, repeat the read-only comparison and attach the sanitized result to the audit record.

## Monitoring recommendations

These thresholds and ownership assignments are proposals until MENRO approves them.

- Track upload attempts, successes, validation rejections, interrupted uploads, idempotent retries, object conflicts, and each intent state by age.
- Track HTTP 400, 401, 403, 409, 413, and 503 responses separately; alert on a sustained increase rather than treating expected validation failures as outages.
- Track parser duration, process memory, upload size, Storage latency, Firestore transaction retries, and download authorization failures without logging document bytes, tokens, object names, or private metadata.
- Alert immediately on hash or generation mismatch, cross-owner linkage, public access, a Firebase download token, or a linked object becoming unavailable.
- Suggested initial review: operational dashboard each business day and aggregate trend review weekly. MENRO must approve thresholds, paging hours, and the responsible operator before activation.

## Incident response

1. Disable new upload enforcement first if legacy submissions must remain available; disable upload capability only after the frontend gate is disabled. Keep authorized reads available.
2. Preserve the request, intent, immutable descriptor history, object generation, and sanitized logs. Do not delete, overwrite, relabel, or download document contents during initial triage.
3. For integrity or privacy indicators, restrict the case to the approved security/privacy and Firebase administrators and open an incident record.
4. Compare the exact three-way metadata set described above. Never substitute a nearby object or infer identity from a filename.
5. Any relink or status repair requires the two-person approval and audit procedure in this runbook.
6. After recovery, verify authorization, private object metadata, request history, and reconciliation state, then document root cause and preventive action.
