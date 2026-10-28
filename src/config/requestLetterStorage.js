const { resolveEvidenceStorageConfig } = require("./evidenceStorage");

function resolveRequestLetterStorageConfig(env = process.env) {
  const value = env.REQUEST_LETTER_STORAGE_ENABLED;
  const requiredValue = env.REQUEST_LETTER_STORAGE_REQUIRED;
  if (value !== undefined && !["true", "false"].includes(value)) {
    throw new Error("Invalid request-letter storage gate.");
  }
  if (requiredValue !== undefined && !["true", "false"].includes(requiredValue)) {
    throw new Error("Invalid request-letter requirement gate.");
  }
  const enabled = value === "true";
  const required = requiredValue === "true";
  if (required && !enabled) {
    throw new Error("Request-letter storage must be enabled before secure uploads are required.");
  }
  const storage = resolveEvidenceStorageConfig(env);
  if (enabled && (!storage.cloudWorkflow || !storage.cloudRead || !storage.bucket)) {
    throw new Error("Request-letter storage requires the private cloud write/read workflow.");
  }
  return Object.freeze({ enabled, required, storage });
}

module.exports = { resolveRequestLetterStorageConfig };
