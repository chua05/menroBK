# Combined request and planting workflow contract

## Authority and accounting

Staff selects an existing Released request with matching event and distribution. Server-side records supply requester, sector, released species/quantities and authenticated Staff identity. Client identity and release-quantity overrides are rejected. Each submission uses an event reporting version and a stable client submission UUID; a completed identical retry returns the original result.

Available per species is released minus recorded planted, outstanding reservations and declared leftovers. A new planted plus leftover declaration cannot exceed that balance. Partial reports are allowed. Leftovers are never planted, surviving, returned to inventory or silently available for another planting report. Rejection releases only the rejected submission's accounting; its original record remains, and correction creates a separate revision. Release-based confirmation is restricted to individual requests and derives planted quantity on the server after excluding leftovers. It remains distinct from a field observation.

Admin verifies new official Staff submissions. Only confirmed planted quantities enter newly created cohorts. Existing cohorts, permanent sample IDs, historical measurements, official analytics rules and monitoring intervals are unchanged. Existing early-monitoring timing is reused for new records only, as explicitly approved by the user. There is no visit creation or scheduling UI.

## Proposed sites and conditional validation

Request-time proposed-site area may be omitted (null). Other / Exact Area requires a finite positive decimal; predefined choices ignore stale exact-area input. Staff supplies verified area and capacity during site review; Admin registers/approves the site using that verified data. New blank-area requests cannot acquire invented area/capacity defaults. Existing legacy reviewed requests retain their compatibility path.

Barangays are selected from the pinned municipality/province dataset, with existing Bulan labels retained. The dataset license is in ph-address-data-licence.txt. Known PCN, PhilHealth PIN and TIN formats receive structural checks only; these checks do not establish document authenticity. Other supported ID families remain subject to manual review. Existing encryption/masking remains in place.

The five-working-day processing message is advisory, not an approval deadline. It excludes weekends and the versioned published holiday list. Unpublished future/local holidays are not guessed; calendar coverage must be maintained. No official monitoring schedule or sampling policy is changed.

## Private attendance

Optional attendance accepts validated JPEG/PNG/PDF only (10 MB maximum), using existing private Storage/quota patterns. Authenticated original Staff owns uploads; owner Staff and Admin can retrieve. Participant, other Staff and unauthenticated access are denied. Storage generation, SHA-256, operation binding and byte length are checked. No public download URL or Firebase download token is issued. Original and corrected submission attachments remain separate immutable records.

The UUID fixture cleanup is emulator-only, ownership checked and explicitly callable twice. Production orphan retention/reconciliation and attendance retention require an operational policy before activation; this change introduces no background cleanup job or global deletion.

## Planting report corrections

Participant documentation retains its existing form, photo verification, site map and Staff-review lifecycle. A selected species may include nonnegative integer leftovers. Planted plus leftovers are transactionally bounded by the authoritative remaining release; neither declaration becomes an accepted planting total before MENRO review. Leftovers never increase planted cohorts or inventory. Zero/omitted leftovers preserve existing request fingerprints and historical records.

Participant attendance is also optional: `PUT /planting-reports/submissions/:id/attendance` accepts one `attendance` multipart file under the same safe JPEG/PNG/PDF, 10 MB, generation and quota rules. Only the authenticated original Participant may upload before review; that Participant and authorized MENRO Staff/Admin may retrieve through the corresponding authenticated GET. A different Participant receives no attachment. Exact completed retries cannot replace the immutable original file. A saved planting report retries only its attachment, never its quantities.

MENRO Field Reports now require **server-verified private planting photos before Admin approval**, as explicitly confirmed by MENRO's user in this task. Staff uploads to `PUT /planting-reports/official/:id/photos` using `photos`, `evidenceManifest`, `expectedRevision` and a stable `Idempotency-Key`. The server resolves the authenticated Staff owner, canonical operation, released distribution, event, site and assessment revision. It reuses original EXIF or the actual planting-report camera session, enforces existing municipality/site/timestamp checks, consumes sessions atomically and reserves real image hashes. Evidence is immutable and corrections create new submission/revision records. Only the original Staff and Admin retrieve official Staff photos. No public Storage URL or client-controlled private path is accepted.

Individual release-based confirmation remains explicitly **not** photo/GPS verified; its existing server-derived planted calculation and Admin approval remain unchanged. Incomplete field-report uploads remain pending and can resume evidence upload without submitting quantities again. Private evidence is not fabricated to complete a report.

## Release limits

Local acceptance does not authorize production activation. MENRO must still approve sample selection, official visit creation/scheduling, intervals, retention and use of sample analytics in official reports. Physical Android/iOS camera, GPS and EXIF acceptance remains separate. The locked dependency install reported seven moderate npm advisories; no dependency version or manifest was changed to address them.
