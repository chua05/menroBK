# Phase 7C — historical recovery and reconciliation preparation

21 October 2026. Source inspection and runbook only. No Render connection,
production Firestore query, real image copy, backup, restore or migration performed.

## Confirmed upload-root behavior

`src/config/integrationEnvironment.js:44` resolves normal root as CWD/uploads.
MENRO_UPLOAD_ROOT is honored ONLY in guarded integration mode beneath system temp.
`src/config/uploadRoot.js` exports that root. `fileStorage.service.js` stores
planting reports/guest contributions in planting-reports; monitoring.service.js
stores early/official/replacement evidence in monitoring. Evidence access uses the
same root with realpath containment. URLs are references, not filesystem selectors.
Legacy root photoPath/photoURL and photos[] aliases remain; monitoring history and
every revisionHistory evidenceRef matter. Retrieval temp staging is NOT a backup.

Current production recommendation, subject to actual inspection: leave provider
local and cloud/migration gates absent. Mount a persistent disk at the EXACT
runtime CWD/uploads path (for native Node this may be
/opt/render/project/src/uploads, but VERIFY pwd first). Setting MENRO_UPLOAD_ROOT
to /var/data currently does nothing in production. A future separately reviewed
production override would need explicit absolute-root validation, symlink/permissions
checks, writer/reader consistency, unchanged /uploads references, restore/cutover
tests and no silent fallback. It is NOT implemented or enabled in this phase.
Do not attach a disk over existing bytes before making/verifying a backup: mounting
can obscure existing files. No disk attachment is authorized by this runbook.

