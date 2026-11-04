# Phase 3C backend local acceptance — 2026-11-04

Backend baseline: `62ed4822049a663425e2c6a7231875d425491229`.

Final executed checks:

- Credential-free lifecycle, discovery/detail HTTP, RBAC, capture, revision, replay, idempotency, quota, storage and retrieval regressions: **124/124 PASS** (including **8/8** shared/isolated topology validators).
- Original-topology per-tree evidence emulator suite: **7/7 PASS**, with fixture cleanup verified.
- Original-topology evidence-workflow emulator suite: **17/17 PASS**, followed by verified removal of 1,547 records created by that process and 19 owned objects.
- Modified JavaScript syntax checks, `git diff --check` and unchanged dependency manifests: **PASS**.
- Corresponding frontend real-browser aggregate: **5/5 PASS**; mocked aggregate: **23/23 PASS**; relevant frontend unit regressions: **54/54 PASS**.

Controller audit fixes prevent JSON body overrides of authenticated actor/route identity and remove private evidence transport metadata from visit JSON while preserving revision/history indexes for protected retrieval. Staff ownership and Admin role authorization remain enforced. Evidence identity, leases, SHA uniqueness, capture consumption, version/revision checks and lifecycle rules remain intact.

Real browser acceptance used the independent demo project `demo-menro-phase3c-isolated` with exact Auth/Firestore/Storage/Hub ports `9299/8281/9298/4401` and bucket `demo-menro-phase3c-isolated.firebasestorage.app`. Original backend emulator regressions ran in separate processes under their approved `demo-menro-phase2` topology `9099/8181/9199`. Regression counter documents use UUID scope; cleanup observes successful SDK creations and does not delete pre-existing records or reset collections/buckets.

The isolated browser fixture cleanup verifies authoritative UUID ownership, private object metadata and absence after deletion; explicit Playwright teardown runs it twice. Interrupted prior browser fixtures were removed only after independent ownership checks. Final isolated Auth, Firestore, Storage and quota artifact counts were all zero. The verified isolated process tree was stopped and its ports released; shared emulator listener PIDs remained unchanged.

The frontend scoped ESLint and Vite build pass. Repository-wide frontend lint has an explicitly documented baseline exception: two `react-hooks/set-state-in-effect` errors (lines 48/52) and one `react-hooks/exhaustive-deps` warning (line 57) in `VerifiedPlantingCohortsPage.jsx`, byte-identical to base `97087c9` (blob `0af80901a3f9722055ce3f457de5a8e34e619e09`). It was not changed or suppressed, and repository lint is not reported as passing.

This is local development acceptance with that unchanged frontend lint exception. Physical-device camera/GPS/EXIF testing, MENRO scheduling/visit-creation policy and production rollout approval remain separate. No production access, credentials, gate activation, dependency changes, push or deployment occurred.
