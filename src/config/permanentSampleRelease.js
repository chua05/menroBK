const crypto = require("node:crypto");
const configurationError = () => Object.assign(new Error("Permanent-sample release configuration is invalid."), {
  status: 503, code: "PERMANENT_SAMPLE_RELEASE_CONFIGURATION_INVALID",
});
function flag(env, name) {
  if (env[name] === undefined || env[name] === "false") return false;
  if (env[name] !== "true") throw configurationError();
  return true;
}
function ids(value, maximum, pattern) {
  let rows;
  try { rows = JSON.parse(value); } catch { throw configurationError(); }
  if (!Array.isArray(rows) || !rows.length || rows.length > maximum ||
      rows.some(row => typeof row !== "string" || !pattern.test(row)) || new Set(rows).size !== rows.length) throw configurationError();
  return Object.freeze([...rows].sort());
}
function resolve(env = process.env) {
  const paused = flag(env, "PERMANENT_SAMPLE_WRITE_PAUSED");
  const pilot = flag(env, "PERMANENT_SAMPLE_PILOT_ENABLED");
  const declared = env.PERMANENT_SAMPLE_PILOT_USER_IDS !== undefined || env.PERMANENT_SAMPLE_PILOT_COHORT_IDS !== undefined;
  if (declared && env.PERMANENT_SAMPLE_PILOT_ENABLED === undefined) throw configurationError();
  const users = pilot || declared ? ids(env.PERMANENT_SAMPLE_PILOT_USER_IDS, 1000, /^[A-Za-z0-9_.:@+-]{1,128}$/) : [];
  // This bounded IN query is a rollout-control limit, not a sampling policy.
  const cohorts = pilot || declared ? ids(env.PERMANENT_SAMPLE_PILOT_COHORT_IDS, 10, /^[A-Za-z0-9_-]{1,200}$/) : [];
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([paused, pilot, users, cohorts])).digest("hex");
  return Object.freeze({ paused, pilot, users, cohorts, fingerprint });
}
function deny(status, code, message, policy) {
  // No identity, cohort ID, allowlist, request body or evidence metadata is logged.
  console.warn("[permanent-sample-release]", { code, policyFingerprint: policy.fingerprint });
  throw Object.assign(new Error(message), { status, code });
}
function assertUser(actorId, policy = resolve()) {
  if (policy.pilot && !policy.users.includes(actorId)) deny(403, "PERMANENT_SAMPLE_PILOT_FORBIDDEN", "Permanent-sample pilot access is unavailable.", policy);
  return policy;
}
const allowsCohort = (cohortId, policy = resolve()) => !policy.pilot || policy.cohorts.includes(cohortId);
function assertScope(actorId, cohortId, policy = resolve()) {
  assertUser(actorId, policy);
  if (!allowsCohort(cohortId, policy)) deny(404, "PERMANENT_SAMPLE_PILOT_FORBIDDEN", "Permanent-sample record is unavailable.", policy);
  return policy;
}
function assertWrite(policy = resolve()) {
  if (policy.paused) deny(503, "PERMANENT_SAMPLE_WRITES_PAUSED", "Permanent-sample changes are paused. Authorized historical reads remain available.", policy);
}
function writeScope(actorId, cohortId) { const policy = assertScope(actorId, cohortId); assertWrite(policy); }
const scopeQuery = (query, policy = resolve(), field = "cohortId") => policy.pilot ? query.where(field, "in", policy.cohorts) : query;
module.exports = { resolve, assertUser, assertScope, allowsCohort, assertWrite, writeScope, scopeQuery };
