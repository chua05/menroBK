// Explicit development GCS uses process-local configuration only. Never load
// an adjacent real .env (which may contain production Firebase credentials).
if (process.env.MENRO_GCS_DEVELOPMENT !== "true") require("dotenv").config();

const {
  validateIdentificationEncryptionConfig,
} = require("./services/requestIdentification.service");

validateIdentificationEncryptionConfig();
require("./config/evidenceUploadMaintenance").resolveEvidenceUploadMaintenance();

const app = require("./app");

const PORT = process.env.PORT || 5000;

const host = require('./config/evidenceStorage').resolveEvidenceStorageConfig().gcsDevelopment ? '127.0.0.1' : undefined;
app.listen(PORT, host, () => {
  console.log(` Server running on port ${PORT}`);
});
