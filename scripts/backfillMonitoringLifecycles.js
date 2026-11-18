// Controlled, idempotent backfill: registers a Survival Monitoring lifecycle (with a MON-YYYY-NNN number)
// for Admin-verified Planting Reports that were verified before automatic registration existed.
//
// Safety:
// - DRY RUN by default: lists what would be registered and writes nothing.
// - Writing requires BOTH --apply and --confirm-project=<projectId> matching the connected project.
// - Each report is registered in its own transaction through the same idempotent registration used at
//   verification: re-running never duplicates a lifecycle or a number, and existing numbers are kept.
// - No observation, visit, evidence, approval, schedule or monitoring policy is created or changed.
//
// Usage (only after separate approval for any non-emulator project):
//   node scripts/backfillMonitoringLifecycles.js                       # dry run
//   node scripts/backfillMonitoringLifecycles.js --apply --confirm-project=<projectId>
const { db } = require("../src/config/firebase");
const registration = require("../src/services/monitoringLifecycleRegistration.service");
const { lifecycleId } = require("../src/services/monitoring.service");

async function planBackfill() {
  const [reports, lifecycles] = await Promise.all([db.collection("plantingReports").get(), db.collection("monitoringRecords").get()]);
  const numbered = new Map(lifecycles.docs.map((doc) => [doc.id, doc.data() || {}]));
  return reports.docs.filter((doc) => registration.eligible(doc.data())).map((doc) => {
    const report = doc.data();
    const id = lifecycleId(report.participantId || "", doc.id, report.eventId || "", report.siteId || "");
    const existing = numbered.get(id);
    return { reportId: doc.id, reportNumber: report.reportNumber || null, monitoringMethod: registration.monitoringMethodOf(report),
      lifecycleId: id, action: existing?.monitoringNumber ? "KEEP" : existing ? "ASSIGN_NUMBER" : "REGISTER", monitoringNumber: existing?.monitoringNumber || null };
  });
}

async function runBackfill({ apply = false, confirmProject = "" } = {}) {
  const plan = await planBackfill();
  if (!apply) return { mode: "dry-run", projectId: db.projectId, plan };
  if (!confirmProject || confirmProject !== db.projectId) throw new Error(`Refusing to write: --confirm-project must equal the connected project (${db.projectId}).`);
  const results = [];
  for (const row of plan) {
    if (row.action === "KEEP") { results.push({ reportId: row.reportId, status: "NO_CHANGE", monitoringNumber: row.monitoringNumber }); continue; }
    results.push(await registration.registerMonitoringLifecycle({ reportId: row.reportId }));
  }
  return { mode: "apply", projectId: db.projectId, results };
}

module.exports = { planBackfill, runBackfill };

if (require.main === module) {
  const apply = process.argv.includes("--apply");
  const confirmProject = (process.argv.find((arg) => arg.startsWith("--confirm-project=")) || "").split("=")[1] || "";
  runBackfill({ apply, confirmProject })
    .then((result) => { console.log(JSON.stringify(result, null, 2)); process.exit(0); })
    .catch((error) => { console.error(error.message); process.exit(1); });
}
