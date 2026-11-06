const router = require("express").Router();
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const service = require("../services/purposePolicy.service");
const respond = handler => async (req, res) => {
  try { res.json({ success: true, data: await handler(req) }); }
  catch (error) { res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Purpose policy service unavailable.", ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}) }); }
};
router.use(verifyToken, authorizeRoles("admin"));
router.get("/", respond(req => service.readSettings(req.user)));
router.put("/", respond(req => service.saveSettings(req.user, req.body)));
module.exports = router;
