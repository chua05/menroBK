const { activationState } = require("../utils/earlyMonitoring.util");
const { processEarlyMonitoringNotifications } = require("../services/earlyMonitoringNotification.service");

async function main() {
  if (!activationState().enabled) {
    console.log("Early Monitoring worker is disabled because EARLY_MONITORING_ACTIVATION_AT is not configured.");
    return;
  }
  const results = await processEarlyMonitoringNotifications();
  const { failures, budgetExhausted, nextCursor } = results.summary;
  console.log(`Early Monitoring notification evaluation completed for ${results.length} bounded report(s); ${failures.length} failed.`);
  if (budgetExhausted) console.log(`Processing budget reached; the next run will continue after ${nextCursor}.`);
  if (failures.length) throw new Error(`${failures.length} Early Monitoring record(s) failed.`);
}

if (require.main === module) main().catch((error) => {
  console.error("Early Monitoring notification worker failed:", error.message);
  process.exitCode = 1;
});

module.exports = { main };
