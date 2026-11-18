// Target-scoped READ-ONLY preflight for RPT-2026-020 and RPT-2026-024.
// No apply path is exposed. Use only an existing authorized operational context.
// node scripts/backfillMonitoringLifecycles.js --expected-project=menrosystem-ddfac
const { PRODUCTION_PROJECT, createMonitoringLifecycleBackfill } = require("../src/services/monitoringLifecycleBackfill.service");

async function runBackfill(options = {}) {
  if (options.apply !== undefined && options.apply !== false || options.confirmProject !== undefined) throw new Error("This preflight is read-only; apply and write confirmation options are not supported.");
  if (!options.expectedProject) throw new Error("An explicit expectedProject is required before Firebase initialization or reads.");
  if (options.expectedProject === PRODUCTION_PROJECT && (process.env.NODE_ENV !== "production" || process.env.FIREBASE_PROJECT_ID !== PRODUCTION_PROJECT ||
      ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "MENRO_UNIT_TEST_FIREBASE"].some(key => process.env[key] !== undefined))) {
    throw new Error("The production preflight requires verified production mode and the explicit matching project before Firebase initialization.");
  }
  if (options.expectedProject !== PRODUCTION_PROJECT) {
    const integration = require("../src/config/integrationEnvironment").validateIntegrationEnvironment();
    if (!integration.integration || !(integration.phase3cIsolated || integration.legacyMonitoringIsolated) || integration.projectId !== options.expectedProject) {
      throw new Error("Custom preflight projects require the verified isolated test environment before Firebase initialization.");
    }
  }
  const { db, app } = require("../src/config/firebase");
  return createMonitoringLifecycleBackfill({ db, app,
    registration: require("../src/services/monitoringLifecycleRegistration.service"),
    lifecycleId: require("../src/services/monitoring.service").lifecycleId,
  }).plan(options);
}
async function planBackfill(options) { return (await runBackfill(options)).plan; }
function parseArguments(args) {
  if (args.length !== 1 || args[0] !== `--expected-project=${PRODUCTION_PROJECT}`) {
    throw new Error(`Read-only production preflight requires exactly --expected-project=${PRODUCTION_PROJECT}; global, target override and write options are rejected.`);
  }
  return { expectedProject: PRODUCTION_PROJECT, expectedDatabaseId: "(default)" };
}
module.exports = { planBackfill, runBackfill, parseArguments };
if (require.main === module) {
  Promise.resolve().then(() => runBackfill(parseArguments(process.argv.slice(2))))
    .then(result => { console.log(JSON.stringify(result, null, 2)); process.exit(0); })
    .catch(error => { console.error(error.message); process.exit(1); });
}
