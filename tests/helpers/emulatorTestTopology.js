// Explicit selection for existing regressions; production code never imports
// this helper. The application's integration validator still runs separately.
const isolated = process.env.MENRO_PHASE3C_ISOLATED_EMULATORS === "true";
module.exports = isolated ? {
  isolated, project: "demo-menro-phase3c-isolated", auth: "127.0.0.1:9299", firestore: "127.0.0.1:8281",
  storage: "127.0.0.1:9298", bucket: "demo-menro-phase3c-isolated.firebasestorage.app",
} : {
  isolated, project: "demo-menro-phase2", auth: "127.0.0.1:9099", firestore: "127.0.0.1:8181",
  storage: "127.0.0.1:9199", bucket: "demo-menro-phase2.firebasestorage.app",
};
