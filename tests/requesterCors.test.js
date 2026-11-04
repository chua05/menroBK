const test = require("node:test");
const assert = require("node:assert/strict");
const { createCorsOptions, isOriginAllowed } = require("../src/config/cors");
test("requester idempotency survives disabled evidence writes without broadening origin access", () => {
  const env = { NODE_ENV: "production", VERIFIED_PLANTING_COHORT_ENABLED: "true", MONITORING_INFORMATION_ENABLED: "true", EVIDENCE_CLOUD_WORKFLOW_ENABLED: "false" };
  assert.ok(createCorsOptions(env).allowedHeaders.includes("Idempotency-Key"));
  assert.equal(isOriginAllowed("https://attacker.example", env), false);
  assert.equal(createCorsOptions({ ...env, MONITORING_INFORMATION_ENABLED: "false" }).allowedHeaders.includes("Idempotency-Key"), false);
});
