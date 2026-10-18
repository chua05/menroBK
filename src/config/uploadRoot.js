const { resolveUploadRoot } = require("./integrationEnvironment");

module.exports = { UPLOAD_ROOT: resolveUploadRoot() };
