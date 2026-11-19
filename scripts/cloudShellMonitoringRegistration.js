// Target-scoped historical Monitoring Lifecycle registration for Google Cloud Shell (ADC, no key file).
// Production scope is fixed: event_EVT-2026-025 (RPT-2026-020) and event_EVT-2026-029 (RPT-2026-024),
// Staff Spot-Check only. Never loads src/config/firebase.js.
//
// DRY RUN (default; read-only, prints the plan and its digest):
//   NODE_ENV=production FIREBASE_PROJECT_ID=menrosystem-ddfac node scripts/cloudShellMonitoringRegistration.js \
//     --expected-project=menrosystem-ddfac --expected-principal=<you@example.com>
// EXECUTE (only after separate written approval of the reviewed dry run):
//   ... same, plus: --execute --confirm-project=menrosystem-ddfac \
//     --confirm-reports=event_EVT-2026-025,event_EVT-2026-029 --confirm-plan=<digest from the reviewed dry run>
const { PRODUCTION_PROJECT, PRODUCTION_TARGETS } = require("../src/services/monitoringLifecycleBackfill.service");
const { DATABASE_ID, EMAIL, PreflightStop, REQUIRED_READ_PERMISSIONS, assertEnvironment, defaultAuth, defaultInitFirestore, defaultRequest, verifyCloudShellAccess } =
  require("./cloudShellMonitoringPreflight");
const { createTargetedRegistration } = require("../src/services/monitoringLifecycleTargetedRegistration.service");

const REQUIRED_WRITE_PERMISSIONS = Object.freeze(["datastore.entities.create", "datastore.entities.update"]);
const CONFIRM_REPORTS = PRODUCTION_TARGETS.map(target => target.reportId).join(",");
const FLAGS = new Set(["expected-project", "expected-principal", "execute", "confirm-project", "confirm-reports", "confirm-plan"]);

function parseRegistrationArguments(args) {
  const values = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.+))?$/.exec(arg);
    if (!match || !FLAGS.has(match[1]) || values[match[1]] !== undefined) throw new PreflightStop("arguments", `Unsupported or repeated argument: ${arg.split("=")[0]}.`);
    if ((match[1] === "execute") !== (match[2] === undefined)) throw new PreflightStop("arguments", `Malformed argument: ${arg.split("=")[0]}.`);
    values[match[1]] = match[2] ?? true;
  }
  if (values["expected-project"] !== PRODUCTION_PROJECT) throw new PreflightStop("arguments", `--expected-project must be exactly ${PRODUCTION_PROJECT}.`);
  if (!EMAIL.test(values["expected-principal"] || "")) throw new PreflightStop("arguments", "--expected-principal must be the operator's Google account email.");
  const execute = values.execute === true;
  const confirms = ["confirm-project", "confirm-reports", "confirm-plan"];
  if (!execute && confirms.some(key => values[key] !== undefined)) throw new PreflightStop("arguments", "Confirmation flags are only accepted together with --execute.");
  if (execute) {
    if (values["confirm-project"] !== PRODUCTION_PROJECT) throw new PreflightStop("arguments", `--execute requires --confirm-project=${PRODUCTION_PROJECT}.`);
    if (values["confirm-reports"] !== CONFIRM_REPORTS) throw new PreflightStop("arguments", `--execute requires --confirm-reports=${CONFIRM_REPORTS}.`);
    if (!/^[0-9a-f]{16}$/.test(values["confirm-plan"] || "")) throw new PreflightStop("arguments", "--execute requires --confirm-plan=<16-hex digest from the reviewed dry run>.");
  }
  return { expectedProject: PRODUCTION_PROJECT, expectedPrincipal: values["expected-principal"].toLowerCase(), execute, confirmPlanDigest: values["confirm-plan"] || null };
}

async function runCloudShellRegistration({ argv, env, auth, request, initFirestore }) {
  const args = parseRegistrationArguments(argv);
  assertEnvironment(env, args.expectedProject);
  const verification = await verifyCloudShellAccess({ expectedProject: args.expectedProject, expectedPrincipal: args.expectedPrincipal, auth, request,
    requiredPermissions: args.execute ? [...REQUIRED_READ_PERMISSIONS, ...REQUIRED_WRITE_PERMISSIONS] : REQUIRED_READ_PERMISSIONS });
  const { db, app } = await initFirestore({ projectId: args.expectedProject });
  if (db.projectId !== args.expectedProject || db.databaseId !== DATABASE_ID) throw new PreflightStop("database", "Initialized Firestore does not match the verified project/database.");
  const service = createTargetedRegistration({ db, app, env, targets: PRODUCTION_TARGETS, expectedProject: args.expectedProject, requiredMethod: "STAFF_SPOT_CHECK" });

  if (!args.execute) {
    const { preflight, planDigest, blockers } = await service.dryRun();
    return { mode: "dry-run", verification, planDigest, executable: blockers.length === 0, blockers, preflight,
      next: blockers.length ? "Do not execute; review the blockers." :
        `After separate approval: add --execute --confirm-project=${PRODUCTION_PROJECT} --confirm-reports=${CONFIRM_REPORTS} --confirm-plan=${planDigest}` };
  }
  return { mode: "execute", verification, ...(await service.execute({ confirmPlanDigest: args.confirmPlanDigest })) };
}

module.exports = { CONFIRM_REPORTS, REQUIRED_WRITE_PERMISSIONS, parseRegistrationArguments, runCloudShellRegistration };

if (require.main === module) {
  Promise.resolve()
    .then(() => runCloudShellRegistration({ argv: process.argv.slice(2), env: process.env, auth: defaultAuth(), request: defaultRequest, initFirestore: defaultInitFirestore }))
    .then(result => { console.log(JSON.stringify(result, null, 2)); process.exit(result.mode === "execute" && (result.status !== "COMPLETED" || !result.postVerification?.ok) ? 2 : 0); })
    .catch(error => {
      console.error(`REGISTRATION STOPPED ${error.message}`);
      if (error.details?.planDigest) console.error(`Current plan digest: ${error.details.planDigest} (review a fresh dry run before using it).`);
      process.exit(1);
    });
}
