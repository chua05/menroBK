const { processEventCalendarNotifications } = require("../services/eventNotification.service");

processEventCalendarNotifications()
  .then((results) => {
    const { failures, budgetExhausted, nextCursor } = results.summary;
    console.log(`Event Calendar notification evaluation completed for ${results.length} bounded event(s); ${failures.length} failed.`);
    if (budgetExhausted) console.log(`Processing budget reached; the next run will continue after ${nextCursor}.`);
    if (failures.length) throw new Error(`${failures.length} Event Calendar record(s) failed.`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Event Calendar notification worker failed:", error.message);
    process.exit(1);
  });
