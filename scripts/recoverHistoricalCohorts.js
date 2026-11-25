// Historical permanent-sample cohort recovery (see docs/permanent-sample-activation.md).
//
// DRY RUN (default; one read-only Firestore transaction, prints decisions and a digest):
//   Demo emulators (validated MENRO integration environment):
//     node scripts/recoverHistoricalCohorts.js --reports=<id>[,<id>...]
//   Google Cloud Shell (operator's own ADC, no key file; src/config/firebase.js is never loaded):
//     NODE_ENV=production FIREBASE_PROJECT_ID=menrosystem-ddfac node scripts/recoverHistoricalCohorts.js \
//       --reports=<id>[,<id>...] --expected-project=menrosystem-ddfac --expected-principal=<you@example.com>
// EXECUTE: accepted only inside the validated demo emulator environment in test mode. There is no override;
// a production execution needs a separate approved plan.
//     node scripts/recoverHistoricalCohorts.js --reports=<same list> --execute --confirm-digest=<digest from the dry run>
const { validateIntegrationEnvironment } = require("../src/config/integrationEnvironment");
const { RecoveryStop, assertReportIds, executeRecovery, planRecovery } = require("../src/services/historicalCohortRecovery.service");
const { sanitizeError } = require("../src/services/monitoringLifecycleTargetedRegistration.service");
const { DATABASE_ID, assertEnvironment, defaultAuth, defaultInitFirestore, defaultRequest, parseCloudShellArguments, verifyCloudShellAccess } = require("./cloudShellMonitoringPreflight");

const FLAGS = new Set(["reports", "execute", "confirm-digest", "expected-project", "expected-principal"]);
const PRODUCTION_REFUSAL = "Production execution needs a separate approved plan; --execute runs only against the validated demo emulators in test mode.";
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

function parseRecoveryArguments(argv) {
  const values = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.+))?$/.exec(arg);
    if (!match || !FLAGS.has(match[1]) || values[match[1]] !== undefined || (match[1] === "execute") !== (match[2] === undefined)) {
      throw new RecoveryStop("arguments", `Unsupported, repeated or malformed argument: ${arg.split("=")[0]}.`);
    }
    values[match[1]] = match[2] ?? true;
  }
  if (!values.reports) throw new RecoveryStop("arguments", "--reports=<id>[,<id>...] is required.");
  const reportIds = values.reports.split(",");
  assertReportIds(reportIds);
  const execute = values.execute === true;
  if (execute !== (values["confirm-digest"] !== undefined)) throw new RecoveryStop("arguments", "--execute and --confirm-digest are only accepted together.");
  if (execute && !/^[0-9a-f]{16}$/.test(values["confirm-digest"])) throw new RecoveryStop("arguments", "--confirm-digest must be the 16-hex digest from the reviewed dry run.");
  return { reportIds, execute, confirmDigest: values["confirm-digest"], cloudArguments: argv.filter(arg => /^--expected-(project|principal)=/.test(arg)) };
}

function demoEmulator(env) {
  let integration;
  try { integration = validateIntegrationEnvironment(env); } catch { return false; }
  return integration.integration === true && String(integration.projectId).startsWith("demo-") && LOOPBACK.test(env.FIRESTORE_EMULATOR_HOST || "");
}

async function runRecoveryCli({ argv, env, auth, request, initFirestore, openEmulatorDb, loadEnsure }) {
  const args = parseRecoveryArguments(argv);
  // Every refusal below happens before any Firestore or credential access.
  if (args.execute && (args.cloudArguments.length || env.NODE_ENV !== "test" || !demoEmulator(env))) throw new RecoveryStop("environment", PRODUCTION_REFUSAL);

  if (args.cloudArguments.length) {
    const { expectedProject, expectedPrincipal } = parseCloudShellArguments(args.cloudArguments);
    assertEnvironment(env, expectedProject);
    const verification = await verifyCloudShellAccess({ expectedProject, expectedPrincipal, auth: auth(), request });
    const { db } = await initFirestore({ projectId: expectedProject });
    if (db.projectId !== expectedProject || db.databaseId !== DATABASE_ID) throw new RecoveryStop("database", "Initialized Firestore does not match the verified project/database.");
    return { mode: "dry-run", verification, ...(await planRecovery({ db, reportIds: args.reportIds })), next: PRODUCTION_REFUSAL };
  }

  if (!demoEmulator(env)) throw new RecoveryStop("environment", "A dry run needs the validated demo emulators, or Cloud Shell with --expected-project and --expected-principal.");
  const db = openEmulatorDb();
  if (!String(db.projectId).startsWith("demo-")) throw new RecoveryStop("database", "Initialized Firestore is not a demo project.");
  if (args.execute) return { mode: "execute", ...(await executeRecovery({ db, reportIds: args.reportIds, confirmDigest: args.confirmDigest, ensure: loadEnsure() })) };
  return { mode: "dry-run", ...(await planRecovery({ db, reportIds: args.reportIds })) };
}

const failureText = error => `RECOVERY STOPPED ${sanitizeError(error)}`;

module.exports = { failureText, parseRecoveryArguments, runRecoveryCli };

if (require.main === module) {
  Promise.resolve()
    .then(() => runRecoveryCli({ argv: process.argv.slice(2), env: process.env, auth: defaultAuth, request: defaultRequest, initFirestore: defaultInitFirestore,
      // Loaded only after the demo emulator environment is validated; never on the Cloud Shell path.
      openEmulatorDb: () => require("../src/config/firebase").db,
      loadEnsure: () => require("../src/services/verifiedPlantingCohort.service").ensureCohortForAuthoritativeReportInTransaction }))
    .then(result => { console.log(JSON.stringify(result, null, 2)); process.exit(result.mode === "execute" && result.status !== "COMPLETED" ? 2 : 0); })
    .catch(error => {
      console.error(failureText(error));
      if (error.details?.digest) console.error(`Current plan digest: ${error.details.digest} (review a fresh dry run before using it).`);
      process.exit(1);
    });
}
