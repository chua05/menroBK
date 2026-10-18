const {
  processOfficialMonitoringNotifications,
} = require("../services/officialMonitoringNotification.service");

async function main() {
  const results = await processOfficialMonitoringNotifications();
  const { failures, budgetExhausted, nextCursor } = results.summary;
  console.log(`Official Monitoring notification evaluation completed for ${results.length} bounded planting report(s); ${failures.length} failed.`);
  if (budgetExhausted) console.log(`Processing budget reached; the next run will continue after ${nextCursor}.`);
  if (failures.length) throw new Error(`${failures.length} Official Monitoring record(s) failed.`);
}

if (require.main === module) main().catch((error) => {
  console.error("Official Monitoring notification worker failed:", error.message);
  process.exitCode = 1;
});

module.exports = { main };
