const ENVIRONMENT_VARIABLE = "EVIDENCE_UPLOAD_MAINTENANCE_ENABLED";

function resolveEvidenceUploadMaintenance(env = process.env) {
  const value = env[ENVIRONMENT_VARIABLE];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${ENVIRONMENT_VARIABLE} must be either true or false.`);
}

module.exports = {
  ENVIRONMENT_VARIABLE,
  resolveEvidenceUploadMaintenance,
};
