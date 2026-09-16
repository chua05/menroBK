# MENRO backend inspection and verification

## Inspection result

| Area | Classification | Evidence and change |
| --- | --- | --- |
| Events | Already correct; small fix | `events` is the sole calendar collection, `Tree Planting` and `Other MENRO Activity` are valid, generated events use `recordStatus: scheduled`, and list retrieval returns all documents including same-date events. Retrieval now always exposes the Firestore document ID. |
| Request approval | Needs fix | Approval used a Firestore transaction and event link already. A repeated approval with an existing `eventId` now returns the persisted request. |
| Inventory roles and fields | Already correct | Staff writes; staff/admin read; participant sees only available choices. `sourceNursery` validates the two finalized choices. `batchReference` and `description` persist. Old storage location is not required or written. |
| Inventory archive/restore | Incomplete | Archive is a soft delete. Its reserved-stock check now happens inside a transaction. Added a staff-only restore and an archive list for staff/admin. |
| Notifications | Missing | Added Firestore `notifications`, recipient-owned retrieval and read update, plus transactional decision and release notifications. Deterministic document IDs prevent duplicate notifications for the same transition. |
| Analytics | Missing | Added a staff/admin dashboard derived from six existing Firestore collections. Verified planting uses approved planting reports; survival uses latest reviewed monitoring per report. Empty monitoring yields `null` survival rate. |
| Request release | Needs fix | Release had an undefined quantity variable and used requested rather than approved items. Both are corrected. Release retries return the existing record. |

## Changed files

| File | Reason and minimum change | Preserved |
| --- | --- | --- |
| `src/app.js` | Register notification and analytics routes. | Existing route order and middleware. |
| `src/services/event.service.js` | Include Firestore document ID in retrieval. | Event creation, types, same-date behavior, archive and status workflows. |
| `src/services/seedlingRequest.service.js` | Approval/release retry handling, transactional notifications, correct approved quantities and release calculation. | Request lifecycle, approval allocation, event creation and distribution transaction. |
| `src/services/inventory.service.js` | Transactional archive and restore, archived listing. | Quantity formula, stock transactions and active inventory filtering. |
| `src/controller/inventory.controller.js` | Expose archived list and restore. | Existing validation and responses. |
| `src/routes/inventory.routes.js` | Wire new read/restore endpoints with existing roles. | All prior inventory authorization. |
| `src/services/notification.service.js` | New persisted notification operations. | No previous notification module existed. |
| `src/controller/notification.controller.js` | New response handlers and ownership errors. | Existing response utility. |
| `src/routes/notification.routes.js` | New authenticated notification routes. | Existing Firebase auth middleware. |
| `src/services/analytics.service.js` | New Firestore dashboard calculations. | Existing schemas and monitoring semantics. |
| `src/controller/analytics.controller.js` | New response handler. | Existing response utility. |
| `src/routes/analytics.routes.js` | New admin/staff dashboard route. | Existing role middleware. |

Inspected without changes: authentication, role and response middleware, distribution service, planting report and monitoring services, package scripts, and Firebase configuration. No production records were changed by this code task.

## Frontend contract

All requests use `Authorization: Bearer <Firebase ID token>`. Responses use `{ success, message?, data? }`.

| Method and path | Authorization | `data` |
| --- | --- | --- |
| `GET /api/events` | Authenticated | Array of actual active event documents; fields include `id`, `name`, `type`, `date`, `startTime`, `endTime`, `barangay`, `plantingSiteId`, `location`, coordinates, `sourceRequestId`, `status`, `recordStatus`, timestamps. |
| `GET /api/events/:id` | Authenticated | One event document. |
| `GET /api/inventory` | Admin/staff | Active seedling array. |
| `GET /api/inventory/archived` | Admin/staff | Archived seedling array. |
| `GET /api/inventory/available` | Participant | Available seedling choices with limited fields. |
| `GET /api/inventory/:id` | Admin/staff | One active seedling. |
| `POST /api/inventory` | Staff | Created seedling. |
| `PATCH /api/inventory/:id` | Staff | Updated seedling. |
| `PATCH /api/inventory/:id/stock` | Staff | Updated seedling. |
| `DELETE /api/inventory/:id` | Staff | Archive result. |
| `PATCH /api/inventory/:id/restore` | Staff | Restored seedling. |
| `GET /api/notifications` | Authenticated | `{ notifications: [...], unreadCount }`; each notification has `id`, `recipientUserId`, `title`, `message`, `type`, `relatedRecordType`, `relatedRecordId`, `isRead`, `createdAt`, `readAt`. |
| `PATCH /api/notifications/:id/read` | Owner | Updated notification. |
| `GET /api/analytics/dashboard` | Admin/staff | `{ inventory, requests, distributions, events, planting, monitoring, barangayVerifiedPlantings, trends }`. |

Request transitions remain `PATCH /api/seedling-requests/:id/approve`, `/reject`, and `/release` with existing admin/admin/staff permissions respectively.

## Integration test matrix

Run against a Firestore emulator or test project with separate staff, admin and participant Firebase ID tokens. Use a disposable request, linked site and inventory records. Check the named collections directly after each transition.

| Case | Action | Expected |
| --- | --- | --- |
| Events | GET events after persisting two distinct events with the same `date` | Both IDs appear. Generated request event has `recordStatus: scheduled`; no distribution or monitoring event is created. |
| Approval retry | Approve a reviewed request twice | One linked event, one approval notification, one inventory reservation. |
| Inventory access | GET inventory as staff and admin; POST/PATCH/stock/DELETE/restore as admin | Reads succeed; every admin mutation returns 403. Staff mutations succeed. |
| Nursery fields | POST one record per finalized `sourceNursery` value, without storage location, with `batchReference` and `description`; POST unsupported source | Both valid records persist those fields; unsupported source returns 400. |
| Archive/restore | Archive unreserved seedling, list archives, restore it | It disappears from active list, appears in archive list, then returns to active list. |
| Notification ownership | GET notifications as each participant; mark another user's ID read | Only own notifications appear; cross-user mark returns 404. Own mark persists `isRead` and `readAt`. |
| Decisions | Reject a reviewed request; release an approved request | One correct participant notification for each committed transition; retries add none. Release uses `approvedItems`. |
| Empty analytics | GET dashboard with empty test collections | Zero counts, empty groupings, `survivalRate: null`, no sample records. |
| Analytics stages | Add requests, distributions, approved and unapproved reports, and reviewed monitoring rounds | Released differs from planted; only approved reports add verified planting; only latest reviewed monitoring per report adds condition/survival counts. |
| Trends | Add timestamped records in two months with a gap | Only real timestamped records count; no synthetic month data. |

## Compatibility and infrastructure

- Existing inventory documents with an obsolete storage location remain readable. No migration is required.
- Historical event documents with old statuses remain untouched; they may need manual review if the UI cannot display them.
- Notifications start with future transitions. Historical notifications cannot be safely fabricated.
- No scheduled job framework exists. A release-date reminder requires a durable external scheduler and deployment configuration. Current release notifications occur at the actual `Released` transition.
- No FCM or email transport is configured in this backend.
- `npm run dev` was attempted but nodemon failed to spawn in the sandbox (`EPERM`). `npm start` initialized Firebase, loaded all routes, and reported port 5000. No `test` or `lint` script exists. All `src/**/*.js` files passed `node --check`; `git diff --check` passed.
