#!/usr/bin/env node
// No dotenv, production mode, automatic startup, endpoint or scheduler.
const fs = require('node:fs/promises');
const { emulatorGuard } = require('../src/services/historicalEvidenceSource.service');
async function main(args) {
  const modes = ['dry-run', 'execute-emulator', 'reconcile-emulator', 'verify-emulator', 'rollback-assessment'];
  if (args.length < 2 || args[0] !== '--config' || args.length > 3 || args[2] && !modes.includes(args[2])) throw Error('INVALID_MIGRATION_INVOCATION');
  emulatorGuard(process.env);
  const stat = await fs.stat(args[1]); if (stat.size > 65536) throw Error('CONFIG_LIMIT');
  const config = JSON.parse(await fs.readFile(args[1], 'utf8'));
  if (Object.keys(config).some(k => !['namespace', 'evidenceRoot', 'outputDirectory', 'maxOperations'].includes(k))) throw Error('INVALID_CONFIG');
  const { Firestore } = require('@google-cloud/firestore');
  const { Storage } = require('@google-cloud/storage');
  const db = new Firestore({ projectId: 'demo-menro-phase2', host: '127.0.0.1:8080', ssl: false,
    credentials: { client_email: 'migration@example.invalid', private_key: 'unused-emulator-only' } });
  const cloud = new Storage({ projectId: 'demo-menro-phase2', apiEndpoint: 'http://127.0.0.1:9199', useAuthWithCustomEndpoint: false });
  try {
    const service = require('../src/services/historicalEvidenceMigration.service').createHistoricalEvidenceMigration({
      db, getBucket: () => cloud.bucket('demo-menro-phase2.firebasestorage.app'), ...config });
    const mode = args[2] || 'dry-run';
    const result = ['verify-emulator', 'rollback-assessment'].includes(mode) ? await service.verify() :
      await service.execute({ executeEmulator: ['execute-emulator', 'reconcile-emulator'].includes(mode), reconcileOnly: mode === 'reconcile-emulator', maxOperations: config.maxOperations || 10 });
    console.log(JSON.stringify(result));
    if (result.results?.some(row => row.verified === false)) process.exitCode = 1;
  } finally { await db.terminate(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.error('Migration did not complete. Validate isolated inputs and inspect the private emulator ledger.'); process.exitCode = 1;
});
module.exports = { main };
