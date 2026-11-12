const test=require("node:test"),assert=require("node:assert/strict"),{randomUUID}=require("node:crypto");
const topology=require("../helpers/emulatorTestTopology");
const state=require("../../src/config/integrationEnvironment").validateIntegrationEnvironment();
assert.equal(state.legacyMonitoringIsolated,true);assert.equal(state.projectId,topology.project);
for(const key of ["GOOGLE_APPLICATION_CREDENTIALS","FIREBASE_PRIVATE_KEY","FIREBASE_CLIENT_EMAIL","FIREBASE_CONFIG","FIREBASE_TOKEN"])assert.equal(process.env[key],undefined);
process.env.MENRO_SAMPLE_MONITORING_FORM_ACCEPTANCE="true";
process.env.MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL="true";
assert.equal(require("../../src/config/sampleMonitoringOriginalProposal").requireOriginalProposal().linkingEnabled,true);
const {db,auth,getStorageBucket}=require("../../src/config/firebase"),app=require("../../src/app"),visits=require("../../src/services/sampleMonitoringVisit.service");
const {rejectedOriginal}=require("../helpers/sampleMonitoringOriginalPhotoFixtures"),{generateImageHash}=require("../../src/utils/imageVerification.util"),{dateOnlyInManila}=require("../../src/utils/earlyMonitoring.util");
const sharp=require("sharp"),prefix=`original-proposal-${randomUUID()}`,siteId=prefix+"-site",cohortId=prefix+"-cohort";
const ids=Object.fromEntries(["staff","admin","participant","otherStaff"].map(role=>[role,prefix+"-"+role]));
const cleanup=require("../helpers/emulatorCreatedResources").trackEmulatorCreatedResources({db,auth,getBucket:getStorageBucket,prefix,users:ids});
const tokens={};let visitId,server,base,bytes,date;const ownedHashes=new Set();let proofA,uploadKey,revisionBytes;
const input=()=>({source:"uploaded-original",expectedVisitVersion:"1",assessmentRevision:"0"});
async function photo(options={}){const time=new Date().toISOString().slice(0,19).replaceAll("-",":").replace("T"," ");return rejectedOriginal({time,offset:"+00:00",...options});}
async function request({role="staff",sample="TREE-A",fields=input(),buffer=bytes,key=randomUUID()}={}){
 const form=new FormData();for(const[k,v]of Object.entries(fields))form.set(k,String(v));if(buffer)form.set("photos",new Blob([buffer],{type:"image/jpeg"}),"synthetic-rejection.jpg");
 const r=await fetch(`${base}/visits/${visitId}/samples/${sample}/original-photo/verify`,{method:"POST",headers:{...(role?{authorization:`Bearer ${tokens[role]}`}:{}) ,"Idempotency-Key":key},body:form});return{status:r.status,body:await r.json()};
}
test.before(async()=>{
 for(const[role,uid]of Object.entries(ids)){const email=uid+"@example.test";await auth.createUser({uid,email,password:"Local-Proposal-Fixture-2026!",emailVerified:true});await db.collection("users").doc(uid).set({role:role==="otherStaff"?"staff":role,status:"active",testFixture:prefix});const r=await fetch(`http://${topology.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password:"Local-Proposal-Fixture-2026!",returnSecureToken:true})});assert.equal(r.status,200);tokens[role]=(await r.json()).idToken;}
 await db.collection("sites").doc(siteId).set({siteName:"Proposal fixture site",latitude:12.662301,longitude:123.932983,coverageRadiusMeters:50,status:"Active",testFixture:prefix});
 await db.collection("verifiedPlantingCohorts").doc(cohortId).set({source:{siteId},baselineVersion:1,samplingPlan:{status:"APPROVED",version:1},baseline:{approvalStatus:"APPROVED",sampleUnits:[{permanentId:"TREE-A"},{permanentId:"TREE-B"}]},testFixture:prefix});
 date=dateOnlyInManila();visitId=(await visits.create({cohortId,actorId:ids.staff,visitDate:date,testOnly:true})).id;
 await visits.save({visitId,actorId:ids.staff,expectedVersion:0,assessments:[{sampleId:"TREE-A",condition:"Healthy"},{sampleId:"TREE-B",condition:"Healthy"}],dateMonitored:date,submit:false});
 bytes=await photo();server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));base=`http://127.0.0.1:${server.address().port}/api/verified-sample-monitoring`;
});
test.after(async()=>{
 if(server)await new Promise(resolve=>server.close(resolve));
 for(const name of ["sampleMonitoringOriginalVerifications","sampleMonitoringEvidenceHashes"]){const docs=await db.collection(name).where("visitId","==",visitId).get();for(const doc of docs.docs){if(name==="sampleMonitoringOriginalVerifications")assert.equal(doc.data().actorId,ids.staff);await doc.ref.delete();}}
 for(const hash of ownedHashes){const ref=db.collection("sampleMonitoringEvidenceHashes").doc(hash),doc=await ref.get();if(doc.exists){assert.equal(doc.data().visitId,visitId);await ref.delete();}}
 for(const[name,id]of [["sampleMonitoringVisits",visitId],["verifiedPlantingCohorts",cohortId],["sites",siteId],...Object.values(ids).map(id=>["users",id])])if(id)await db.collection(name).doc(id).delete();
 await cleanup();await cleanup();
 assert.equal((await db.collection("sampleMonitoringVisits").doc(visitId).get()).exists,false);
});
test("proposal endpoint stays disabled without its explicit local flag",async()=>{delete process.env.MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL;try{const r=await request();assert.equal(r.status,404);assert.equal(r.body.code,"ORIGINAL_PROPOSAL_DISABLED");}finally{process.env.MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL="true";}});
test("real proposal upload guards deny unauthenticated, Participant, Admin and nonowner Staff",async()=>{for(const[role,status]of [[null,401],["participant",403],["admin",403],["otherStaff",404]])assert.equal((await request({role})).status,status);});
test("real authoritative Tree ID, source, date and revision binding reject unsafe requests",async()=>{
 for(const [options,code]of [[{sample:"TREE-X"},"ORIGINAL_TARGET_UNAVAILABLE"],[{fields:{...input(),expectedVisitVersion:0}},"ORIGINAL_BINDING_STALE"],[{fields:{...input(),assessmentRevision:1}},"ORIGINAL_BINDING_STALE"],[{fields:{...input(),source:"browser-camera"}},"ORIGINAL_SOURCE_REQUIRED"],[{fields:{...input(),latitude:12.662301,accuracy:5}},"ORIGINAL_CLIENT_METADATA_FORBIDDEN"],[{fields:{...input(),reuseEvidence:"old-id"}},"ORIGINAL_REUSE_UNSUPPORTED"]])assert.equal((await request(options)).body.code,code);
});
test("real original-byte diagnostics reject missing GPS/time and mismatched dates",async()=>{
 const old=new Date(Date.now()-86400000).toISOString().slice(0,19).replaceAll("-",":").replace("T"," "),future=new Date(Date.now()+3600000).toISOString().slice(0,19).replaceAll("-",":").replace("T"," ");
 for(const[options,code]of [[{latitude:null},"ORIGINAL_GPS_INVALID"],[{time:null},"ORIGINAL_TIMESTAMP_MISSING"],[{time:"invalid"},"ORIGINAL_TIMESTAMP_INVALID"],[{offset:null},"ORIGINAL_TIMEZONE_REQUIRED"],[{time:old},"ORIGINAL_MONITORING_DATE_MISMATCH"],[{time:future},"ORIGINAL_TIMESTAMP_FUTURE"]]){const r=await request({buffer:await photo(options)});assert.equal(r.status,422,JSON.stringify(r.body));assert.equal(r.body.code,code);}
});

test("outside-site coordinates, screenshots and unsupported bytes remain rejected",async()=>{
 for(const[options,code]of [[{latitude:12.663301},"ORIGINAL_OUTSIDE_SITE"],[{software:"Snipping Tool"},"ORIGINAL_METADATA_SUSPICIOUS"]]){assert.equal((await request({buffer:await photo(options)})).body.code,code);}
 const png=await sharp({create:{width:4,height:4,channels:3,background:"green"}}).png().toBuffer();assert.equal((await request({buffer:png})).body.code,"ORIGINAL_FORMAT_UNSUPPORTED");
});
async function putEvidence({proof=proofA,buffer=bytes,sample="TREE-A",version=1,revision=0,key=uploadKey,role="staff"}={}){
 const form=new FormData();form.set("photos",new Blob([buffer],{type:"image/jpeg"}),"synthetic-original.jpg");form.set("expectedVisitVersion",String(version));form.set("assessmentRevision",String(revision));form.set("evidenceManifest",JSON.stringify([{source:"uploaded-original",originalVerificationId:proof.originalVerificationId}]));
 const r=await fetch(`${base}/visits/${visitId}/samples/${sample}/evidence`,{method:"PUT",headers:{authorization:`Bearer ${tokens[role]}`,"Idempotency-Key":key},body:form});return{status:r.status,body:await r.json()};
}
async function action(method,path,role,body){const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${tokens[role]}`,"content-type":"application/json"},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
async function current(){return(await db.collection("sampleMonitoringVisits").doc(visitId).get()).data();}
const rows=v=>v.sampleAssessments.map(({sampleId,condition,remarks,heightCentimeters,diameterCentimeters})=>({sampleId,condition,remarks,heightCentimeters,diameterCentimeters}));
test("duplicate reservations reject; concurrent verification is stable and never claims trusted accuracy",async()=>{
 const hash=generateImageHash(bytes);ownedHashes.add(hash);const ref=db.collection("sampleMonitoringEvidenceHashes").doc(hash);await ref.create({visitId,sampleId:"TREE-A",assessmentRevision:0,testFixture:prefix});assert.equal((await request()).body.code,"ORIGINAL_DUPLICATE");await ref.delete();
 const key=randomUUID(),attempts=await Promise.all([request({key}),request({key})]);for(const r of attempts){assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.data.accuracyStatus,"UNKNOWN");assert.equal(r.body.data.location.accuracyMeters,null);assert.equal(r.body.data.verificationStatus,"NEEDS_ADMIN_REVIEW");}assert.equal(attempts[0].body.data.originalVerificationId,attempts[1].body.data.originalVerificationId);proofA=attempts[0].body.data;
 assert.equal((await getStorageBucket().getFiles())[0].length,0);assert.equal((await db.collection("evidenceCaptureSessions").where("visitId","==",visitId).get()).size,0);
});
test("verified original cannot cross tree/revision/version/file/owner boundaries",async()=>{
 uploadKey=randomUUID();for(const options of [{sample:"TREE-B"},{revision:1},{version:0},{buffer:await photo({color:"#123456"})},{role:"otherStaff"}]){const r=await putEvidence({...options,key:randomUUID()});assert.equal(r.status,409,JSON.stringify(r.body));}
});
test("expiry, changed date, plan and cross-visit proof binding fail closed",async()=>{
 const upload=require("../../src/services/sampleMonitoringOriginalPhoto.service"),v=await current();
 const call=patch=>upload.resolveOriginal({actorId:ids.staff,visit:{id:visitId,...v,...patch},sampleId:"TREE-A",expectedVisitVersion:1,assessmentRevision:0,file:{buffer:bytes},descriptor:{source:"uploaded-original",originalVerificationId:proofA.originalVerificationId}});
 for(const patch of [{id:visitId+"-different"},{cohortId:cohortId+"-different"},{siteId:siteId+"-different"},{samplingPlanVersion:2},{baselineVersion:2},{dateMonitored:"2020-01-01"}])await assert.rejects(()=>call(patch),e=>e.code==="ORIGINAL_BINDING_STALE");
 const ref=db.collection("sampleMonitoringOriginalVerifications").doc(proofA.originalVerificationId),old=(await ref.get()).data().expiresAt;
 await ref.update({expiresAt:0});await assert.rejects(()=>call({}),e=>e.code==="ORIGINAL_VERIFICATION_EXPIRED");await ref.update({expiresAt:old});
});
test("private upload, response-loss retry, integrity and protected historical retrieval succeed",async()=>{
 const r=await putEvidence();assert.equal(r.status,200,JSON.stringify(r.body));assert.equal((await putEvidence()).status,200);
 const v=await current(),e=v.sampleAssessments[0].evidenceHistory[0];assert.equal(e.source,"uploaded-original");assert.equal(e.revision,0);assert.equal(e.location.accuracyMeters,null);assert.equal(e.accuracyStatus,"UNKNOWN");assert.equal(e.privateEvidence.sha256,generateImageHash(bytes));const downloaded=(await getStorageBucket().file(e.privateEvidence.objectName).download())[0];assert.deepEqual(downloaded,bytes);assert.equal((await db.collection("sampleMonitoringOriginalVerifications").doc(proofA.originalVerificationId).get()).data().state,"CONSUMED");
 for(const[role,status]of [["staff",200],["admin",200],["participant",403],["otherStaff",403],[null,401]]){const r=await fetch(`${base.replace("/verified-sample-monitoring", "")}/evidence/sample-monitoring/visits/${visitId}/samples/TREE-A/evidence/0`,{headers:role?{authorization:`Bearer ${tokens[role]}`}:{}});assert.equal(r.status,status);if(status===200)assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);}
 assert.equal((await request()).body.code,"ORIGINAL_DUPLICATE");assert.equal((await putEvidence({key:randomUUID()})).status,409);assert.equal((await current()).sampleAssessments[0].evidenceHistory.length,1);
 const dto=await(await fetch(`${base}/visits/${visitId}`,{headers:{authorization:`Bearer ${tokens.admin}`}})).json();assert.equal(dto.data.originalEvidenceReviewRequirements.length,1);assert.doesNotMatch(JSON.stringify(dto),/objectName|privateEvidence|originalVerificationId|captureSessionId/);
});
test("unchanged Returned correction reuses immutable original; approval requires explicit review",async()=>{
 let v=await current();let r=await action("PUT",`/visits/${visitId}`,"staff",{expectedVersion:v.version,assessments:rows(v),dateMonitored:date,submit:true});assert.equal(r.status,200,JSON.stringify(r.body));
 v=await current();r=await action("POST",`/visits/${visitId}/review`,"admin",{expectedVersion:v.version,approve:true});assert.equal(r.status,400);assert.equal(r.body.code,"ORIGINAL_ADMIN_REVIEW_REQUIRED");
 r=await action("POST",`/visits/${visitId}/review`,"admin",{expectedVersion:v.version,approve:false,reasons:"Check visit remarks; tree assessment unchanged"});assert.equal(r.status,200);
 v=await current();const old=JSON.stringify(v.sampleAssessments[0].evidenceHistory);r=await action("PUT",`/visits/${visitId}`,"staff",{expectedVersion:v.version,assessments:rows(v),dateMonitored:date,visitRemarks:"Clarification",submit:true});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(JSON.stringify((await current()).sampleAssessments[0].evidenceHistory),old);assert.equal((await current()).sampleAssessments[0].assessmentRevision,0);
 v=await current();r=await action("POST",`/visits/${visitId}/review`,"admin",{expectedVersion:v.version,approve:false,reasons:"Correct tree measurements"});assert.equal(r.status,200);
});
test("material correction requires new evidence; old revisions survive replacement and approval",async()=>{
 let v=await current(),assessments=rows(v);assessments[0].heightCentimeters=120;
 let r=await action("PUT",`/visits/${visitId}`,"staff",{expectedVersion:v.version,assessments,dateMonitored:date,submit:false});assert.equal(r.status,200);v=await current();assert.equal(v.sampleAssessments[0].assessmentRevision,1);
 r=await action("PUT",`/visits/${visitId}`,"staff",{expectedVersion:v.version,assessments:rows(v),dateMonitored:date,submit:true});assert.equal(r.status,409);assert.equal(r.body.code,"ORIGINAL_REPLACEMENT_REQUIRED");
 revisionBytes=await photo({color:"#773322"});const verification=await request({buffer:revisionBytes,fields:{source:"uploaded-original",expectedVisitVersion:v.version,assessmentRevision:1}});assert.equal(verification.status,200,JSON.stringify(verification.body));const proof=verification.body.data;
 const options={proof,buffer:revisionBytes,version:v.version,revision:1,key:randomUUID()};assert.equal((await putEvidence(options)).status,200);assert.equal((await putEvidence(options)).status,200);
 v=await current();assert.deepEqual(v.sampleAssessments[0].evidenceHistory.map(e=>e.revision),[0,1]);r=await action("PUT",`/visits/${visitId}`,"staff",{expectedVersion:v.version,assessments:rows(v),dateMonitored:date,submit:true});assert.equal(r.status,200);
 v=await current();const e=v.sampleAssessments[0].evidenceHistory[1];r=await action("POST",`/visits/${visitId}/review`,"admin",{expectedVersion:v.version,approve:true,originalEvidenceReviews:[{sampleId:"TREE-A",evidenceId:e.evidenceId,assessmentRevision:1}]});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal((await current()).status,"APPROVED");assert.equal((await current()).history.at(-1).originalEvidenceReviews.length,1);
 assert.equal((await request({buffer:revisionBytes,fields:{source:"uploaded-original",expectedVisitVersion:v.version,assessmentRevision:1}})).body.code,"ORIGINAL_BINDING_STALE");assert.equal((await putEvidence(options)).status,200);assert.equal((await current()).sampleAssessments[0].evidenceHistory.length,2);assert.equal((await current()).nextMonitoringDate,undefined);
});
