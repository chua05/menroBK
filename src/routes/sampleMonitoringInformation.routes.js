const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const { resolveVerifiedPlantingCohortConfig } = require("../config/verifiedPlantingCohort");
const { createNotificationInTransaction } = require("../services/notification.service");
const service = require("../services/sampleMonitoringInformation.service").createService({
  db, now: () => Timestamp.now(), notify: createNotificationInTransaction,
  enabled: () => resolveVerifiedPlantingCohortConfig().enabled && process.env.MONITORING_INFORMATION_ENABLED === "true",
});
const send = (method, args) => async (req, res) => {
  try {
    const data = await service[method]({ ...args(req), actorId: req.user.uid, actorRole: req.user.role });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false,
      message: error.status ? error.message : "Monitoring information is unavailable." });
  }
};
router.use(verifyToken, authorizeRoles("staff", "admin", "participant"));
router.get("/", send("list", req => ({ visitId: req.query.visitId, cursor: req.query.cursor,
  limit: req.query.limit, paged: req.query.paged === "true" })));
router.post("/", authorizeRoles("staff", "admin"), send("create", req => ({
  visitId: req.body?.visitId, question: req.body?.question, key: req.get("Idempotency-Key"),
  ...(req.body?.sampleId !== undefined ? { sampleId: req.body.sampleId, assessmentRevision: req.body.assessmentRevision } : {}),
})));
router.get("/:requestId", send("get", req => ({ requestId: req.params.requestId })));
router.post("/:requestId/answer", authorizeRoles("participant"), send("answer", req => ({
  requestId: req.params.requestId, answer: req.body?.answer,
  expectedVersion: req.body?.expectedVersion, key: req.get("Idempotency-Key"),
})));
module.exports = router;
