const r=require("express").Router();
const {verifyToken}=require("../middleware/auth.middleware");
const {authorizeRoles}=require("../middleware/role.middleware");
const {uploadContributionEvidence,uploadConcurrencyGuard}=require("../middleware/upload.middleware");
const {evidenceUploadMaintenanceGate}=require("../middleware/evidenceUploadMaintenance.middleware");
const controller=require("../controller/sampleMonitoringOriginalPhoto.controller");
r.post("/visits/:visitId/samples/:sampleId/original-photo/verify",verifyToken,authorizeRoles("staff"),
  controller.proposalGate,evidenceUploadMaintenanceGate,uploadConcurrencyGuard,uploadContributionEvidence,controller.verify);
module.exports=r;