Public [Render disk documentation](https://render.com/docs/disks), read 21 October,
states only mount-contained files persist, disks are runtime-only/single-instance
and prevent zero-downtime deployment. Markdown retrieval failed; HTML succeeded.
This guidance informs the runbook; MENRO disk existence, actual path and durability
remain NOT VERIFIED. Do not infer historical loss from repository absence.

## Future authorized Render read-only inspection checklist — NOT EXECUTED

1. Record service ID, deployed commit, native/Docker runtime, start/build commands,
   instance count and disk attachment/mount/size from approved operator views.
   Never print full environment or credentials. Do not restart/redeploy to inspect.
2. In the running service shell only: `pwd`, `realpath ./uploads`,
   `findmnt -T ./uploads`, `stat -c '%a %U %G' ./uploads`, `df -h ./uploads`.
   Confirm resolved writer/reader roots and mount ancestry, including any symlinks.
   Do not use build/predeploy/one-off jobs to inspect a runtime-only disk.
3. Use bounded aggregate counts/bytes under planting-reports and monitoring;
   keep names/UID directory segments and hashes in restricted operator manifests,
   not console transcripts. Do not recursively dump files, EXIF or private paths.
4. Record current access permissions, snapshot timestamps/retention, encrypted
   off-host backup destination/access policy, retention and last restore acceptance.
   Snapshots alone do not prove database/file consistency. A full snapshot restore
   replaces later disk changes; no restore is authorized during inspection.
5. Check deployment/restart history against known evidence writes and backup epochs
   WITHOUT intentionally restarting. Verify future persistence in isolated staging.
   Report unavailable permissions or history as UNKNOWN, never zero/lost.

## Future production reconciliation — design, NOT a runnable production scanner

Obtain separate read-only export authorization and a coordinated immutable snapshot
of all relevant raw documents plus byte-preserving source files at one documented
epoch. Include archived/rejected records and unknown legacy fields, not HTTP presenters.
Quiesce evidence mutations or use a documented consistent snapshot/catch-up protocol.
Never obtain service accounts or production records through the emulator tools.

Phase 6B accepts synthetic memory/demo source only; Phase 6C accepts namespaced demo
documents and synthetic temp roots only. Do NOT remove those guards or relabel real
data synthetic. A production offline-export adapter, provenance/access controls and
reviewed manifest privacy policy require a separately authorized implementation.

Map canonical reports, contributions, parent derived edges, early and official
observations and ALL reused/replacement revisions. Keep raw actual document IDs,
immutable observation IDs, revision/evidenceRevision, photo ordinals, actor/site/
event/cohort bindings and current/historical references. Parent aggregates and
root aliases are edges, not extra source uploads. Do not invent legacy metadata.

Required redacted reconciliation outputs, by workflow and total:

| Metric | Meaning |
| --- | --- |
| business records / all documents examined | Separate business from relationship/hash registries |
| evidence references | Include aliases, parent diagnostics, all observation/revision edges |
| unique source paths / content hashes | Do not count repeated revision reuse twice |
| missing source / unmatched-orphan | Orphan only with COMPLETE authoritative graph+file inventory |
| duplicate-content groups | Diagnostic, not permission to merge ownership or delete |
| invalid metadata / cloud candidates | Schema alone does not prove integrity/privacy |
| unresolved owner / revision | Keep reviewable; no invented reporter/ID |
| eligible unioned bytes | Only fully verified candidates; no alias multiplication |

Retain completeness/budget/cursor/source-digest facts. REQUIRES_REVIEW/BLOCKED always
overrides convenience eligibility. Partial scans cannot prove absence or orphanhood.
The local Phase 6A 237 paths/1,606,567 bytes/13 contents/6 duplicate groups is historical
LOCAL observation only, not a current production inventory or migration authorization.

## Backup and restore acceptance — future separate authorization

1. Approve custody, encryption (managed keys or separately protected operator key),
   least-privilege access, retention/legal holds and restore RPO/RTO. No retention
   policy is invented here. Keep keys separate from backups and never in Git/logs.
2. Capture immutable source-file backup plus restricted SHA-256 manifest of every
   original file, size, format, source epoch and canonical reference edges. Reject
   traversal/symlinks; preserve original bytes, EXIF, times and all old revisions.
3. Capture compatible Firestore reference/relationship/ledger snapshot and digest.
   Include intents, quota reservations/counters/audits, operations, migration receipts
   and generation strings. Database-only or Git-only copies are insufficient.
4. Validate backup transfer bytes/hashes, encryption/access and inventory completeness.
   Keep raw metadata restricted; publish aggregate counters/opaque IDs only.
5. Restore into a new isolated access-controlled root/database, NEVER over live
   evidence. Validate every manifest checksum and record/revision edge, authorized
   retrieval/denial, business/schedule/analytics invariants. An emulator copy of real
   data needs its own privacy authorization; synthetic approval does not cover it.
6. Record actual pass/fail evidence and custody signatures. Until a restore has
   passed, backup/restore status is NOT TESTED, not VERIFIED.
7. For partial migration/deployment rollback retain both original local bytes and
   cloud objects/receipts. Reconcile per operation, never replace whole historical
   documents from a stale backup. Preserve intervening reviews and corrections.

## Recovery decision table — existing Phase 6C source reviewed

| Failure | Safe action / limitation |
| --- | --- |
| Interrupted upload / lost response | Retain stable intent and quota; same operation checks actual bytes/generation; no fresh UUID |
| Storage success, linkage failure | Object remains charged; fenced transaction rechecks fresh source/relationships before same-op linkage |
| Link success, response interruption | Re-read atomic LINKED receipt and verify; do not repeat business mutation |
| Generation/hash mismatch | Quarantine RECONCILIATION_REQUIRED; never use latest generation or local fallback |
| Missing original | Stop verification/linking; seek a separately verified backup; metadata cannot recreate bytes |
| Missing cloud object | Keep reference/charge and uncertainty; no automatic delete, release or recreation |
| Stale document / revision conflict | Preserve newer fields/history; inspect exact selectors and ownership; no stale array overwrite |
| Duplicate worker / expired lease | Existing token fence/in-progress response; old owner cannot finalize |
| Attempts exhausted / old-day unused intent | Manual audited reconciliation; no automatic quota release or identity recycling |

Current emulator migration identity is fixed/separate: shared 50 files/200 MiB per
Manila admission day across runs. No participant/guest impersonation. This is NOT
an approved production migration budget. Ledgers have no TTL/automatic cleanup.
Strict verification can flag a legitimate subsequent source/review change; do not
restore old business metadata merely to make verification pass. Emulator Storage
objects disappear at stop without export; retained demo receipts may correctly fail
later checks. Originals are never removed. Automatic rollback/deletion is absent.

## Remaining production unknowns

Historical source availability, backup completeness, restore acceptance, actual
Render mount/persistence and all production references remain unverified. Current
cloud read rollback is blocked; see Phase 8A. These procedures do not authorize
production inspection, downloads, exports, migrations, deletion or deployment.
