# Phase 3C–4 source remediation and release preparation

Baseline backend: `1e62e40163eb1514725d3e8500423bc7b27c3917`.
Baseline frontend: `6123e55763100eaa9f29d3cefa49b0de0c4ed63e`.
This record authorizes no production operation.

## Executed local acceptance

| Check | Result |
| --- | --- |
| Frozen-source real Phase 3C browser suite | 5/5 PASS |
| Real Phase 3D/4 suite with evidence writes enabled | 3/3 PASS |
| Real communication/analytics/pagination with evidence writes disabled | 3/3 PASS |
| Mocked frontend aggregate including both cache regressions | 25/25 PASS |
| Backend credential-free regression/security checks, separate processes | 169/169 PASS |
| Frontend unit/safety/index checks | 65/65 PASS |
| Isolated per-tree emulator regression | 7/7 PASS |
| Isolated evidence-workflow emulator regression | 17/17 PASS |
| UUID cleanup idempotency and independent-resource sentinel test | 1/1 PASS |
| Scoped ESLint, Vite production build, 12 backend JavaScript syntax checks, both diff checks | PASS |
| Repository-wide frontend npm run lint | FAIL: unchanged baseline, 2 errors / 1 warning |

The baseline exception is VerifiedPlantingCohortsPage.jsx lines 48/52 (`react-hooks/set-state-in-effect`) and 57 (`react-hooks/exhaustive-deps`, missing selected). Current and base 97087c9 blob: `0af80901a3f9722055ce3f457de5a8e34e619e09`. No rule was suppressed and the page was not edited.

All emulator writes used only demo-menro-phase3c-isolated with Auth9299/Firestore8281/Storage9298/Hub4401, the exact isolated bucket, API5185 and frontend5186. New real suites used real AuthProvider, authenticatedApi and camera components. External browser origins fail tests. Cleanup ran twice, preserved independent Auth/Firestore/Storage sentinels and left zero Auth users, nonempty Firestore collections and Storage objects. Eight verified launcher descendants were stopped after PID creation-time/command/listener checks; dedicated ports were released. Shared emulator data and unknown processes were untouched.

Reviewed backend files: `src/config/cors.js`; `src/routes/permanentSampleAnalytics.routes.js`; `src/routes/sampleMonitoringInformation.routes.js`; `src/services/permanentSampleAnalytics.service.js`; `src/services/sampleMonitoringInformation.service.js`; `src/services/sampleMonitoringVisit.service.js`; `src/services/sampleMonitoringValidation.js`; `tests/helpers/queryMemory.js`; `tests/requesterCors.test.js`; `tests/sampleMonitoringQueries.test.js`; `tests/sampleMonitoringReadiness.test.js`; `tests/integration/phase3cBrowserServer.js`; this document. Dependency manifests, evidence identity/hash/replay implementations, legacy monitoring and official KPI code were not changed.

## Fixed and deferred findings

| Finding | Source outcome |
| --- | --- |
| Cross-visit evidence cache | URLs use visit/sample/revision/history identity. Pending files and retry keys also bind visit version/capture session. Context changes clear state, stale retrieval responses are ignored and owned object URLs are revoked. Historical and pending two-visit regressions pass. |
| Lifecycle inputs | Save/Submit and Approve require Boolean decisions and safe nonnegative integer versions. Return requires a nonblank bounded reason. |
| Baseline/site/plan binding | Save and review revalidate the cohort's authoritative site ID, plan version and baseline version inside the transaction. Prior references come from a matching approved earlier visit; nonempty forged/stale client assertions fail. Null/omitted assertions are replaced by server references. Evidence history remains server-owned. |
| Measurements | Null, missing and blank remain null; finite numbers and unambiguous decimal/exponent strings remain accepted. Booleans, objects, arrays, NaN, Infinity and invalid numeric strings are rejected. Approval also rejects invalid pending legacy measurements, while Return permits correction. Negative/zero bounds and required measurements remain MENRO decisions; no biological threshold is invented. |
| CORS | Requester information explicitly enables Idempotency-Key independently of evidence writes, while default header behavior, origins and backend authorization remain unchanged. Real tests verify communication with evidence writes disabled. |
| Index definitions | Six additive, query-derived definitions; existing notification definitions unchanged. No index was deployed. |
| Analytics | Authorized cursor-paged filter metadata is independent of the aggregate cap. The frontend sends selected filters before aggregation, retains filter choices when an aggregate is too broad and displays safe exclusion counts. A single selected population over 1000 visits still fails closed; it is never silently truncated. |
| GPS | The real capture component requests a new uncached position at frame capture and retains existing accuracy/session/site validation. A real Chromium test changes location after preview and verifies the new coordinates reach the backend. This is not hardware-attested or spoof-proof GPS. |
| Inbox/history | Optional paged responses expose older authorized requests with stable timestamp/document-ID cursors. Legacy callers still receive arrays. No history or durable workflow record was deleted or given a TTL. Document-growth/archival and retention decisions remain open below. |
| Operational security | IAM, bucket hardening, credential-remediation closure, live revisions and deployed rules remain unverified and require separately authorized work. |

## Query/index preparation

Frontend `firestore.indexes.json` adds only these ordered query shapes:

- Information inbox: recipientUserId ASC, createdAt DESC (document ID DESC tie-breaker).
- Visit information: visitId ASC, createdAt DESC (document ID DESC tie-breaker).
- Visit discovery: visitDate DESC, document ID ASC.
- Discovery plus status ASC.
- Discovery plus createdBy ASC.
- Discovery plus createdBy ASC and status ASC.

