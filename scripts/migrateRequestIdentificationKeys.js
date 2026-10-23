#!/usr/bin/env node
// Operator-only, bounded migration command. Output contains aggregate counts and a
// pagination cursor only; it never prints plaintext identifiers or key material.
const APPROVAL = "AUTHORIZED_REQUEST_IDENTIFICATION_KEY_MIGRATION";
const ROLLBACK_APPROVAL = "AUTHORIZED_REQUEST_IDENTIFICATION_KEY_ROLLBACK";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parse(argv) {
  const options = {};
  const allowed = new Set(["mode", "migration-id", "limit", "cursor"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("INVALID_IDENTIFICATION_MIGRATION_INVOCATION");
    const key = name.slice(2);
    if (!allowed.has(key) || Object.hasOwn(options, key)) fail("INVALID_IDENTIFICATION_MIGRATION_INVOCATION");
    options[key] = value;
  }
  if (!options.mode || !options["migration-id"]) fail("INVALID_IDENTIFICATION_MIGRATION_INVOCATION");
  if (!['dry-run', 'execute', 'reconcile', 'rollback'].includes(options.mode)) {
    fail("INVALID_IDENTIFICATION_MIGRATION_INVOCATION");
  }
  return {
    mode: options.mode,
    migrationId: options["migration-id"],
    limit: options.limit === undefined ? 50 : Number(options.limit),
    cursor: options.cursor || "",
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const input = parse(argv);
  if (env.NODE_ENV !== "production" || env.FIREBASE_PROJECT_ID !== "menrosystem-ddfac" ||
      env.REQUEST_IDENTIFICATION_MIGRATION_ENABLED !== "true" ||
      env.REQUEST_IDENTIFICATION_MIGRATION_APPROVAL !== APPROVAL ||
      input.mode === "rollback" && env.REQUEST_IDENTIFICATION_MIGRATION_ROLLBACK_APPROVAL !== ROLLBACK_APPROVAL ||
      env.MENRO_INTEGRATION_TEST !== undefined || env.FIRESTORE_EMULATOR_HOST !== undefined) {
    fail("IDENTIFICATION_MIGRATION_PRODUCTION_APPROVAL_REQUIRED");
  }
  const { db } = require("../src/config/firebase");
  const { createRequestIdentificationKeyMigration } = require(
    "../src/services/requestIdentificationKeyMigration.service"
  );
  return createRequestIdentificationKeyMigration({ db, env }).run(input);
}

if (require.main === module) {
  main().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(JSON.stringify({ ok: false,
      code: /^[A-Z0-9_]+$/.test(error?.code || "") ? error.code : "IDENTIFICATION_MIGRATION_FAILED" }));
    process.exitCode = 1;
  });
}

module.exports = { APPROVAL, ROLLBACK_APPROVAL, main, parse };
