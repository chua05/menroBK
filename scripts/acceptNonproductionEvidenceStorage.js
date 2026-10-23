// No dotenv, Firebase initialization or network on import/default invocation.
const fs = require('node:fs');
const { runAcceptance, validateTarget } = require('../src/services/nonproductionStorageAcceptance.service');
async function main(args = process.argv.slice(2)) {
  if (!args.length) return { mode: 'prepare', networkRequests: 0, executionBlocked: 'EXECUTION_AUTHORIZATION_REQUIRED', cleanupAllowed: false };
  if (![2, 5].includes(args.length) || args[0] !== '--config' ||
      args.length === 5 && (args[2] !== '--execute-authorized' || !['--credentials', '--adc-file'].includes(args[3]))) throw Error('INVALID_ARGUMENTS');
  function read(file, adcFile = false) {
    try { if (fs.statSync(file).size > 32768) throw Error('CONFIG_TOO_LARGE'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (adcFile) throw Error(e?.code === 'ENOENT' ? 'ADC_REQUIRED' : 'ADC_INVALID'); throw e; }
  }
  const config = read(args[1]);
  validateTarget(config, process.env); // Before reading ANY credential file.
  if (args.length === 5 && process.env.MENRO_GCS_ACCEPTANCE_EXECUTE !== 'AUTHORIZED_NONPRODUCTION_SYNTHETIC_ONLY') {
    throw Error('EXECUTION_AUTHORIZATION_REQUIRED');
  }
  return runAcceptance({ config, env: process.env, execute: args.length === 5,
    ...(args.length === 5 ? { [args[3] === '--adc-file' ? 'adc' : 'credentials']: read(args[4], args[3] === '--adc-file') } : {}) });
}
const SAFE_ERRORS = new Set(['ADC_REQUIRED', 'ADC_INVALID', 'ADC_IDENTITY_MISMATCH', 'EFFECTIVE_IDENTITY_MISMATCH',
  'EFFECTIVE_TOKEN_INVALID', 'IMPERSONATION_PERMISSION_DENIED', 'TOKEN_INTROSPECTION_DENIED', 'AUTH_CREDENTIALS_INVALID', 'AUTH_VERIFICATION_UNAVAILABLE',
  'BUCKET_METADATA_PERMISSION_DENIED', 'BUCKET_NOT_FOUND', 'BUCKET_INSPECTION_UNAVAILABLE',
  'BUCKET_IDENTITY_MISMATCH', 'BUCKET_CONFIGURATION_MISMATCH', 'BUCKET_PRIVACY_NOT_VERIFIED',
  'MISSING_OBJECT_NOT_VERIFIED', 'EXECUTION_AUTHORIZATION_REQUIRED']);
const safeFailure = e => ({ error: SAFE_ERRORS.has(e?.code || e?.message) ? e.code || e.message : 'ACCEPTANCE_BLOCKED_OR_FAILED', cleanupAllowed: false });
if (require.main === module) main().then(r => console.log(JSON.stringify(r))).catch(e => {
  console.error(JSON.stringify(safeFailure(e))); process.exitCode = 1;
});
module.exports = { main, safeFailure };
