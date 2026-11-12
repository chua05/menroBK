const test=require("node:test"),assert=require("node:assert/strict");
const {requireOriginalProposal}=require("../src/config/sampleMonitoringOriginalProposal");
const images=require("../src/utils/imageVerification.util");
const {rejectedOriginal}=require("./helpers/sampleMonitoringOriginalPhotoFixtures");
const sharp=require("sharp");
const rows=new Map();let reads=0;
const firebase=require.resolve("../src/config/firebase");
require.cache[firebase]={id:firebase,filename:firebase,loaded:true,exports:{db:{collection:name=>({doc:id=>({get:async()=>{reads++;const value=rows.get(name+"/"+id);return{exists:value!==undefined,data:()=>value};}})})}}};
const service=require("../src/services/sampleMonitoringOriginalPhoto.service");
const env=()=>({VERIFIED_PLANTING_COHORT_ENABLED:"true",NODE_ENV:"test",MENRO_INTEGRATION_TEST:"true",MENRO_SAMPLE_MONITORING_FORM_ACCEPTANCE:"true",MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL:"true",MENRO_LEGACY_MONITORING_ISOLATED_EMULATORS:"true",GCLOUD_PROJECT:"demo-menro-legacy-monitoring-20261106",FIREBASE_PROJECT_ID:"demo-menro-legacy-monitoring-20261106",FIREBASE_AUTH_EMULATOR_HOST:"127.0.0.1:9399",FIRESTORE_EMULATOR_HOST:"127.0.0.1:8381",FIREBASE_STORAGE_EMULATOR_HOST:"127.0.0.1:9398",FIREBASE_STORAGE_BUCKET:"demo-menro-legacy-monitoring-20261106.firebasestorage.app"});
test("proposal defaults disabled and permits linkage only in guarded local proposal",()=>{assert.throws(()=>requireOriginalProposal({}),e=>e.status===404);assert.equal(requireOriginalProposal(env()).linkingEnabled,true);assert.equal(requireOriginalProposal(env()).policyStatus,"PROPOSED_PENDING_MENRO_APPROVAL");});
for(const [label,patch]of Object.entries({production:{NODE_ENV:"production"},missingFlag:{MENRO_SAMPLE_MONITORING_FORM_ACCEPTANCE:undefined},missingIntegration:{MENRO_INTEGRATION_TEST:undefined},invalidFlag:{MENRO_MONITORING_ORIGINAL_PHOTO_PROPOSAL:"TRUE"},project:{GCLOUD_PROJECT:"production-project"},sharedProject:{FIREBASE_PROJECT_ID:"demo-menro-phase2"},mixedPorts:{FIRESTORE_EMULATOR_HOST:"127.0.0.1:8281"},remoteHost:{FIREBASE_AUTH_EMULATOR_HOST:"example.test:9399"},wrongBucket:{FIREBASE_STORAGE_BUCKET:"demo-menro-phase2.firebasestorage.app"},credentials:{GOOGLE_APPLICATION_CREDENTIALS:"not-read.json"},token:{FIREBASE_TOKEN:"test-only-rejected"}}))test(`proposal rejects ${label}`,()=>{assert.throws(()=>requireOriginalProposal({...env(),...patch}),e=>e.code==="ORIGINAL_PROPOSAL_ISOLATION_REQUIRED");});
const timestamp=service._test.parseOriginalTimestamp;
test("explicit offset is converted to the Manila date across UTC midnight",()=>{assert.equal(timestamp("2026:11:11 18:00:00","+00:00","2026-11-12",new Date("2026-11-12T05:00:00Z")).toISOString(),"2026-11-11T18:00:00.000Z");});
for(const [label,time,offset,date,code]of [
 ["missing",null,"+08:00","2026-11-12","ORIGINAL_TIMESTAMP_MISSING"],
 ["invalid","bad","+08:00","2026-11-12","ORIGINAL_TIMESTAMP_INVALID"],
 ["calendar rollover","2026:02:30 08:00:00","+08:00","2026-11-12","ORIGINAL_TIMESTAMP_INVALID"],
 ["naive","2026:11:12 08:00:00",null,"2026-11-12","ORIGINAL_TIMEZONE_REQUIRED"],
 ["invalid offset","2026:11:12 08:00:00","+14:30","2026-11-12","ORIGINAL_TIMEZONE_REQUIRED"],
 ["unknown offset","2026:11:12 08:00:00","-00:00","2026-11-12","ORIGINAL_TIMEZONE_REQUIRED"],
 ["future","2026:11:12 23:00:00","+08:00","2026-11-12","ORIGINAL_TIMESTAMP_FUTURE"],
 ["wrong day","2026:11:11 08:00:00","+08:00","2026-11-12","ORIGINAL_MONITORING_DATE_MISMATCH"]])test(`timestamp rejects ${label}`,()=>assert.throws(()=>timestamp(time,offset,date,new Date("2026-11-12T05:00:00Z")),e=>e.code===code));
