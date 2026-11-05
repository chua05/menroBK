const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const isolated = process.env.MENRO_PHASE3C_ISOLATED_EMULATORS === "true";
const topology = isolated
  ? { project: "demo-menro-phase3c-isolated", firestore: "127.0.0.1:8281", auth: "127.0.0.1:9299", storage: "127.0.0.1:9298" }
  : { project: "demo-menro-phase2", firestore: "127.0.0.1:8181", auth: "127.0.0.1:9099", storage: "127.0.0.1:9199" };
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) assert.equal(process.env[key], undefined);
Object.assign(process.env, {
  NODE_ENV: "test", MENRO_INTEGRATION_TEST: "true", MENRO_REQUEST_LETTER_ACCEPTANCE: "true",
  GCLOUD_PROJECT: topology.project, FIREBASE_PROJECT_ID: topology.project,
  FIRESTORE_EMULATOR_HOST: topology.firestore, FIREBASE_AUTH_EMULATOR_HOST: topology.auth,
  FIREBASE_STORAGE_EMULATOR_HOST: topology.storage, STORAGE_EMULATOR_HOST: `http://${topology.storage}`,
  FIREBASE_STORAGE_BUCKET: `${topology.project}.firebasestorage.app`,
  EVIDENCE_STORAGE_PROVIDER: "firebase", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "true", EVIDENCE_CLOUD_READ_ENABLED: "true",
});
const { cleanupFixture, fixturePath } = require("./phase3cBrowserFixtureCleanup");
async function main() {
  const explicitPrefix = process.argv[2];
  const fixture = explicitPrefix ? null : await fs.readFile(fixturePath, "utf8").then(JSON.parse)
    .catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const prefix = explicitPrefix || fixture?.prefix || fixture?.emails?.staff?.slice("staff.".length, -"@example.test".length);
  if (fixture?.project) assert.equal(fixture.project, topology.project);
  if (!prefix) return console.log(JSON.stringify({ noActiveFixture: true }));
  if (process.env.MENRO_VERIFY_RELEASE_NO_WRITES === "true") {
    const visitId = require("../../src/services/sampleMonitoringVisit.service")._test.id(`${prefix}-cohort`, "2099-01-01");
    console.log(JSON.stringify(await require("./permanentSampleReleaseFixture").verify(prefix, visitId)));
  }
  console.log(JSON.stringify(await cleanupFixture(prefix)));
}
main().catch(error => {
  console.error({ name: error.name, code: error.code || null,
    source: error.stack?.split("\n").slice(1, 3).map(line => line.trim()) });
  process.exitCode = 1;
});
