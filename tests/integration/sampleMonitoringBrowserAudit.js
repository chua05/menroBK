const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{createHash}=require("node:crypto");
// Read-only private-evidence audit of the real-browser fixture. It never writes and fails on any mismatch.
// A first-visit fixture creates visit 1 only in the browser, so a run that failed earlier is a valid
// "no visit / no evidence" result (FIX-G H-1); every other missing or mismatched record still fails.
const {fixtureCohortId}=require("./phase3cBrowserFixtureCleanup");
async function auditFixture({fixture,db,bucket}){
 const doc=await db.collection("sampleMonitoringVisits").doc(fixture.visitId).get();
 if(!doc.exists){
  assert.ok(["first-visit","verified-report"].includes(fixture.mode),"The seeded monitoring visit is missing.");
  const visits=await db.collection("sampleMonitoringVisits").where("cohortId","==",fixtureCohortId(fixture.prefix,fixture.mode)).get();
  assert.equal(visits.docs.length,0,"A visit for the first-visit fixture cohort exists under an unexpected id.");
  return {monitoringEvidenceAudit:true,visitCreated:false,visitId:fixture.visitId,status:null,version:null,visitDate:null,dateMonitored:null,nextMonitoringDate:null,trees:[]};
 }
 const row=doc.data();assert.equal(row.createdBy,`${fixture.prefix}-staff`);assert.equal(row.cohortId,fixtureCohortId(fixture.prefix,fixture.mode));assert.equal(row.siteId,`${fixture.prefix}-site`);
 assert.ok(Array.isArray(row.sampleAssessments),"The monitoring visit has no sample assessments.");
 const trees=[];
 for(const tree of row.sampleAssessments){const evidence=[];for(const history of tree.evidenceHistory||[]){const ref=history?.privateEvidence;assert.ok(ref&&typeof ref==="object",`Evidence for ${tree.sampleId} lacks its private evidence reference.`);assert.equal(ref.bucket,bucket.name);const file=bucket.file(ref.objectName);assert.equal((await file.exists())[0],true);const bytes=(await file.download())[0];assert.equal(createHash("sha256").update(bytes).digest("hex"),ref.sha256);const metadata=(await file.getMetadata())[0];assert.equal(metadata.metadata.uploadIntentId,ref.uploadIntentId);const intent=(await db.collection("evidenceUploadIntents").doc(ref.uploadIntentId).get()).data();assert.equal(intent?.status,"LINKED");assert.equal(intent.actorId,row.createdBy);evidence.push({revision:history.revision,sha256Matches:true,storedBytes:bytes.length,location:history.location});}trees.push({sampleId:tree.sampleId,assessmentRevision:tree.assessmentRevision,evidence});}
 return {monitoringEvidenceAudit:true,visitCreated:true,visitId:fixture.visitId,status:row.status,version:row.version,visitDate:row.visitDate,dateMonitored:row.dateMonitored||null,nextMonitoringDate:row.nextMonitoringDate||null,trees};
}
async function main(){
 const integration=require("../../src/config/integrationEnvironment").validateIntegrationEnvironment();assert.equal(integration.legacyMonitoringIsolated,true);assert.equal(process.env.MENRO_SAMPLE_MONITORING_FORM_ACCEPTANCE,"true");
 const fixture=JSON.parse(await fs.readFile(path.join(os.tmpdir(),"menro-phase3c-browser-fixture.json"),"utf8"));assert.equal(fixture.project,integration.projectId);assert.match(fixture.prefix,/^phase3c-browser-[0-9a-f-]{36}$/);
 const {db,getStorageBucket}=require("../../src/config/firebase"),bucket=getStorageBucket();assert.equal(db.projectId,integration.projectId);assert.equal(bucket.name,`${integration.projectId}.firebasestorage.app`);
 console.log(JSON.stringify(await auditFixture({fixture,db,bucket})));
}
if(require.main===module)main().then(()=>process.exit(0)).catch(error=>{console.error({monitoringEvidenceAudit:false,name:error.name,code:error.code||null,message:error.message});process.exitCode=1;});
module.exports={auditFixture};