const context={dateMonitored:"2026-11-12",site:{latitude:12.662301,longitude:123.932983,coverageRadiusMeters:50}};
const inspect=(buffer)=>service._test.inspectOriginal({buffer,originalname:"fixture.jpg",mimetype:"image/jpeg"},context,new Date("2026-11-12T05:00:00Z"));
for(const [label,options,code]of [
 ["GPS missing",{latitude:null},"ORIGINAL_GPS_INVALID"],
 ["original time missing (digitized is not a substitute)",{time:null,digitized:"2026:11:12 08:00:00"},"ORIGINAL_TIMESTAMP_MISSING"],
 ["offset missing",{offset:null},"ORIGINAL_TIMEZONE_REQUIRED"],
 ["outside site",{accuracy:5,latitude:12.663301},"ORIGINAL_OUTSIDE_SITE"],
 ["screenshot metadata",{software:"Windows Snipping Tool"},"ORIGINAL_METADATA_SUSPICIOUS"]])test(`actual synthetic JPEG rejection: ${label}`,async()=>assert.rejects(()=>rejectedOriginal(options).then(inspect),e=>e.code===code));
test("format checks use actual decoded bytes, not MIME or extension",async()=>{await assert.rejects(()=>inspect(Buffer.from("not an image")),e=>e.code==="ORIGINAL_FORMAT_UNSUPPORTED");const png=await sharp({create:{width:4,height:4,channels:3,background:"green"}}).png().toBuffer();await assert.rejects(()=>inspect(png),e=>e.code==="ORIGINAL_FORMAT_UNSUPPORTED");});
test("original proposal never converts absent, DOP or string accuracy into trusted meters",()=>{for(const v of [null,undefined,"",NaN,-1,"5"])assert.equal(service._test.reportedAccuracy({GPSHPositioningError:v}),null);});
for(const [label,options] of [["absent",{}],["DOP",{dop:5}],["reported 51 m",{accuracy:51}],["claimed 5 m",{accuracy:5}],["claimed zero",{accuracy:0}]])test(`original ${label} accuracy remains Unknown and needs review`,async()=>{const result=await inspect(await rejectedOriginal(options));assert.equal(result.location.accuracyMeters,null);assert.equal(result.accuracyStatus,"UNKNOWN");assert.equal(result.verificationStatus,"NEEDS_ADMIN_REVIEW");assert.equal(result.source,"uploaded-original");});
const priorEnv={};test.before(()=>{for(const [k,v]of Object.entries(env())){priorEnv[k]=process.env[k];process.env[k]=v;}});test.after(()=>{for(const[k,v]of Object.entries(priorEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
function seed(){rows.clear();reads=0;rows.set("sampleMonitoringVisits/visit",{createdBy:"staff",siteId:"site",cohortId:"cohort",status:"DRAFT",version:0,baselineVersion:1,samplingPlanVersion:1,dateMonitored:"2026-11-12",sampleAssessments:[{sampleId:"TREE-001",assessmentRevision:0}]});rows.set("verifiedPlantingCohorts/cohort",{source:{siteId:"site"},samplingPlan:{status:"APPROVED",version:1},baselineVersion:1,baseline:{approvalStatus:"APPROVED",sampleUnits:[{permanentId:"TREE-001"}]}});rows.set("sites/site",context.site);}
const request=async()=>({actorId:"staff",actorRole:"staff",visitId:"visit",sampleId:"TREE-001",input:{source:"uploaded-original",expectedVisitVersion:"0",assessmentRevision:"0"},idempotencyKey:"unit-original-key",files:[{buffer:await rejectedOriginal(),originalname:"original.jpg"}]});
test("authoritative source/tree/version binding rejects before creating any evidence",async()=>{seed();const input=await request();for(const [patch,code]of [[{actorRole:"participant"},"ORIGINAL_FORBIDDEN"],[{actorId:"other"},"ORIGINAL_TARGET_UNAVAILABLE"],[{sampleId:"TREE-002"},"ORIGINAL_TARGET_UNAVAILABLE"],[{input:{...input.input,expectedVisitVersion:1}},"ORIGINAL_BINDING_STALE"],[{input:{...input.input,assessmentRevision:1}},"ORIGINAL_BINDING_STALE"],[{input:{...input.input,source:"browser-camera"}},"ORIGINAL_SOURCE_REQUIRED"],[{input:{...input.input,accuracy:5}},"ORIGINAL_CLIENT_METADATA_FORBIDDEN"],[{input:{...input.input,reuseEvidence:"old"}},"ORIGINAL_REUSE_UNSUPPORTED"]])await assert.rejects(()=>service.verifyOriginal({...input,...patch}),e=>e.code===code);assert.equal(rows.size,3);});
test("duplicate bytes are rejected without reservations, sessions or writes",async()=>{seed();const input=await request();rows.set("sampleMonitoringEvidenceHashes/"+images.generateImageHash(input.files[0].buffer),{visitId:"owned-fixture"});await assert.rejects(()=>service.verifyOriginal(input),e=>e.code==="ORIGINAL_DUPLICATE");assert.equal(rows.size,4);});


test("proposal cannot bypass the existing cohort feature gate",async()=>{seed();const input=await request();process.env.VERIFIED_PLANTING_COHORT_ENABLED="false";try{await assert.rejects(()=>service.verifyOriginal(input),e=>e.code==="COHORT_WORKFLOW_DISABLED");assert.equal(reads,0);}finally{process.env.VERIFIED_PLANTING_COHORT_ENABLED="true";}});
test("missing actual date and inactive sites remain blocked without evidence mutations",async()=>{seed();const input=await request();delete rows.get("sampleMonitoringVisits/visit").dateMonitored;await assert.rejects(()=>service.verifyOriginal(input),e=>e.code==="ORIGINAL_MONITORING_DATE_REQUIRED");seed();rows.get("sites/site").status="Inactive";await assert.rejects(()=>service.verifyOriginal(input),e=>e.code==="ORIGINAL_SITE_INACTIVE");assert.equal(rows.size,3);});

const relevance=require("../src/services/sampleMonitoringOriginalEvidence");
test("unchanged originals require exact Admin acknowledgment without mutating history",()=>{
 const row={sampleId:"TREE-001",condition:"Healthy",remarks:"same",assessmentRevision:0};
 row.evidenceHistory=[{source:"uploaded-original",evidenceId:"evidence",revision:0,assessmentFingerprint:relevance.assessmentFingerprint(row,"2026-11-12"),privateEvidence:{},accuracyStatus:"UNKNOWN",verificationStatus:"NEEDS_ADMIN_REVIEW"}];
 const visit={dateMonitored:"2026-11-12",sampleAssessments:[row]},original=JSON.stringify(visit),required=relevance.reviewRequirements(visit);
 assert.equal(required.length,1);assert.throws(()=>relevance.assertOriginalReview(visit,[]),e=>e.code==="ORIGINAL_ADMIN_REVIEW_REQUIRED");assert.deepEqual(relevance.assertOriginalReview(visit,required),required);assert.equal(JSON.stringify(visit),original);
 for(const change of [{remarks:"different"},{condition:"Damaged"},{assessmentRevision:1}])assert.throws(()=>relevance.reviewRequirements({...visit,sampleAssessments:[{...row,...change}]}),e=>e.code==="ORIGINAL_REPLACEMENT_REQUIRED");
 assert.throws(()=>relevance.reviewRequirements({...visit,dateMonitored:"2026-11-11"}),e=>e.code==="ORIGINAL_REPLACEMENT_REQUIRED");
 assert.deepEqual(relevance.reviewRequirements({sampleAssessments:[{sampleId:"TREE-001",evidenceHistory:[]}]}),[]);
});
