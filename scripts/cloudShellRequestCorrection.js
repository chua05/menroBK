// One-request historical correction for REQ-2026-054 in Google Cloud Shell (operator ADC, no key file; never
// loads src/config/firebase.js). Routes the pre-fix Staff-encoded walk-in from "Pending" to Admin approval.
//
// HARD DEPENDENCY: run --execute only after the backend containing the Staff direct-to-Admin fix is deployed.
// The previously deployed backend treats any "Reviewed" request as Staff-reviewed and would invent a review ID
// and reviewer on the next read.
//
// DRY RUN (read-only):
//   NODE_ENV=production FIREBASE_PROJECT_ID=menrosystem-ddfac node scripts/cloudShellRequestCorrection.js \
//     --expected-project=menrosystem-ddfac --expected-principal=<you@example.com>
// EXECUTE (separate written approval only):
//   ... plus --execute --confirm-project=menrosystem-ddfac --confirm-request-number=REQ-2026-054 \
//     --confirm-request-id=<id from dry run> --confirm-plan=<digest from dry run> \
//     --confirm-backend-deployed=<deployed backend commit SHA containing the fix> --reason="<why>"
const { PRODUCTION_PROJECT } = require("../src/services/monitoringLifecycleBackfill.service");
const { DATABASE_ID, EMAIL, PreflightStop, REQUIRED_READ_PERMISSIONS, assertEnvironment, defaultAuth, defaultInitFirestore, defaultRequest, verifyCloudShellAccess } =
  require("./cloudShellMonitoringPreflight");
const { createHistoricalStaffRequestCorrection } = require("../src/services/historicalStaffRequestCorrection.service");

const TARGET_REQUEST_NUMBER = "REQ-2026-054";
const FLAGS = new Set(["expected-project", "expected-principal", "execute", "confirm-project", "confirm-request-number", "confirm-request-id", "confirm-plan", "confirm-backend-deployed", "reason"]);

function parseCorrectionArguments(args) {
  const values = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=([\s\S]+))?$/.exec(arg);
    if (!match || !FLAGS.has(match[1]) || values[match[1]] !== undefined) throw new PreflightStop("arguments", `Unsupported or repeated argument: ${arg.split("=")[0]}.`);
    if ((match[1] === "execute") !== (match[2] === undefined)) throw new PreflightStop("arguments", `Malformed argument: ${arg.split("=")[0]}.`);
    values[match[1]] = match[2] ?? true;
  }
  if (values["expected-project"] !== PRODUCTION_PROJECT) throw new PreflightStop("arguments", `--expected-project must be exactly ${PRODUCTION_PROJECT}.`);
  if (!EMAIL.test(values["expected-principal"] || "")) throw new PreflightStop("arguments", "--expected-principal must be the operator's Google account email.");
  const execute = values.execute === true;
  const confirms = ["confirm-project", "confirm-request-number", "confirm-request-id", "confirm-plan", "confirm-backend-deployed", "reason"];
  if (!execute && confirms.some((key) => values[key] !== undefined)) throw new PreflightStop("arguments", "Confirmation flags are only accepted together with --execute.");
  if (execute) {
    if (values["confirm-project"] !== PRODUCTION_PROJECT) throw new PreflightStop("arguments", `--execute requires --confirm-project=${PRODUCTION_PROJECT}.`);
    if (values["confirm-request-number"] !== TARGET_REQUEST_NUMBER) throw new PreflightStop("arguments", `--execute requires --confirm-request-number=${TARGET_REQUEST_NUMBER}.`);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(values["confirm-request-id"] || "")) throw new PreflightStop("arguments", "--execute requires --confirm-request-id=<document ID from the reviewed dry run>.");
    if (!/^[0-9a-f]{16}$/.test(values["confirm-plan"] || "")) throw new PreflightStop("arguments", "--execute requires --confirm-plan=<16-hex digest from the reviewed dry run>.");
    if (!/^[0-9a-f]{7,40}$/.test(values["confirm-backend-deployed"] || "")) throw new PreflightStop("arguments", "--execute requires --confirm-backend-deployed=<deployed backend commit SHA that includes the Staff direct-to-Admin fix>.");
    if (typeof values.reason !== "string" || values.reason.trim().length < 10) throw new PreflightStop("arguments", "--execute requires --reason=\"<10-300 character correction reason>\".");
  }
  return { expectedProject: PRODUCTION_PROJECT, expectedPrincipal: values["expected-principal"].toLowerCase(), execute,
    confirmRequestId: values["confirm-request-id"] || null, confirmPlanDigest: values["confirm-plan"] || null, backendCommit: values["confirm-backend-deployed"] || null, reason: values.reason || null };
}

async function runCloudShellRequestCorrection({ argv, env, auth, request, initFirestore }) {
  const args = parseCorrectionArguments(argv);
  assertEnvironment(env, args.expectedProject);
  const verification = await verifyCloudShellAccess({ expectedProject: args.expectedProject, expectedPrincipal: args.expectedPrincipal, auth, request,
    requiredPermissions: args.execute ? [...REQUIRED_READ_PERMISSIONS, "datastore.entities.update"] : REQUIRED_READ_PERMISSIONS });
  const { db } = await initFirestore({ projectId: args.expectedProject });
  if (db.projectId !== args.expectedProject || db.databaseId !== DATABASE_ID) throw new PreflightStop("database", "Initialized Firestore does not match the verified project/database.");
  const correction = createHistoricalStaffRequestCorrection({ db, requestNumber: TARGET_REQUEST_NUMBER, operator: verification.principal });
  if (!args.execute) {
    const dry = await correction.dryRun();
    return { verification, ...dry, next: dry.state === "CORRECTABLE"
      ? `After the fixed backend is deployed and separate approval: add --execute --confirm-project=${PRODUCTION_PROJECT} --confirm-request-number=${TARGET_REQUEST_NUMBER} --confirm-request-id=${dry.requestId} --confirm-plan=${dry.planDigest} --confirm-backend-deployed=<commit> --reason="<why>"`
      : dry.state === "ALREADY_CORRECTED" ? "Nothing to do." : "Do not execute; review the blockers." };
  }
  const result = await correction.execute({ confirmRequestId: args.confirmRequestId, confirmPlanDigest: args.confirmPlanDigest, reason: `${args.reason.trim()} (backend ${args.backendCommit})` });
  return { verification, mode: "execute", backendCommitConfirmed: args.backendCommit, ...result };
}

module.exports = { TARGET_REQUEST_NUMBER, parseCorrectionArguments, runCloudShellRequestCorrection };

if (require.main === module) {
  Promise.resolve()
    .then(() => runCloudShellRequestCorrection({ argv: process.argv.slice(2), env: process.env, auth: defaultAuth(), request: defaultRequest, initFirestore: defaultInitFirestore }))
    .then((result) => { console.log(JSON.stringify(result, null, 2)); process.exit(result.mode === "execute" && result.postVerification?.ok === false ? 2 : 0); })
    .catch((error) => {
      console.error(`CORRECTION STOPPED ${error.message}`);
      if (error.details?.planDigest) console.error(`Current plan digest: ${error.details.planDigest} (review a fresh dry run before using it).`);
      process.exit(1);
    });
}