The three original notification indexes and empty fieldOverrides are unchanged. Static contract tests check the six signatures. Isolated real API tests execute owner/Admin unfiltered and status-filtered discovery, recipient/visit inbox queries and cursor boundaries. Firebase Emulators do not enforce production composite-index requirements: emulator PASS is not index build certification. An authorized index review/build/readiness check is still required before activation. Analytics equality filters and its document-ID catalogue ordering should also be checked against the actual managed Firestore query planner; do not deploy speculative indexes or replace the manifest wholesale.

`GET /api/permanent-sample-analytics/filters` returns only authorized approved-visit cohort/site pairs, with limit 1–50 and nextCursor. `GET /api/sample-monitoring-information?paged=true` returns `{requests,nextCursor}` with the same bounds; visitId and cursor retain caller scope. Omitting paged preserves the previous array contract. No new migration is needed for these additive APIs. Incomplete authoritative requester/baseline relationships still fail closed and must not be inferred or silently backfilled.

## Production operational checklist — NOT EXECUTED

1. Attest intended frontend/backend commit revisions, startup configuration and CORS origins without exposing secret values.
2. Verify published deny-all Firestore/Storage client rules. Admin SDK bypasses these rules; separately review runtime identity, least-privilege IAM, public-access prevention, uniform bucket access, legacy ACL/token consumers and credential-remediation closure.
3. Review/build the approved indexes through a separate authorized release. Verify every role/filter/cursor query before opening gates.
4. Keep all emulator/acceptance selectors absent in production. Firebase client VITE settings are public bundle configuration; server credentials must never appear there. Frontend VITE gates require a rebuild; backend gates are enforced independently.
5. Observe sanitized statuses, latency, 401/403/409/410/422/429 rates, missing-index failures, excluded cohort counts, stale bindings, orphan/uncertain upload intents, quota events and document-growth/write-limit failures. Do not log tokens, private paths, photo bytes or question/answer bodies.
6. Recheck participant monitoring and official KPI regressions. This change does not create visits, schedule them or project whole-site survival.

## Android/iPhone physical acceptance — PENDING

Use an approved nonproduction device environment reachable securely from devices. Do not loosen the loopback-only emulator safeguards or claim desktop Chromium is a physical-device test. Cover Android Chrome/installed PWA and iPhone Safari/installed PWA, recording exact device/OS/browser versions and sanitized outcomes.

- Camera denied, location denied, approximate location, permission recovery and rear/front camera selection.
- Fresh capture coordinates, movement after preview, accuracy over 50 m, location outside Bulan/site geometry and invalid/missing site geometry.
- Canvas JPEG without EXIF using the real browser-session contract; never fabricate EXIF or accept a gallery file as a verified session.
- Expired session, invalid/future/old timestamps, background/screen-lock interruptions, cancellation and camera-track release.
- Offline capture/verification/upload interruptions, stable exact retries and duplicate/replayed photos.
- Cross-visit same-tree history, Returned revision correction, authenticated photos and Approved read-only behavior.

## MENRO decisions — NOT APPROVED HERE

Sample selection/percentage/replacement; official visit creation, scheduling, intervals and reassignment; rechecking/search and not-located treatment; measurement requirements/bounds; use in official KPIs/reporting; Admin jurisdiction; requester visibility after ownership changes; retention, archival, deletion and access-audit policies all require confirmation. Existing provisional sampling helpers and official KPIs were not changed.

History-growth review: information threads currently append only question/answer actions, but visit draft histories and evidence histories can grow toward Firestore document limits. Monitor size and controlled failures. A future append-only history subcollection/read-pagination design and any parent-document compaction need migration, audit and retention approval. Do not delete hashes, completed operation identities, upload intents or evidence references by age; `retain-no-ttl-v1` remains unchanged.

Legacy stored zeros cannot safely be inferred to mean missing measurements. Forged or unverifiable persisted references must be repaired only through an authorized, verified correction/migration path before approval. No production inventory, automatic rebase, legacy inference or migration was performed.

## Read-preserving rollback and pilot design — UNIMPLEMENTED

The test-only evidence-read-only configuration proves communication remains usable with evidence writes off. It is not a complete application write pause and is not production storage acceptance.

A future server-enforced write-pause mode must reject new drafts/submissions/reviews, capture/upload and question/reply mutations as appropriate while preserving authorized discovery/detail, historical evidence and communication-history reads. Define behavior for already-completed idempotent retries and in-flight transactions, then test it before rollout. The current cohort gate and information gate also disable their reads; turning them off is not read-preserving rollback. Existing upload maintenance pauses only its guarded capture/upload paths.

The existing production GCS configuration has an exact read-preserving provider rollback contract, but it needs separately authorized identity/configuration checks and compatible readers. Never downgrade to a binary unable to read immutable evidence/bindings, delete ledgers or enable local writes accidentally. Preserve legacy private local references and storage durability until retirement is separately approved.

Current feature gates are global. A limited production pilot needs an explicit server-side authorized user/cohort allowlist and tested read/write behavior; this allowlist is not implemented by these changes. Sequence: resolve operational/policy prerequisites → deploy inert compatible readers and indexes → verify private nonproduction/device behavior → separately approve pilot controls and activation → expand only on verified evidence. No rollout was performed.
