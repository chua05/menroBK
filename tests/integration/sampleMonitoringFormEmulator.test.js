const test=require("node:test"),assert=require("node:assert/strict"),{randomUUID}=require("node:crypto");
const topology=require("../helpers/emulatorTestTopology");
const validation=require("../../src/config/integrationEnvironment").validateIntegrationEnvironment();
assert.equal(validation.integration,true);assert.equal(validation.projectId,topology.project);
if(!topology.isolated)throw new Error("Monitoring form acceptance requires an approved isolated emulator topology.");
for(const name of ["GOOGLE_APPLICATION_CREDENTIALS","FIREBASE_PRIVATE_KEY","FIREBASE_CLIENT_EMAIL","FIREBASE_CONFIG"])assert.equal(process.env[name],undefined);
process.env.MONITORING_INFORMATION_ENABLED="true";
const {db,auth,getStorageBucket}=require("../../src/config/firebase"),app=require("../../src/app"),visits=require("../../src/services/sampleMonitoringVisit.service");
const prefix=`monitoring-form-${randomUUID()}`,siteId=`${prefix}-site`,cohortId=`${prefix}-cohort`,requestId=`${prefix}-request`,reportId=`${prefix}-report`;
const ids=Object.fromEntries(["staff","admin","participant","otherStaff"].map(role=>[role,`${prefix}-${role}`]));
const cleanupCreated=require("../helpers/emulatorCreatedResources").trackEmulatorCreatedResources({db,auth,getBucket:getStorageBucket,prefix,users:ids});
const tokens={},questions=new Set();let visitId,server,base;
const assessments=[{sampleId:"TREE-A",condition:"Healthy",heightCentimeters:110,diameterCentimeters:5,remarks:"Observed"},{sampleId:"TREE-B",condition:null}];
async function api(path,role="staff",method="GET",body,headers={}){
 const r=await fetch(base+path,{method,headers:{...(role?{authorization:`Bearer ${tokens[role]}`}:{}) ,...(body?{"content-type":"application/json"}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};
}
test.before(async()=>{
 for(const [role,uid]of Object.entries(ids)){const email=`${uid}@example.test`;await auth.createUser({uid,email,password:"Local-Form-Fixture-2026!",emailVerified:true});await db.collection("users").doc(uid).set({role:role==="otherStaff"?"staff":role,status:"active",testFixture:prefix});
 const response=await fetch(`http://${topology.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password:"Local-Form-Fixture-2026!",returnSecureToken:true})});assert.equal(response.status,200);tokens[role]=(await response.json()).idToken;}
 await db.collection("sites").doc(siteId).set({siteName:"Authorized emulator site",latitude:12.662301,longitude:123.932983,coverageRadiusMeters:50,testFixture:prefix});
 await db.collection("seedlingRequests").doc(requestId).set({participantId:ids.participant,testFixture:prefix});
 await db.collection("plantingReports").doc(reportId).set({requestId,reportNumber:"PR-FORM-FIXTURE",quantityPlanted:50,verificationStatus:"Approved",reportingProgress:"Completed",testFixture:prefix});
 await db.collection("verifiedPlantingCohorts").doc(cohortId).set({source:{siteId,requestId,plantingReportId:reportId},verifiedPlantedQuantity:50,baselineVersion:1,samplingPlan:{status:"APPROVED",version:1,selectedSamples:[{permanentId:"TREE-A",species:"Narra"},{permanentId:"TREE-B",species:"Narra"}]},baseline:{approvalStatus:"APPROVED",sampleUnits:[{permanentId:"TREE-A",condition:"Healthy",heightMeters:1,latitude:12.662301,longitude:123.932983},{permanentId:"TREE-B",condition:"Healthy"}]},testFixture:prefix});
 visitId=(await visits.create({cohortId,actorId:ids.staff,visitDate:"2026-11-01",testOnly:true})).id;
 server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));base=`http://127.0.0.1:${server.address().port}/api`;
});
test.after(async()=>{
 if(server)await new Promise(resolve=>server.close(resolve));
 for(const id of questions){const doc=await db.collection("sampleMonitoringInformationRequests").doc(id).get();if(doc.exists){assert.equal(doc.data().visitId,visitId);await doc.ref.delete();}}
 for(const [collection,id] of [["sampleMonitoringVisits",visitId],["verifiedPlantingCohorts",cohortId],["sites",siteId],["seedlingRequests",requestId],["plantingReports",reportId],...Object.values(ids).map(id=>["users",id])]){if(id)await db.collection(collection).doc(id).delete();}
 await cleanupCreated();await cleanupCreated();
 for(const id of questions)assert.equal((await db.collection("sampleMonitoringInformationRequests").doc(id).get()).exists,false);
});
test("real authorized discovery/context and incomplete draft persist date and remarks without schedule changes",async()=>{
 const list=await api("/verified-sample-monitoring/visits");assert.equal(list.status,200);assert.equal(list.body.data.visits[0].id,visitId);
 const saved=await api(`/verified-sample-monitoring/visits/${visitId}`,"staff","PUT",{expectedVersion:0,assessments,dateMonitored:"2026-11-01",visitRemarks:"Actual field notes",submit:false});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.data.status,"DRAFT");assert.equal(saved.body.data.dateMonitored,"2026-11-01");assert.equal(saved.body.data.visitDate,"2026-11-01");assert.equal(saved.body.data.sampleAssessments[1].condition,null);assert.equal(saved.body.data.summary.needsRechecking,0);assert.equal(saved.body.data.visitContext.verifiedPlantedQuantity,50);assert.equal(saved.body.data.visitContext.samples[0].baseline.heightCentimeters,100);assert.equal(saved.body.data.visitContext.schedule.nextMonitoringDate,null);
});
test("real validation rejects incomplete submit, stale versions and invalid measurements without mutations",async()=>{
 const path=`/verified-sample-monitoring/visits/${visitId}`;
 assert.equal((await api(path,"staff","PUT",{expectedVersion:1,assessments,submit:true})).status,400);
 assert.equal((await api(path,"staff","PUT",{expectedVersion:0,assessments,submit:false})).status,409);
 assert.equal((await api(path,"staff","PUT",{expectedVersion:1,assessments:[{...assessments[0],heightCentimeters:-1},assessments[1]],submit:false})).status,400);
 assert.equal((await api(path)).body.data.version,1);
});
test("real tree clarification binds revision, retries deduplicate and requester can reply without modifying the assessment",async()=>{
 const path=`/verified-sample-monitoring/visits/${visitId}`;
 const changed=[assessments[0],{sampleId:"TREE-B",condition:"Needs Rechecking",remarks:"Tree tag not confirmed"}];assert.equal((await api(path,"staff","PUT",{expectedVersion:1,assessments:changed,submit:false})).status,200);
 const body={visitId,sampleId:"TREE-B",assessmentRevision:0,question:"Was the tree marker moved?"};const first=await api("/sample-monitoring-information","staff","POST",body,{"Idempotency-Key":"tree-question-fixture-01"});assert.equal(first.status,200,JSON.stringify(first.body));questions.add(first.body.data.id);
 const retry=await api("/sample-monitoring-information","staff","POST",body,{"Idempotency-Key":"tree-question-fixture-02"});assert.equal(retry.status,200);assert.equal(retry.body.data.id,first.body.data.id);
 const replied=await api(`/sample-monitoring-information/${first.body.data.id}/answer`,"participant","POST",{expectedVersion:0,answer:"The marker is beside the path."},{"Idempotency-Key":"reply-fixture-key"});assert.equal(replied.status,200);assert.equal(replied.body.data.status,"ANSWERED");assert.equal(replied.body.data.sampleId,"TREE-B");assert.equal((await api(path)).body.data.status,"DRAFT");
});
test("real participant/nonowner/unauthenticated access is denied and Admin detail remains read-only",async()=>{
 const path=`/verified-sample-monitoring/visits/${visitId}`;
 for(const role of ["participant","otherStaff",null])assert.notEqual((await api(path,role)).status,200);
 assert.equal((await api(path,"admin")).status,200);assert.equal((await api(path,"admin","PUT",{expectedVersion:2,assessments,submit:false})).status,403);
 const saved=(await db.collection("sampleMonitoringVisits").doc(visitId).get()).data();assert.equal(saved.version,2);assert.equal(saved.visitDate,"2026-11-01");
});
