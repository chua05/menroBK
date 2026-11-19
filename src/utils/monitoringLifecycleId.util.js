// Deterministic Monitoring Lifecycle document ID (no Firebase import), shared by monitoring.service and the
// read-only preflights. Changing this formula would break idempotent registration of existing lifecycles.
const crypto = require("node:crypto");

function lifecycleId(participantId, plantingReportId, eventId, siteId) {
  return `MON-${crypto.createHash("sha256").update([participantId, plantingReportId, eventId, siteId].join("|")).digest("hex").slice(0, 20)}`;
}

module.exports = { lifecycleId };
