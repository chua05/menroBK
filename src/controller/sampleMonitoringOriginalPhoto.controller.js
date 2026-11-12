const { requireOriginalProposal }=require("../config/sampleMonitoringOriginalProposal");
const service=require("../services/sampleMonitoringOriginalPhoto.service");
const {resolveVerifiedPlantingCohortConfig}=require("../config/verifiedPlantingCohort");
function errorResponse(res,error){return res.status(error.status||400).json({success:false,policyStatus:"PROPOSED_PENDING_MENRO_APPROVAL",linkingEnabled:false,code:error.code,message:error.message});}
function proposalGate(req,res,next){
  try { requireOriginalProposal();
    if(!resolveVerifiedPlantingCohortConfig().enabled)throw Object.assign(new Error("Verified planting cohort workflow is disabled."),{status:409,code:"COHORT_WORKFLOW_DISABLED"});
    return next();
  }catch(error){return errorResponse(res,error);}
}
async function verify(req,res){
  try { return res.status(200).json({success:true,data:await service.verifyOriginal({actorId:req.user.uid,actorRole:req.user.role,visitId:req.params.visitId,sampleId:req.params.sampleId,input:req.body,files:req.files,idempotencyKey:req.get("Idempotency-Key")})});
  }catch(error){return errorResponse(res,error);}
}
module.exports={proposalGate,verify};
