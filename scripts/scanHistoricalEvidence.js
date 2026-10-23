#!/usr/bin/env node
// Explicit invocation only; no .env or application startup imports.
const fs = require('node:fs/promises');
const { createMemorySource, createEmulatorSource } = require('../src/services/historicalEvidenceSource.service');
const { scanHistoricalEvidence } = require('../src/services/historicalEvidenceScanner.service');
async function readJson(file, maxBytes) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > maxBytes) throw Error('INPUT_LIMIT');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--config') throw Error('USAGE: node scripts/scanHistoricalEvidence.js --config <explicit-config.json>');
  const config = await readJson(argv[1], 65536);
  const allowed = ['source', 'evidenceRoot', 'outputDirectory', 'batchSize', 'maxRecords', 'maxFiles', 'maxHashBytes', 'checkpointFile', 'localOrigins'];
  if (Object.keys(config).some(k => !allowed.includes(k)) || !config.source) throw Error('INVALID_SCAN_CONFIG');
  let source;
  try {
    if (config.source.mode === 'synthetic-memory') {
      const input = await readJson(config.source.fixtureFile, 16 * 1024 * 1024);
      source = createMemorySource(input);
    } else if (config.source.mode === 'firestore-emulator') source = createEmulatorSource(config.source);
    else throw Error('SCANNER_SOURCE_NOT_ALLOWED');
    const checkpoint = config.checkpointFile ? await readJson(config.checkpointFile, 32 * 1024 * 1024) : undefined;
    const { source: ignoredSource, checkpointFile: ignoredCheckpoint, ...options } = config;
    void ignoredSource; void ignoredCheckpoint;
    const result = await scanHistoricalEvidence({ ...options, source, checkpoint });
    console.log(JSON.stringify({ metrics: result.report.metrics, completeness: result.report.completeness, artifacts: result.report.artifacts }));
  } finally { if (source) await source.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  // No raw filesystem/SDK errors, stored URLs or private paths on the console.
  console.error('Historical evidence scan failed. Check explicit inputs, source guards and checkpoint compatibility.'); process.exitCode = 1;
});
module.exports = { main };
