const test=require("node:test"),assert=require("node:assert/strict");
const tables=new Map(),table=n=>tables.get(n)||(tables.set(n,new Map()),tables.get(n));const ref=(c,id)=>({id,collectionName:c,get:async()=>{const v=table(c).get(id);return{id,exists:v!==undefined,data:()=>v,ref:ref(c,id)}}});const db={collection:c=>{const filters=[],orders=[];let max=Infinity,cursor=null;const query={doc:id=>ref(c,id),where:(field,operator,value)=>{filters.push([field,operator,value]);return query},orderBy:(field,direction="asc")=>{orders.push([field,direction]);return query},limit:value=>{max=Number(value);return query},startAfter:doc=>{cursor=doc.id;return query},get:async()=>{let rows=[...table(c)].filter(([,v])=>filters.every(([f,o,x])=>o==="=="&&v[f]===x));rows.sort((a,b)=>{for(const [field,direction] of orders){const av=field==="__name__"?a[0]:a[1][field],bv=field==="__name__"?b[0]:b[1][field];const cmp=String(av??"").localeCompare(String(bv??""));if(cmp)return direction==="desc"?-cmp:cmp}return 0});if(cursor){const at=rows.findIndex(([id])=>id===cursor);rows=at<0?[]:rows.slice(at+1)}return{docs:rows.slice(0,max).map(([id,v])=>({id,data:()=>v,ref:ref(c,id)})),empty:rows.length===0}}};return query},runTransaction:async fn=>{const w=[],tx={get:r=>r.get(),create:(r,v)=>w.push([r,v,false]),update:(r,v)=>w.push([r,v,true])};await fn(tx);w.forEach(([r,v,u])=>table(r.collectionName).set(r.id,u?{...table(r.collectionName).get(r.id),...v}:v));}};
let enabled=true,provisionalAllowed=true;const fp=require.resolve("../src/config/firebase"),cp=require.resolve("../src/config/verifiedPlantingCohort");require.cache[fp]={exports:{db}};require.cache[cp]={exports:{resolveVerifiedPlantingCohortConfig:()=>({enabled,provisionalSamplingAllowed:provisionalAllowed,provisionalSamplingPolicy:"test-only-ceil-10-percent-min-1-v1"})}};const s=require("../src/services/sampleMonitoringVisit.service");
function seed(){tables.clear();enabled=true;table("verifiedPlantingCohorts").set("c",{source:{siteId:"site"},samplingPlan:{status:"APPROVED",version:1},baseline:{approvalStatus:"APPROVED",sampleUnits:[{permanentId:"TREE-001"},{permanentId:"TREE-002"}]}})}
test("permanent samples submit unresolved visits and derive non-biological summaries",async()=>{seed();const v=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2030-01-01",testOnly:true});const saved=await s.save({actorRole:"staff",visitId:v.id,actorId:"staff",expectedVersion:0,submit:true,assessments:[{sampleId:"TREE-001",condition:"Healthy"},{sampleId:"TREE-002",condition:"Needs Rechecking",remarks:"Search deferred",recheckReason:"Tag not found"}]});assert.equal(saved.status,"PENDING_ADMIN_APPROVAL");assert.deepEqual(saved.summary,{healthy:1,damaged:0,dead:0,needsRechecking:1,unassessed:0,total:2,assessed:2,resolved:1,incomplete:1,living:1,complete:false,confirmedDead:0,notAssessed:0,completed:2,survivalRate:null,survivalStatus:"PENDING_INCOMPLETE",growth:{baselineOnly:false,heightDifferences:0,stemDiameterDifferences:0,measurementDecreased:0,growthPerformance:{},growthStage:{},stageAdvancements:null,criteriaVersion:"growth-criteria-pending-v1"}});assert.deepEqual(saved.recheckQueue,["TREE-002"]);assert.equal(saved.officialKpiEligible,false);});
test("rejects silent replacement, stale write, invalid outcome, and disabled gate",async()=>{seed();const v=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2030-01-01",testOnly:true});await assert.rejects(()=>s.save({actorRole:"staff",visitId:v.id,actorId:"staff",expectedVersion:0,assessments:[{sampleId:"TREE-001",condition:"Dead"},{sampleId:"TREE-001",condition:"Healthy"}]}));await assert.rejects(()=>s.save({actorRole:"staff",visitId:v.id,actorId:"staff",expectedVersion:0,assessments:[{sampleId:"TREE-001",condition:"Healthy",investigationOutcome:"Not Located After Rechecking"},{sampleId:"TREE-002",condition:"Dead"}]}));enabled=false;await assert.rejects(()=>s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2030-01-02",testOnly:true}));});
test("next scheduled visit retains all IDs and carries only approved unresolved samples",async()=>{seed();table("sampleMonitoringVisits").set("prior",{cohortId:"c",siteId:"site",samplingPlanVersion:1,baselineVersion:0,visitDate:"2030-01-01",status:"APPROVED",sampleAssessments:[{sampleId:"TREE-001",condition:"Needs Rechecking",remarks:"Search again",recheckQueued:true},{sampleId:"TREE-002",condition:"Healthy"}]});const next=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2030-02-01",testOnly:true});assert.equal(next.sampleAssessments.length,2);assert.equal(next.sampleAssessments.find(x=>x.sampleId==="TREE-001").recheckRequired,true);assert.equal(next.sampleAssessments.find(x=>x.sampleId==="TREE-002").recheckRequired,false);assert.equal(next.priorVisitId,"prior");});
test("rejects ambiguous same-date approved history and excludes returned history",async()=>{seed();const base={cohortId:"c",siteId:"site",samplingPlanVersion:1,baselineVersion:0,visitDate:"2030-01-01",sampleAssessments:[{sampleId:"TREE-001",condition:"Needs Rechecking",remarks:"x",recheckQueued:true}]};table("sampleMonitoringVisits").set("returned",{...base,status:"RETURNED"});assert.equal(await s._test.priorApprovedVisit("c","site",1,0,"2030-02-01"),null);await assert.rejects(()=>s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2030-02-01",testOnly:true}),error=>error.code==="OPEN_VISIT_EXISTS");table("sampleMonitoringVisits").clear();table("sampleMonitoringVisits").set("a",{...base,status:"APPROVED"});table("sampleMonitoringVisits").set("b",{...base,status:"APPROVED"});await assert.rejects(()=>s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2030-02-01",testOnly:true}),/Ambiguous/);});
test("draft saves retain authoritative evidence history and ignore forged client history",async()=>{seed();const v=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2030-01-01",testOnly:true});const row=table("sampleMonitoringVisits").get(v.id);row.sampleAssessments[0].evidenceHistory=[{revision:0,privateEvidence:{objectName:"authoritative"}}];row.sampleAssessments[1].evidenceHistory=[{revision:0,privateEvidence:{objectName:"unchanged"}}];const saved=await s.save({actorRole:"staff",visitId:v.id,actorId:"staff",expectedVersion:0,assessments:[{sampleId:"TREE-001",condition:"Healthy",evidenceHistory:[]},{sampleId:"TREE-002",condition:"Damaged",evidenceHistory:[{privateEvidence:{objectName:"forged"}}]}]});assert.equal(saved.sampleAssessments[0].evidenceHistory[0].privateEvidence.objectName,"authoritative");assert.equal(saved.sampleAssessments[1].evidenceHistory[0].privateEvidence.objectName,"unchanged");});
test("returned correction advances only the changed sample revision once",async()=>{seed();const v=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2030-01-01",testOnly:true});let row=table("sampleMonitoringVisits").get(v.id);row.status="RETURNED";row.version=1;row.sampleAssessments[0]={...row.sampleAssessments[0],condition:"Healthy",assessmentRevision:0,evidenceHistory:[{revision:0}]};row.sampleAssessments[1]={...row.sampleAssessments[1],condition:"Healthy",assessmentRevision:0,evidenceHistory:[{revision:0}]};let saved=await s.save({actorRole:"staff",visitId:v.id,actorId:"staff",expectedVersion:1,assessments:[{sampleId:"TREE-001",condition:"Damaged"},{sampleId:"TREE-002",condition:"Healthy"}]});assert.equal(saved.sampleAssessments[0].assessmentRevision,1);assert.equal(saved.sampleAssessments[1].assessmentRevision,0);assert.equal(saved.sampleAssessments[0].evidenceHistory.length,1);saved=await s.save({actorRole:"staff",visitId:v.id,actorId:"staff",expectedVersion:2,assessments:[{sampleId:"TREE-001",condition:"Damaged"},{sampleId:"TREE-002",condition:"Healthy"}]});assert.equal(saved.sampleAssessments[0].assessmentRevision,1);});
test("discovery scopes staff visits, orders pages, filters status, and derives actions without evidence leakage",async()=>{seed();table("sampleMonitoringVisits").set("a",{createdBy:"staff",cohortId:"c",siteId:"site",visitDate:"2030-01-03",status:"DRAFT",version:1,sampleAssessments:[{sampleId:"TREE-001",condition:"Healthy",evidenceHistory:[{privateEvidence:{objectName:"secret"}}]}]});table("sampleMonitoringVisits").set("b",{createdBy:"staff",cohortId:"c",siteId:"site",visitDate:"2030-01-02",status:"RETURNED",version:2,sampleAssessments:[{sampleId:"TREE-001",condition:null}]});table("sampleMonitoringVisits").set("other",{createdBy:"other",cohortId:"c",siteId:"site",visitDate:"2030-01-04",status:"PENDING_ADMIN_APPROVAL",version:1,sampleAssessments:[{sampleId:"TREE-001",condition:"Dead"}]});const first=await s.list({actorId:"staff",actorRole:"staff",limit:1});assert.deepEqual(first.visits.map(v=>v.id),["a"]);assert.equal(first.visits[0].actions.saveDraft,true);assert.equal(JSON.stringify(first).includes("secret"),false);const second=await s.list({actorId:"staff",actorRole:"staff",limit:1,cursor:first.nextCursor});assert.deepEqual(second.visits.map(v=>v.id),["b"]);assert.equal(second.nextCursor,null);const returned=await s.list({actorId:"staff",actorRole:"staff",status:"RETURNED",limit:50});assert.deepEqual(returned.visits.map(v=>v.id),["b"]);const admin=await s.list({actorId:"admin",actorRole:"admin",limit:50});assert.deepEqual(admin.visits.map(v=>v.id),["other","a","b"]);assert.equal(admin.visits[0].actions.review,true);await assert.rejects(()=>s.list({actorId:"staff",actorRole:"staff",cursor:"other"}),e=>e.status===400);enabled=false;await assert.rejects(()=>s.list({actorId:"staff",actorRole:"staff"}),e=>e.code==="COHORT_WORKFLOW_DISABLED");});
test("detail hides non-owner visits while allowing owner Staff and Admin",async()=>{seed();table("sampleMonitoringVisits").set("owned",{createdBy:"staff",sampleAssessments:[{sampleId:"TREE-001",evidenceHistory:[{revision:0}]}]});assert.equal((await s.get("owned",{actorId:"staff",actorRole:"staff"})).id,"owned");assert.equal((await s.get("owned",{actorId:"admin",actorRole:"admin"})).id,"owned");await assert.rejects(()=>s.get("owned",{actorId:"other",actorRole:"staff"}),e=>e.status===404);await assert.rejects(()=>s.get("missing",{actorId:"staff",actorRole:"staff"}),e=>e.status===404);});


test("partial draft keeps unassessed trees separate and persists bounded visit remarks without allowing incomplete submission", async () => {
  seed(); const visit=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2026-11-01",testOnly:true});
  const assessments=[{sampleId:"TREE-001",condition:"Healthy",heightCentimeters:"120.5"},{sampleId:"TREE-002",condition:"",heightCentimeters:""}];
  const draft=await s.save({actorRole:"staff",visitId:visit.id,actorId:"staff",expectedVersion:0,assessments,visitRemarks:"  Field notes  "});
  assert.equal(draft.status,"DRAFT"); assert.equal(draft.sampleAssessments[1].condition,null); assert.equal(draft.summary.needsRechecking,0);
  assert.equal(draft.visitRemarks,"Field notes");assert.equal(draft.history[0].visitRemarks,"Field notes");
  await assert.rejects(s.save({actorRole:"staff",visitId:visit.id,actorId:"staff",expectedVersion:1,assessments,submit:true}));
  assert.equal((await s.get(visit.id)).version,1);
});
test("negative and nonfinite measurements and overlong visit remarks are rejected before persistence", async () => {
  seed(); const visit=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2026-11-01",testOnly:true});
  for(const value of [-1,Infinity,"NaN","12 cm"]) await assert.rejects(s.save({actorRole:"staff",visitId:visit.id,actorId:"staff",expectedVersion:0,assessments:[{sampleId:"TREE-001",condition:"Healthy",heightCentimeters:value},{sampleId:"TREE-002",condition:"Dead"}]}));
  await assert.rejects(s.save({actorRole:"staff",visitId:visit.id,actorId:"staff",expectedVersion:0,assessments:[],visitRemarks:"a".repeat(1001)}));
  assert.equal((await s.get(visit.id)).version,0);
});
test("authorized display context returns actual report, baseline and prior measurements without private transport metadata", async () => {
  seed(); const cohort=table("verifiedPlantingCohorts").get("c"); cohort.source.plantingReportId="report";cohort.verifiedPlantedQuantity=20;cohort.samplingPlan.selectedSamples=[{permanentId:"TREE-001",species:"Narra"},{permanentId:"TREE-002",species:"Molave"}];
  cohort.baseline.sampleUnits[0]={permanentId:"TREE-001",heightMeters:1.2,latitude:12.65,longitude:123.91,photoReferences:[{evidenceId:"private-test"}]};
  table("sites").set("site",{siteName:"Authoritative site",barangay:"Bical",latitude:12.65,longitude:123.91});
  table("plantingReports").set("report",{reportNumber:"RPT-TEST",verificationStatus:"Approved",plantingDate:"2026-10-01"});
  const prior=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2026-10-30",testOnly:true});
  table("sampleMonitoringVisits").set(prior.id,{...prior,status:"APPROVED",sampleAssessments:[{sampleId:"TREE-001",condition:"Healthy",heightCentimeters:125,evidenceHistory:[{revision:0,privateEvidence:{objectName:"DO-NOT-EXPOSE"},captureSessionId:"SECRET"}]}]});
  const visit=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2026-11-01",testOnly:true}); const context=(await s.get(visit.id,{actorId:"staff",actorRole:"staff"})).visitContext;
  assert.equal(context.reportNumber,"RPT-TEST");assert.equal(context.siteName,"Authoritative site");assert.equal(context.approvedSampleTarget,2);assert.equal(context.samples[0].baseline.heightCentimeters,120);assert.equal(context.samples[0].previous.heightCentimeters,125);
  assert.doesNotMatch(JSON.stringify(context),/DO-NOT-EXPOSE|SECRET|privateEvidence|objectName/);
});

test("actual assessment date persists without changing scheduled visitDate and rejects invalid or future dates",async()=>{
 seed();const visit=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2030-01-01",testOnly:true});
 const input={visitId:visit.id,actorId:"staff",actorRole:"staff",expectedVersion:0,assessments:[{sampleId:"TREE-001",condition:"Healthy"},{sampleId:"TREE-002",condition:null}]};
 for(const dateMonitored of ["2099-01-01","2026-02-30","invalid",null])await assert.rejects(()=>s.save({...input,dateMonitored}),{status:400});
 const saved=await s.save({...input,dateMonitored:"2026-11-01"});assert.equal(saved.dateMonitored,"2026-11-01");assert.equal(saved.visitDate,"2030-01-01");assert.equal(saved.history.at(-1).dateMonitored,"2026-11-01");
});

test("optional legacy display geometry does not break authorized history or invent an unknown sample target",async()=>{
 seed();table("sites").set("site",{siteName:"Legacy site",polygon:[null,{lat:12.65,lng:123.91}]});const visit=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2026-11-01",testOnly:true});const context=(await s.get(visit.id,{actorId:"staff",actorRole:"staff"})).visitContext;assert.equal(context.approvedSampleTarget,null);assert.deepEqual(context.site.polygon,[{lat:12.65,lng:123.91}]);assert.equal(context.registeredSampleTrees,2);
});
test("display context lists authoritative species quantities and never invents unknown planted counts", async () => {
  seed(); const cohort=table("verifiedPlantingCohorts").get("c");
  cohort.source.species=[{inventoryId:"inv-1",species:"Narra",releasedQuantity:40,verifiedPlantedQuantity:30},{inventoryId:"inv-2",species:"Molave",releasedQuantity:12},{inventoryId:"inv-3",species:"  ",verifiedPlantedQuantity:5},{species:"Bad",verifiedPlantedQuantity:-3}];
  const visit=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2026-11-01",testOnly:true});
  const context=(await s.get(visit.id,{actorId:"staff",actorRole:"staff"})).visitContext;
  assert.deepEqual(context.speciesQuantities,[{species:"Narra",verifiedPlantedQuantity:30},{species:"Molave",verifiedPlantedQuantity:null},{species:"Bad",verifiedPlantedQuantity:null}]);
  assert.doesNotMatch(JSON.stringify(context.speciesQuantities),/inventoryId|releasedQuantity|inv-/);
  seed(); const legacy=await s.create({actorRole:"staff",cohortId:"c",actorId:"staff",visitDate:"2026-11-02",testOnly:true});
  assert.deepEqual((await s.get(legacy.id,{actorId:"staff",actorRole:"staff"})).visitContext.speciesQuantities,[]);
});
test("T4: only one open visit per cohort; an Admin-approved visit allows the next one and same-date retry stays idempotent", async () => {
  seed();
  const first = await s.create({actorRole:"staff", cohortId: "c", actorId: "staff", visitDate: "2031-01-01", testOnly: true });
  const retry = await s.create({actorRole:"staff", cohortId: "c", actorId: "staff", visitDate: "2031-01-01", testOnly: true });
  assert.equal(retry.id, first.id);
  await assert.rejects(() => s.create({actorRole:"staff", cohortId: "c", actorId: "other-staff", visitDate: "2031-01-01", testOnly: true }),
    error => error.code === "OPEN_VISIT_EXISTS" && error.status === 409);
  for (const status of ["DRAFT", "RETURNED", "PENDING_ADMIN_APPROVAL"]) {
    table("sampleMonitoringVisits").set(first.id, { ...table("sampleMonitoringVisits").get(first.id), status });
    await assert.rejects(() => s.create({actorRole:"staff", cohortId: "c", actorId: "other-staff", visitDate: "2031-02-01", testOnly: true }), error => error.code === "OPEN_VISIT_EXISTS" && error.status === 409);
  }
  assert.equal([...table("sampleMonitoringVisits").keys()].length, 1);
  table("sampleMonitoringVisits").set(first.id, { ...table("sampleMonitoringVisits").get(first.id), status: "APPROVED" });
  const next = await s.create({actorRole:"staff", cohortId: "c", actorId: "staff", visitDate: "2031-02-01", testOnly: true });
  assert.notEqual(next.id, first.id);
  assert.equal(table("verifiedPlantingCohorts").get("c").monitoringVisitCreation.lastVisitId, next.id);
});
test("T3: outside test mode a cohort with a test-only plan or no policy snapshot cannot start a visit", async () => {
  seed(); provisionalAllowed = false;
  try {
    await assert.rejects(() => s.create({actorRole:"staff", cohortId: "c", actorId: "staff", visitDate: "2031-03-01", testOnly: true }), error => error.code === "TEST_ONLY_SAMPLING_POLICY_REJECTED");
    assert.equal(table("sampleMonitoringVisits").size, 0);
  } finally { provisionalAllowed = true; }
});
test("production visit creation stays blocked until MENRO approves scheduling", async () => {
  seed();
  await assert.rejects(() => s.create({actorRole:"staff", cohortId: "c", actorId: "staff", visitDate: "2031-04-01" }), /Future visit scheduling requires MENRO policy approval/);
  assert.equal(table("sampleMonitoringVisits").size, 0);
});
test("T6: readiness explains every blocker, never names other Staff and refuses other roles", async () => {
  seed();
  const c = table("verifiedPlantingCohorts").get("c");
  c.source = { ...c.source, plantingReportId: "report", plantingDate: "2026-10-01" };
  table("sites").set("site", { siteName: "Readiness site" });
  table("plantingReports").set("report", { reportNumber: "RPT-READY" });
  table("verifiedPlantingCohorts").set("pending", { source: { siteId: "site" }, verifiedPlantedQuantity: 40, samplingPolicySnapshot: { percentage: 10, minimum: null, policyVersion: 1 }, samplingPlan: { status: "DRAFT" }, baseline: { approvalStatus: "REGISTERED" } });
  table("sampleMonitoringVisits").set("open", { cohortId: "c", status: "RETURNED", createdBy: "someone-else" });
  const data = await s.readiness({ actorId: "staff", actorRole: "staff" });
  assert.equal(data.visitCreationAvailable, false); assert.equal(data.schedulingPolicyStatus, "PENDING_MENRO_APPROVAL");
  const ready = data.cohorts.find(row => row.cohortId === "c"), pending = data.cohorts.find(row => row.cohortId === "pending");
  assert.equal(ready.reportNumber, "RPT-READY"); assert.equal(ready.siteName, "Readiness site"); assert.equal(ready.canCreateVisit, false);
  assert.deepEqual(ready.reasons.map(r => r.code), ["OPEN_VISIT_EXISTS", "VISIT_SCHEDULING_POLICY_PENDING"]);
  assert.deepEqual(ready.reasons[0], { code: "OPEN_VISIT_EXISTS", visitStatus: "RETURNED", ownedByYou: false });
  assert.deepEqual(pending.reasons.map(r => r.code), ["SAMPLING_POLICY_PENDING", "SAMPLING_PLAN_NOT_APPROVED", "BASELINE_NOT_APPROVED", "VISIT_SCHEDULING_POLICY_PENDING"]);
  assert.ok(pending.reasons[0].pending.includes("MINIMUM_SAMPLE_POLICY_PENDING"));
  assert.doesNotMatch(JSON.stringify(data), /someone-else|privateEvidence|createdBy/);
  provisionalAllowed = false;
  try { assert.ok((await s.readiness({ actorId: "staff", actorRole: "admin" })).cohorts.find(row => row.cohortId === "c").reasons.some(r => r.code === "SAMPLING_POLICY_SNAPSHOT_MISSING")); }
  finally { provisionalAllowed = true; }
  await assert.rejects(() => s.readiness({ actorId: "p", actorRole: "participant" }), error => error.status === 403);
  assert.equal(table("sampleMonitoringVisits").size, 1);
});
test("Admin and Participant roles can never create, save or submit a visit, even when calling the service",async()=>{seed();
  for(const actorRole of ["admin","participant"]){
    await assert.rejects(()=>s.create({cohortId:"c",actorId:"x",actorRole,visitDate:"2030-01-01",testOnly:true}),e=>e.status===403&&e.code==="MONITORING_ACTION_FORBIDDEN");
  }
  assert.equal(table("sampleMonitoringVisits").size,0);
  const v=await s.create({cohortId:"c",actorId:"staff",actorRole:"staff",visitDate:"2030-01-01",testOnly:true});
  for(const actorRole of ["admin","participant"]){
    await assert.rejects(()=>s.save({visitId:v.id,actorId:"staff",actorRole,expectedVersion:0,submit:true,assessments:[{sampleId:"TREE-001",condition:"Healthy"},{sampleId:"TREE-002",condition:"Healthy"}]}),e=>e.status===403);
  }
  assert.equal(table("sampleMonitoringVisits").get(v.id).status,"DRAFT");
  assert.equal((await s.save({visitId:v.id,actorId:"staff",actorRole:"staff",expectedVersion:0,submit:false,assessments:[{sampleId:"TREE-001",condition:"Healthy"},{sampleId:"TREE-002",condition:"Healthy"}]})).status,"DRAFT");
});
test("a service call without an actor role is refused before any visit write",async()=>{seed();
  await assert.rejects(()=>s.create({cohortId:"c",actorId:"staff",visitDate:"2030-01-01",testOnly:true}),e=>e.status===403&&e.code==="MONITORING_ACTION_FORBIDDEN");
  assert.equal(table("sampleMonitoringVisits").size,0);
  const v=await s.create({cohortId:"c",actorId:"staff",actorRole:"staff",visitDate:"2030-01-01",testOnly:true});
  await assert.rejects(()=>s.save({visitId:v.id,actorId:"staff",expectedVersion:0,submit:true,assessments:[{sampleId:"TREE-001",condition:"Healthy"},{sampleId:"TREE-002",condition:"Healthy"}]}),e=>e.status===403);
  assert.equal(table("sampleMonitoringVisits").get(v.id).status,"DRAFT");assert.equal(table("sampleMonitoringVisits").get(v.id).version,0);
});

test("Admin list adds only display labels to submitted visits; drafts and Staff lists get no lookups",async()=>{
 seed();table("verifiedPlantingCohorts").get("c").source.plantingReportId="report";
 table("sites").set("site",{siteName:"Bical Site",barangay:"Bical",ownerEmail:"site@private.test"});
 table("plantingReports").set("report",{reportNumber:"RPT-2026-001"});
 table("users").set("staff-a",{fullName:"Ana Staff",email:"ana@private.test",role:"staff",contactNumber:"0999"});
 table("sampleMonitoringVisits").set("pending",{createdBy:"staff-a",cohortId:"c",siteId:"site",visitDate:"2030-01-05",dateMonitored:"2026-11-02",status:"PENDING_ADMIN_APPROVAL",version:2,sampleAssessments:[{sampleId:"TREE-001",condition:"Healthy"}]});
 table("sampleMonitoringVisits").set("returned",{createdBy:"missing-user",cohortId:"gone",siteId:"site",visitDate:"2030-01-04",status:"RETURNED",version:3,sampleAssessments:[]});
 table("sampleMonitoringVisits").set("draft",{createdBy:"draft-user",cohortId:"c",siteId:"site",visitDate:"2030-01-03",status:"DRAFT",version:1,sampleAssessments:[]});
 const reads=[];const original=db.collection;db.collection=c=>{const q=original(c);const doc=q.doc;q.doc=id=>{reads.push(c+"/"+id);return doc(id)};return q};
 let admin,plain;try{admin=await s.list({actorId:"admin",actorRole:"admin",limit:50,labels:true});}finally{db.collection=original;}
 // Without labels=1 (e.g. the visit picker) the Admin list makes no label lookups and returns no labels.
 const before=reads.length;db.collection=c=>{const q=original(c);const doc=q.doc;q.doc=id=>{reads.push(c+"/"+id);return doc(id)};return q};
 try{plain=await s.list({actorId:"admin",actorRole:"admin",limit:50});}finally{db.collection=original;}
 assert.equal(reads.slice(before).some(r=>/^(users|sites|plantingReports|verifiedPlantingCohorts)\//.test(r)),false);
 assert.equal(plain.visits.some(v=>"submittedByName" in v||"siteName" in v),false);assert.equal("labelsIncomplete" in plain,false);
 const row=id=>admin.visits.find(v=>v.id===id);
 assert.deepEqual([row("pending").submittedByName,row("pending").reportNumber,row("pending").siteName,row("pending").barangay,row("pending").dateMonitored],["Ana Staff","RPT-2026-001","Bical Site","Bical","2026-11-02"]);
 assert.equal(row("pending").actions.review,true);assert.equal(row("pending").actions.saveDraft,false);assert.equal(row("pending").actions.submit,false);
 assert.deepEqual([row("returned").submittedByName,row("returned").reportNumber,row("returned").siteName,row("returned").dateMonitored],["MENRO Staff",null,null,null]);
 assert.equal("submittedByName" in row("draft"),false);assert.equal(reads.includes("users/draft-user"),false);
 assert.equal(reads.filter(r=>r==="users/staff-a").length,1);assert.equal(reads.filter(r=>r==="verifiedPlantingCohorts/c").length,1);
 assert.equal(admin.writesPaused,false);assert.equal(admin.labelsIncomplete,false);
 assert.doesNotMatch(JSON.stringify(admin),/ana@private.test|site@private.test|0999|staff-a|missing-user|draft-user|createdBy/);
 const staff=await s.list({actorId:"staff-a",actorRole:"staff",limit:50});
 assert.deepEqual(staff.visits.map(v=>v.id),["pending"]);assert.equal("submittedByName" in staff.visits[0],false);assert.equal("siteName" in staff.visits[0],false);assert.equal(staff.visits[0].dateMonitored,"2026-11-02");
 await assert.rejects(()=>s.list({actorId:"person",actorRole:"participant"}),e=>e.status===403);
});
test("Admin list labels follow the visit form's site rule and never guess after a failed lookup",async()=>{
 seed();table("verifiedPlantingCohorts").get("c").source.plantingReportId="report";
 table("sites").set("site",{siteName:"Bical Site",barangay:"Bical"});table("sites").set("other-site",{siteName:"Other Site",barangay:"Other"});
 table("plantingReports").set("report",{reportNumber:"RPT-2026-001"});
 table("users").set("staff-a",{fullName:"Ana Staff"});table("users").set("staff-b",{fullName:"Ben Staff"});
 // Visit site differs from the cohort's source site: the form shows no context, so the row shows no labels.
 table("sampleMonitoringVisits").set("mismatch",{createdBy:"staff-a",cohortId:"c",siteId:"other-site",visitDate:"2030-01-05",status:"PENDING_ADMIN_APPROVAL",version:2,sampleAssessments:[]});
 table("sampleMonitoringVisits").set("ok",{createdBy:"staff-b",cohortId:"c",siteId:"site",visitDate:"2030-01-04",status:"APPROVED",version:3,sampleAssessments:[]});
 const mismatchContext=await require("../src/services/sampleMonitoringViewContext").monitoringContext(db,table("sampleMonitoringVisits").get("mismatch"));
 assert.equal(mismatchContext,null);
 const warnings=[],warn=console.warn;console.warn=message=>warnings.push(String(message));
 const original=db.collection;db.collection=c=>{const q=original(c);if(c!=="users")return q;const doc=q.doc;q.doc=id=>{const ref=doc(id);return id==="staff-b"?{...ref,get:async()=>{throw Object.assign(new Error("denied"),{code:"permission-denied"});}}:ref;};return q;};
 let admin;try{admin=await s.list({actorId:"admin",actorRole:"admin",limit:50,labels:true});}finally{db.collection=original;console.warn=warn;}
 const row=id=>admin.visits.find(v=>v.id===id);
 assert.deepEqual([row("mismatch").submittedByName,row("mismatch").reportNumber,row("mismatch").siteName,row("mismatch").barangay],["Ana Staff",null,null,null]);
 assert.deepEqual([row("ok").submittedByName,row("ok").reportNumber,row("ok").siteName],[null,"RPT-2026-001","Bical Site"]);
 assert.equal(admin.labelsIncomplete,true);
 assert.deepEqual(warnings,["[sample-monitoring] Admin list label lookup failed (users): permission-denied"]);
 assert.doesNotMatch(warnings.join(" "),/staff-b|Ben/);
});

test("active calendar policy enforces current evidence and advances the cohort schedule on Admin approval", async () => {
  const priorFlag = process.env.PERMANENT_SAMPLE_SCHEDULE_ENABLED;
  process.env.PERMANENT_SAMPLE_SCHEDULE_ENABLED = "true";
  try {
    seed();
    const today = require("../src/config/permanentSampleSchedule").dateOnlyInManila();
    const visit = await s.create({ actorRole: "staff", cohortId: "c", actorId: "staff", visitDate: today });
    assert.equal(visit.visitNumber, 1);
    assert.equal(visit.scheduledDueDate, today);
    assert.equal(visit.openingDate, today);
    assert.equal(visit.schedulePolicyVersion, "permanent-sample-calendar-v1");
    const assessments = [{ sampleId: "TREE-001", condition: "Healthy", heightCentimeters: 120, stemDiameterMillimeters: 12 },
      { sampleId: "TREE-002", condition: "Damaged", heightCentimeters: 80, stemDiameterMillimeters: 9 }];
    await assert.rejects(() => s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff",
      expectedVersion: 0, submit: true, dateMonitored: today, assessments }),
    error => error.code === "CURRENT_SAMPLE_EVIDENCE_REQUIRED" && error.missingSampleIds.length === 2);
    const stored = table("sampleMonitoringVisits").get(visit.id);
    stored.sampleAssessments.forEach(row => { row.evidenceHistory = [{ revision: 0, privateEvidence: { provider: "firebase" } }]; });
    const pending = await s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff",
      expectedVersion: 0, submit: true, dateMonitored: today, assessments });
    assert.equal(pending.summary.living, 2);
    assert.equal(pending.summary.unassessed, 0);
    assert.equal(pending.summary.complete, true);
    const approved = await s.review({ visitId: visit.id, actorId: "admin", expectedVersion: 1, approve: true });
    const next = require("../src/config/permanentSampleSchedule").addCalendarMonths(today, 1);
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.nextScheduledDueDate, next);
    assert.equal(table("verifiedPlantingCohorts").get("c").permanentSampleSchedule.nextScheduledDueDate, next);
    const readiness = await s.readiness({ actorId: "staff", actorRole: "staff" });
    assert.equal(readiness.schedulingPolicyStatus, "ACTIVE");
    assert.equal(readiness.cohorts[0].nextVisitNumber, 2);
    assert.equal(readiness.cohorts[0].nextScheduledDueDate, next);
    await assert.rejects(() => s.create({ actorRole: "staff", cohortId: "c", actorId: "staff", visitDate: next }),
      error => error.code === "VISIT_NOT_OPEN");
  } finally {
    if (priorFlag === undefined) delete process.env.PERMANENT_SAMPLE_SCHEDULE_ENABLED;
    else process.env.PERMANENT_SAMPLE_SCHEDULE_ENABLED = priorFlag;
  }
});

test("confirmed dead inheritance is accepted only from approved current evidence", () => {
  const prior = { id: "approved-1", status: "APPROVED", sampleAssessments: [{ sampleId: "TREE-001", condition: "Dead",
    assessmentRevision: 2, evidenceHistory: [{ revision: 2, privateEvidence: { provider: "firebase" } }] }] };
  const inherited = { sampleId: "TREE-001", condition: "Dead",
    inheritedConfirmedDead: { visitId: "approved-1", assessmentRevision: 2 } };
  assert.equal(s._test.inheritedDeadIsValid(inherited, prior), true);
  assert.equal(s._test.inheritedDeadIsValid({ ...inherited, condition: "Healthy" }, prior), false);
  assert.equal(s._test.inheritedDeadIsValid(inherited, { ...prior, status: "RETURNED" }), false);
});

test("growth deltas are derived only from measured prior values", () => {
  const prior = { sampleAssessments: [{ sampleId: "TREE-001", heightCentimeters: 100, diameterCentimeters: 4 }] };
  assert.deepEqual(s._test.withGrowth({ sampleId: "TREE-001", heightCentimeters: 112.5, diameterCentimeters: null }, prior).growthDelta,
    { heightCentimeters: 12.5, diameterCentimeters: null });
});

// ---- B3: first monitoring visit registers the baseline (PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED) ----
const schedule = require("../src/config/permanentSampleSchedule");
const FV_IDS = ["RPT-2026-020-T001", "RPT-2026-020-T002", "RPT-2026-020-T003"];
async function withEnv(vars, fn) {
  const prior = {};
  for (const [key, value] of Object.entries(vars)) { prior[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
const FLAG_ON = { PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: "true" };
function seedFirstVisit({ species = [{ inventoryId: "inv-1", species: "Narra", releasedQuantity: 25, verifiedPlantedQuantity: 25 }], report = {} } = {}) {
  seed();
  table("verifiedPlantingCohorts").set("fv", { source: { siteId: "site", plantingReportId: "rpt", plantingDate: "2026-10-01", species },
    verifiedPlantedQuantity: 25, baselineStatus: "NOT_STARTED", baselineVersion: 0, baseline: null });
  table("plantingReports").set("rpt", { reportNumber: "RPT-2026-020", verificationStatus: "Approved", quantityPlanted: 25, siteId: "site", ...report });
  table("sites").set("site", { siteName: "First Visit Site", barangay: "Bical", status: "active" });
}
const today = () => schedule.dateOnlyInManila();
const createFirst = (extra = {}) => s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: today(), testOnly: true, ...extra });
const fvAssessments = (overrides = {}) => FV_IDS.map(sampleId => ({ sampleId, condition: "Healthy", heightCentimeters: 120, diameterCentimeters: 1.2, ...(overrides[sampleId] || {}) }));
function attachEvidence(visitId, { gps = true, revision } = {}) {
  const row = table("sampleMonitoringVisits").get(visitId);
  row.sampleAssessments.forEach((assessment, index) => {
    assessment.evidenceHistory = [...(assessment.evidenceHistory || []), { revision: revision ?? Number(assessment.assessmentRevision || 0),
      privateEvidence: { objectName: `private-${index}` }, captureSessionId: `cap-${index}-${revision ?? 0}`, linkedAt: `${today()}T04:00:00.000Z`,
      ...(gps ? { location: { latitude: 13 + index / 1000, longitude: 124, accuracyMeters: 5 } } : {}) }];
  });
}
async function submitFirst(visit, { dateMonitored = today(), expectedVersion = visit.version } = {}) {
  return s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff", expectedVersion, submit: true, dateMonitored, assessments: fvAssessments() });
}

test("B3 flag off: a cohort with no plan or baseline keeps the legacy create and readiness errors", async () => {
  await withEnv({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: undefined }, async () => {
    seedFirstVisit();
    await assert.rejects(() => createFirst(), /Approved cohort, plan, and baseline are required/);
    assert.equal(table("sampleMonitoringVisits").size, 0);
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan, undefined);
    const data = await s.readiness({ actorId: "staff", actorRole: "staff" });
    const row = data.cohorts.find(r => r.cohortId === "fv");
    assert.deepEqual(row.reasons.map(r => r.code), ["SAMPLING_PLAN_NOT_APPROVED", "BASELINE_NOT_APPROVED", "FIRST_VISIT_POLICY_DISABLED", "VISIT_SCHEDULING_POLICY_PENDING"]);
    assert.equal("registersBaseline" in row, false);
  });
});

test("B3 create writes a DRAFT first-visit plan with 3 server Tree IDs and visit 1 that registers the baseline", async () => {
  await withEnv(FLAG_ON, async () => {
    seedFirstVisit();
    const visit = await createFirst();
    const cohort = table("verifiedPlantingCohorts").get("fv");
    assert.equal(cohort.samplingPlan.status, "DRAFT");
    assert.equal(cohort.samplingPlan.origin, "FIRST_VISIT");
    assert.equal(cohort.samplingPlan.provisionalTarget, 3);
    assert.deepEqual(cohort.samplingPlan.selectedSamples.map(x => x.permanentId), FV_IDS);
    assert.equal(cohort.samplingPlanHistory.length, 1);
    assert.equal(cohort.baseline, null);
    assert.equal(visit.registersBaseline, true);
    assert.equal(visit.visitNumber, 1);
    assert.equal(visit.status, "DRAFT");
    assert.equal(visit.samplingPlanVersion, cohort.samplingPlan.version);
    assert.equal(visit.baselineVersion, 1);
    assert.equal(visit.priorVisitId, null);
    assert.deepEqual(visit.sampleAssessments.map(a => a.sampleId), FV_IDS);
    assert.ok(visit.sampleAssessments.every(a => a.condition === null && a.assessmentRevision === 0 && a.recheckRequired === false));
    assert.equal(visit.visitContext.registersBaseline, true);
    assert.equal(visit.visitContext.sampleTarget, 3);
    assert.equal(visit.visitContext.approvedSampleTarget, null);
    assert.deepEqual(visit.visitContext.samples.map(x => [x.sampleId, x.species]), FV_IDS.map(id => [id, "Narra"]));
  });
});

test("B3 first visit date cannot be in the future", async () => {
  await withEnv(FLAG_ON, async () => {
    seedFirstVisit();
    await assert.rejects(() => createFirst({ visitDate: "2099-01-01" }), e => e.status === 409 && e.code === "VISIT_NOT_OPEN");
    assert.equal(table("sampleMonitoringVisits").size, 0);
  });
});

test("B3 create re-checks report eligibility in the transaction and rejects unverified or ineligible reports", async () => {
  await withEnv(FLAG_ON, async () => {
    const cases = [
      () => { table("plantingReports").get("rpt").verificationStatus = "Pending"; },
      () => { table("plantingReports").get("rpt").quantityPlanted = 0; },
      () => { table("plantingReports").delete("rpt"); },
      () => { table("plantingReports").get("rpt").siteId = "other-site"; },
      () => { table("sites").delete("site"); },
      () => { table("plantingReports").get("rpt").quantityPlanted = 30; },
      () => { table("plantingReports").get("rpt").reportingPolicy = { monitoring: "NONE" }; },
    ];
    for (const mutate of cases) {
      seedFirstVisit(); mutate();
      await assert.rejects(() => createFirst(), e => e.status === 409 && e.code === "REPORT_NOT_ELIGIBLE");
      assert.equal(table("sampleMonitoringVisits").size, 0);
      assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan, undefined);
    }
    // The pre-transaction read is not trusted: the report is revoked between the first read and the transaction.
    seedFirstVisit();
    const original = db.runTransaction;
    db.runTransaction = async fn => { table("plantingReports").get("rpt").verificationStatus = "Returned"; return original(fn); };
    try { await assert.rejects(() => createFirst(), e => e.code === "REPORT_NOT_ELIGIBLE"); } finally { db.runTransaction = original; }
    assert.equal(table("sampleMonitoringVisits").size, 0);
  });
});

test("B3 concurrent and repeated first-visit creation never writes a second plan or visit", async () => {
  await withEnv(FLAG_ON, async () => {
    seedFirstVisit();
    const original = db.runTransaction; let queue = Promise.resolve();
    db.runTransaction = fn => { const run = queue.then(() => original(fn)); queue = run.catch(() => {}); return run; };
    try {
      const [a, b] = await Promise.all([createFirst(), createFirst()]);
      assert.equal(a.id, b.id);
      const results = await Promise.allSettled([createFirst({ actorId: "other-staff" }), createFirst({ actorId: "other-staff", visitDate: "2026-11-01" })]);
      assert.ok(results.every(r => r.status === "rejected" && r.reason.code === "OPEN_VISIT_EXISTS"));
    } finally { db.runTransaction = original; }
    assert.equal(table("sampleMonitoringVisits").size, 1);
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlanHistory.length, 1);
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan.version, 1);
    const again = await createFirst();
    assert.equal(again.registersBaseline, true);
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlanHistory.length, 1);
  });
});

test("B3 multi-species cohorts are blocked at create and in readiness (interim limitation L1)", async () => {
  await withEnv({ ...FLAG_ON, PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" }, async () => {
    seedFirstVisit({ species: [{ species: "Narra", verifiedPlantedQuantity: 15 }, { species: "Molave", verifiedPlantedQuantity: 10 }] });
    await assert.rejects(() => createFirst({ testOnly: false }), e => e.status === 409 && e.code === "SPECIES_ALLOCATION_PENDING");
    assert.equal(table("sampleMonitoringVisits").size, 0);
    const data = await s.readiness({ actorId: "staff", actorRole: "staff" });
    const row = data.cohorts.find(r => r.cohortId === "fv");
    assert.ok(row.reasons.some(r => r.code === "SPECIES_ALLOCATION_PENDING"));
    assert.equal(row.canCreateVisit, false);
    assert.ok(data.notEligible.some(r => r.cohortId === "fv"));
    assert.ok(!data.eligible.some(r => r.cohortId === "fv"));
  });
});

test("B3 readiness separates eligible first-visit reports and suppresses legacy plan/baseline/snapshot blockers", async () => {
  await withEnv({ ...FLAG_ON, PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" }, async () => {
    seedFirstVisit(); provisionalAllowed = false;
    try {
      const fv = table("verifiedPlantingCohorts").get("fv");
      table("verifiedPlantingCohorts").set("bad", { ...fv, source: { ...fv.source, plantingReportId: "pending-rpt" } });
      table("plantingReports").set("pending-rpt", { reportNumber: "RPT-PENDING", verificationStatus: "Pending", quantityPlanted: 25, siteId: "site" });
      const data = await s.readiness({ actorId: "staff", actorRole: "staff" });
      const row = data.cohorts.find(r => r.cohortId === "fv"), bad = data.cohorts.find(r => r.cohortId === "bad");
      assert.deepEqual(row.reasons, [{ code: "FIRST_VISIT_REGISTERS_BASELINE", informational: true, sampleTarget: 3 }]);
      assert.equal(row.canCreateVisit, true);
      assert.equal(row.registersBaseline, true);
      assert.equal(row.sampleTarget, 3);
      assert.equal(row.nextVisitNumber, 1);
      assert.deepEqual(data.eligible.map(r => r.cohortId), ["fv"]);
      assert.ok(bad.reasons.some(r => r.code === "REPORT_NOT_ELIGIBLE"));
      assert.equal(bad.canCreateVisit, false);
      assert.ok(data.notEligible.some(r => r.cohortId === "bad") && data.notEligible.some(r => r.cohortId === "c"));
      for (const r of [row, bad]) assert.ok(!r.reasons.some(x => ["SAMPLING_PLAN_NOT_APPROVED", "BASELINE_NOT_APPROVED", "SAMPLING_POLICY_SNAPSHOT_MISSING"].includes(x.code)));
      assert.equal(data.visitCreationAvailable, true);
      // A first visit in progress keeps the informational reason but is blocked by the open visit.
      await createFirst({ testOnly: false });
      const inProgress = (await s.readiness({ actorId: "staff", actorRole: "staff" })).cohorts.find(r => r.cohortId === "fv");
      assert.deepEqual(inProgress.reasons.map(r => r.code), ["FIRST_VISIT_REGISTERS_BASELINE", "OPEN_VISIT_EXISTS"]);
      assert.equal(inProgress.canCreateVisit, false);
    } finally { provisionalAllowed = true; }
  });
});

test("B6 readiness keeps an approved first-visit cohort eligible for its next open visit", async () => {
  await withEnv({ ...FLAG_ON, PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" }, async () => {
    seedFirstVisit(); provisionalAllowed = false;
    try {
      const cohort = table("verifiedPlantingCohorts").get("fv");
      Object.assign(cohort, {
        samplingPolicySnapshot: { percentage: 10, minimum: null, policyVersion: 1 },
        samplingPlan: {
          status: "APPROVED", version: 1, origin: "FIRST_VISIT",
          provisionalPolicy: "menro-ceil-10-percent-first-visit-baseline-v1",
          provisionalTarget: 3,
          selectedSamples: FV_IDS.map(permanentId => ({ permanentId, unitType: "tree", species: "Narra", siteReference: "site" })),
        },
        baselineVersion: 1,
        baseline: { approvalStatus: "APPROVED", sampleUnits: FV_IDS.map(permanentId => ({ permanentId })) },
      });
      const row = (await s.readiness({ actorId: "staff", actorRole: "staff" })).cohorts.find(r => r.cohortId === "fv");
      assert.equal(row.canCreateVisit, true);
      assert.deepEqual(row.reasons, []);
      assert.equal(row.registersBaseline, undefined);
    } finally { provisionalAllowed = true; }
  });
});

test("B3 submit requires current evidence with GPS for every tree and moves the plan to PENDING", async () => {
  await withEnv(FLAG_ON, async () => {
    seedFirstVisit();
    const visit = await createFirst();
    await assert.rejects(() => submitFirst(visit), e => e.status === 409 && e.code === "CURRENT_SAMPLE_EVIDENCE_REQUIRED" && e.missingSampleIds.length === 3);
    attachEvidence(visit.id, { gps: false });
    await assert.rejects(() => submitFirst(visit), e => e.status === 409 && e.code === "CURRENT_SAMPLE_EVIDENCE_REQUIRED");
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan.status, "DRAFT");
    attachEvidence(visit.id);
    await assert.rejects(() => s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff", expectedVersion: 0, submit: true, assessments: fvAssessments() }), e => e.status === 400);
    const saved = await submitFirst(visit);
    assert.equal(saved.status, "PENDING_ADMIN_APPROVAL");
    const plan = table("verifiedPlantingCohorts").get("fv").samplingPlan;
    assert.equal(plan.status, "PENDING_ADMIN_APPROVAL");
    assert.equal(plan.submittedBy, "staff");
    assert.equal(plan.version, visit.samplingPlanVersion);
  });
});

test("B3 return needs a reason, returns plan and visit, and the original Staff resubmits with the same Tree IDs", async () => {
  await withEnv(FLAG_ON, async () => {
    seedFirstVisit();
    const visit = await createFirst(); attachEvidence(visit.id);
    const pending = await submitFirst(visit);
    await assert.rejects(() => s.review({ visitId: visit.id, actorId: "admin", expectedVersion: pending.version, approve: false, reasons: "  " }), e => e.status === 400);
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan.status, "PENDING_ADMIN_APPROVAL");
    const returned = await s.review({ visitId: visit.id, actorId: "admin", expectedVersion: pending.version, approve: false, reasons: "Re-measure T002." });
    assert.equal(returned.status, "RETURNED");
    let cohort = table("verifiedPlantingCohorts").get("fv");
    assert.equal(cohort.samplingPlan.status, "RETURNED");
    assert.equal(cohort.samplingPlan.reviewRemarks, "Re-measure T002.");
    assert.equal(cohort.baseline, null);
    await assert.rejects(() => s.save({ actorRole: "staff", visitId: visit.id, actorId: "other-staff", expectedVersion: returned.version, assessments: fvAssessments() }), e => e.status === 409);
    const changed = fvAssessments({ [FV_IDS[1]]: { heightCentimeters: 130 } });
    const draft = await s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff", expectedVersion: returned.version, assessments: changed });
    assert.equal(draft.sampleAssessments[1].assessmentRevision, 1);
    await assert.rejects(() => s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff", expectedVersion: draft.version, submit: true, dateMonitored: today(), assessments: changed }),
      e => e.code === "CURRENT_SAMPLE_EVIDENCE_REQUIRED" && e.missingSampleIds.join() === FV_IDS[1]);
    attachEvidence(visit.id, { revision: 1 });
    const resubmitted = await s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff", expectedVersion: draft.version, submit: true, dateMonitored: today(), assessments: changed });
    assert.equal(resubmitted.status, "PENDING_ADMIN_APPROVAL");
    cohort = table("verifiedPlantingCohorts").get("fv");
    assert.equal(cohort.samplingPlan.status, "PENDING_ADMIN_APPROVAL");
    assert.equal(cohort.samplingPlan.version, visit.samplingPlanVersion);
    assert.deepEqual(cohort.samplingPlan.selectedSamples.map(x => x.permanentId), FV_IDS);
    assert.deepEqual(resubmitted.sampleAssessments.map(a => a.sampleId), FV_IDS);
    assert.deepEqual(cohort.samplingPlanHistory.map(h => h.status), ["DRAFT", "PENDING_ADMIN_APPROVAL", "RETURNED", "PENDING_ADMIN_APPROVAL"]);
  });
});

async function approvedFirstVisit(dateMonitored, env = FLAG_ON) {
  return withEnv(env, async () => {
    seedFirstVisit();
    const visit = await createFirst({ testOnly: env.PERMANENT_SAMPLE_SCHEDULE_ENABLED !== "true" }); attachEvidence(visit.id);
    const pending = await submitFirst(visit);
    // Future actual dates cannot be saved; the stored actual date is set directly to exercise the calendar rule.
    table("sampleMonitoringVisits").get(visit.id).dateMonitored = dateMonitored;
    const approved = await s.review({ visitId: visit.id, actorId: "admin", expectedVersion: pending.version, approve: true });
    return { visit, approved };
  });
}

test("B3 Admin approval of visit 1 locks plan and baseline together and starts the calendar", async () => {
  const { visit, approved } = await approvedFirstVisit("2027-01-15");
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.nextScheduledDueDate, "2027-02-15");
  const cohort = table("verifiedPlantingCohorts").get("fv");
  assert.equal(cohort.samplingPlan.status, "APPROVED");
  assert.equal(cohort.samplingPlan.reviewedBy, "admin");
  assert.equal(cohort.baseline.approvalStatus, "APPROVED");
  assert.equal(cohort.baselineVersion, visit.baselineVersion);
  assert.equal(cohort.baselineStatus, "REGISTERED");
  assert.deepEqual(cohort.baseline.sampleUnits.map(u => [u.permanentId, u.species, u.heightMeters]), FV_IDS.map(id => [id, "Narra", 1.2]));
  assert.deepEqual(cohort.baselineHistory.map(h => h.status), ["PENDING_ADMIN_APPROVAL", "APPROVED"]);
  assert.doesNotMatch(JSON.stringify(cohort.baseline), /privateEvidence|private-0/);
  assert.equal(cohort.permanentSampleSchedule.nextScheduledDueDate, "2027-02-15");
  assert.equal(cohort.permanentSampleSchedule.nextVisitNumber, 2);
  assert.equal(cohort.permanentSampleSchedule.lastActualVisitDate, "2027-01-15");
  // The approved first visit still binds (the legacy rule now applies) for viewing.
  await withEnv(FLAG_ON, async () => {
    const context = (await s.get(visit.id, { actorId: "staff", actorRole: "staff" })).visitContext;
    assert.equal(context.registersBaseline, true);
    assert.equal(context.approvedSampleTarget, 3);
    assert.equal(context.registeredSampleTrees, 3);
  });
});

test("B3 visit 2 is due one calendar month after the visit 1 actual date, with end-of-month clamping", async () => {
  assert.equal((await approvedFirstVisit("2027-01-31")).approved.nextScheduledDueDate, "2027-02-28");
});

test("B3 after approval the plan cannot be replaced through PUT /sampling-plan", async () => {
  await approvedFirstVisit("2026-11-01");
  await withEnv(FLAG_ON, async () => {
    const plan = table("verifiedPlantingCohorts").get("fv").samplingPlan;
    const cohortService = require("../src/services/verifiedPlantingCohort.service");
    await assert.rejects(() => cohortService.saveSamplingPlan({ cohortId: "fv", actorId: "staff", expectedVersion: plan.version, selectionMethod: "documented-manual",
      selectedSamples: plan.selectedSamples, speciesSiteDistribution: plan.speciesSiteDistribution }), e => e.status === 409);
  });
});

test("B3 visit 2 reuses the approved Tree IDs and stays closed before its calendar due date", async () => {
  const env = { ...FLAG_ON, PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" };
  const { visit, approved } = await approvedFirstVisit(today(), env);
  await withEnv(env, async () => {
    provisionalAllowed = false;
    try {
      await assert.rejects(() => s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: approved.nextScheduledDueDate }), e => e.code === "VISIT_NOT_OPEN");
    } finally { provisionalAllowed = true; }
  });
  await withEnv(FLAG_ON, async () => {
    const second = await s.create({ actorRole: "staff", cohortId: "fv", actorId: "staff", visitDate: "2030-01-01", testOnly: true });
    assert.notEqual(second.id, visit.id);
    assert.equal(second.registersBaseline, undefined);
    assert.equal(second.priorVisitId, visit.id);
    assert.equal(second.visitNumber, 2);
    assert.equal(second.baselineVersion, visit.baselineVersion);
    assert.equal(second.samplingPlanVersion, visit.samplingPlanVersion);
    assert.deepEqual(second.sampleAssessments.map(a => a.sampleId), FV_IDS);
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlanHistory.length, 3);
  });
});

test("B3 a legacy cohort with an approved plan and baseline follows the old path while the flag is on", async () => {
  await withEnv(FLAG_ON, async () => {
    seed();
    const visit = await s.create({ actorRole: "staff", cohortId: "c", actorId: "staff", visitDate: "2030-01-01", testOnly: true });
    assert.equal(visit.registersBaseline, undefined);
    assert.equal(visit.baselineVersion, 0);
    assert.deepEqual(visit.sampleAssessments.map(a => a.sampleId), ["TREE-001", "TREE-002"]);
    assert.equal(visit.visitContext.registersBaseline, false);
    assert.equal(visit.visitContext.samples.length, 2);
    const saved = await s.save({ actorRole: "staff", visitId: visit.id, actorId: "staff", expectedVersion: 0, submit: true, assessments: [{ sampleId: "TREE-001", condition: "Healthy" }, { sampleId: "TREE-002", condition: "Dead" }] });
    assert.equal(saved.status, "PENDING_ADMIN_APPROVAL");
    const approved = await s.review({ visitId: visit.id, actorId: "admin", expectedVersion: saved.version, approve: true });
    assert.equal(approved.status, "APPROVED");
    assert.equal(table("verifiedPlantingCohorts").get("c").samplingPlanHistory, undefined);
    assert.equal(table("verifiedPlantingCohorts").get("c").permanentSampleSchedule, undefined);
    assert.equal(table("verifiedPlantingCohorts").get("c").baseline.sampleUnits.length, 2);
  });
});

test("B3 validation: cohortBinding and samplesFor switch only for an unapproved first-visit baseline", async () => {
  const validation = require("../src/services/sampleMonitoringValidation");
  const plan = { origin: "FIRST_VISIT", status: "DRAFT", version: 1, selectedSamples: [{ permanentId: "A-T001" }] };
  const cohort = { source: { siteId: "site" }, baselineVersion: 0, baseline: null, samplingPlan: plan };
  const visit = { registersBaseline: true, siteId: "site", samplingPlanVersion: 1, baselineVersion: 1 };
  await withEnv(FLAG_ON, async () => {
    for (const status of ["DRAFT", "PENDING_ADMIN_APPROVAL", "RETURNED"]) validation.cohortBinding({ ...cohort, samplingPlan: { ...plan, status } }, visit);
    assert.deepEqual(validation.samplesFor(cohort, visit), plan.selectedSamples);
    for (const bad of [{ ...cohort, samplingPlan: { ...plan, status: "APPROVED" } }, { ...cohort, samplingPlan: { ...plan, origin: undefined } },
      { ...cohort, samplingPlan: { ...plan, version: 2 } }, { ...cohort, baselineVersion: 1 }, { ...cohort, source: { siteId: "x" } }]) {
      assert.throws(() => validation.cohortBinding(bad, visit), { status: 409 });
    }
    assert.throws(() => validation.cohortBinding(cohort, { ...visit, registersBaseline: false }), { status: 409 });
    const legacy = { source: { siteId: "site" }, baselineVersion: 1, samplingPlan: { status: "APPROVED", version: 1 }, baseline: { approvalStatus: "APPROVED", sampleUnits: [{ permanentId: "L" }] } };
    validation.cohortBinding(legacy, visit);
    assert.deepEqual(validation.samplesFor(legacy, visit), legacy.baseline.sampleUnits);
  });
  await withEnv({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: undefined }, async () => {
    assert.throws(() => validation.cohortBinding(cohort, visit), { status: 409 });
  });
});

// ---- B3 fix round 1 ----
test("B3 I1: with visit 1 open the legacy plan routes refuse, and after approval the baseline routes refuse", async () => {
  const cohortService = require("../src/services/verifiedPlantingCohort.service");
  const active = e => e.status === 409 && e.code === "FIRST_VISIT_BASELINE_ACTIVE";
  await withEnv(FLAG_ON, async () => {
    seedFirstVisit();
    const visit = await createFirst(); attachEvidence(visit.id);
    let plan = table("verifiedPlantingCohorts").get("fv").samplingPlan;
    await assert.rejects(() => cohortService.saveSamplingPlan({ cohortId: "fv", actorId: "staff", expectedVersion: plan.version, selectionMethod: "documented-manual",
      selectedSamples: plan.selectedSamples, speciesSiteDistribution: plan.speciesSiteDistribution, submitForApproval: true }), active);
    const pending = await submitFirst(visit);
    plan = table("verifiedPlantingCohorts").get("fv").samplingPlan;
    await assert.rejects(() => cohortService.approveSamplingPlan({ cohortId: "fv", actorId: "admin", expectedVersion: plan.version, approve: true }), active);
    await assert.rejects(() => cohortService.approveSamplingPlan({ cohortId: "fv", actorId: "admin", expectedVersion: plan.version, approve: false, remarks: "x" }), active);
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan.status, "PENDING_ADMIN_APPROVAL");
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan.version, visit.samplingPlanVersion);
    await s.review({ visitId: visit.id, actorId: "admin", expectedVersion: pending.version, approve: true });
    const baselineVersion = table("verifiedPlantingCohorts").get("fv").baselineVersion;
    await assert.rejects(() => cohortService.registerBaseline({ cohortId: "fv", actorId: "staff", expectedVersion: baselineVersion, status: "REGISTERED",
      sampleUnits: [{ permanentId: FV_IDS[0], unitType: "tree", latitude: 12.65, longitude: 123.91, condition: "Healthy", captureDate: "2026-11-02", photoReferences: [{ evidenceId: "photo-1" }] }] }), active);
    await assert.rejects(() => cohortService.approveBaseline({ cohortId: "fv", actorId: "admin", expectedVersion: baselineVersion, approve: true }), active);
    assert.equal(table("verifiedPlantingCohorts").get("fv").baseline.approvalStatus, "APPROVED");
    assert.equal(table("verifiedPlantingCohorts").get("fv").baselineVersion, visit.baselineVersion);
  });
  await withEnv({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: undefined }, async () => {
    seedFirstVisit();
    await withEnv(FLAG_ON, () => createFirst());
    const plan = table("verifiedPlantingCohorts").get("fv").samplingPlan;
    await assert.rejects(() => cohortService.saveSamplingPlan({ cohortId: "fv", actorId: "staff", expectedVersion: plan.version, selectionMethod: "documented-manual",
      selectedSamples: plan.selectedSamples, speciesSiteDistribution: plan.speciesSiteDistribution }), active);
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan.origin, "FIRST_VISIT");
  });
});

test("conflicting and pending report policies are refused when visit 1 is created, submitted or approved", async () => {
  for (const [reportingPolicy, code] of [[{ monitoring: "PERMANENT_SAMPLE", definition: { monitoring: "NONE" } }, "POLICY_CONFLICT"],
    [{ monitoring: "PERMANENT_SAMPLE", policyStatus: "PENDING_MENRO_POLICY" }, "NOT_PERMANENT_SAMPLE_MONITORING"],
    [{ definition: { monitoring: "PENDING_MENRO_POLICY" } }, "NOT_PERMANENT_SAMPLE_MONITORING"]]) {
    const refused = e => e.status === 409 && e.code === "REPORT_NOT_ELIGIBLE" && e.problems.includes(code);
    const setPolicy = value => { const row = table("plantingReports").get("rpt"); if (value) row.reportingPolicy = value; else delete row.reportingPolicy; };
    await withEnv(FLAG_ON, async () => {
      seedFirstVisit({ report: { reportingPolicy } });
      await assert.rejects(() => createFirst(), refused);
      assert.equal(table("sampleMonitoringVisits").size, 0);
      setPolicy(null);
      const visit = await createFirst(); attachEvidence(visit.id);
      setPolicy(reportingPolicy);
      await assert.rejects(() => submitFirst(visit), refused);
      assert.equal(table("sampleMonitoringVisits").get(visit.id).status, "DRAFT");
      setPolicy(null);
      table("users").set("admin-1", { role: "admin" });
      const pending = await submitFirst(visit);
      setPolicy(reportingPolicy);
      await assert.rejects(() => s.review({ visitId: visit.id, actorId: "admin", expectedVersion: pending.version, approve: true }), refused);
      assert.equal(table("sampleMonitoringVisits").get(visit.id).status, "PENDING_ADMIN_APPROVAL");
      assert.equal(table("verifiedPlantingCohorts").get("fv").baseline, null);
    });
  }
});
test("B3 M1: submit and approval of visit 1 re-check report eligibility in the transaction", async () => {
  await withEnv(FLAG_ON, async () => {
    seedFirstVisit();
    const visit = await createFirst(); attachEvidence(visit.id);
    table("plantingReports").get("rpt").verificationStatus = "Returned";
    await assert.rejects(() => submitFirst(visit), e => e.status === 409 && e.code === "REPORT_NOT_ELIGIBLE");
    assert.equal(table("sampleMonitoringVisits").get(visit.id).status, "DRAFT");
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan.status, "DRAFT");
    table("plantingReports").get("rpt").verificationStatus = "Approved";
    const pending = await submitFirst(visit);
    table("plantingReports").get("rpt").verificationStatus = "Returned";
    const before = JSON.stringify([table("sampleMonitoringVisits").get(visit.id), table("verifiedPlantingCohorts").get("fv")]);
    await assert.rejects(() => s.review({ visitId: visit.id, actorId: "admin", expectedVersion: pending.version, approve: true }), e => e.status === 409 && e.code === "REPORT_NOT_ELIGIBLE");
    assert.equal(JSON.stringify([table("sampleMonitoringVisits").get(visit.id), table("verifiedPlantingCohorts").get("fv")]), before);
  });
});

test("B3 M2: visit 1 Date Monitored may be any day from planting to today, never earlier or in the future, even in test mode", async () => {
  await withEnv(FLAG_ON, async () => {
    seedFirstVisit();
    const visitDate = "2026-11-10";
    const visit = await createFirst({ visitDate }); attachEvidence(visit.id);
    const planted = table("verifiedPlantingCohorts").get("fv").source.plantingDate;
    assert.equal(visit.openingDate, planted);
    await assert.rejects(() => submitFirst(visit, { dateMonitored: "2000-01-01" }), e => e.status === 409 && e.code === "VISIT_BEFORE_ELIGIBILITY");
    await assert.rejects(() => submitFirst(visit, { dateMonitored: "2999-01-01" }), e => e.status === 400);
    assert.equal(table("sampleMonitoringVisits").get(visit.id).status, "DRAFT");
    // The assessment day can be earlier than the day Staff opened the visit; approval makes it the baseline date.
    const pending = await submitFirst(visit, { dateMonitored: "2026-11-09" });
    assert.deepEqual([pending.status, pending.visitDate], ["PENDING_ADMIN_APPROVAL", visitDate]);
    const approvedVisit = await s.review({ visitId: visit.id, actorId: "admin", expectedVersion: pending.version, approve: true });
    assert.deepEqual([approvedVisit.visitDate, approvedVisit.startedOn, approvedVisit.nextScheduledDueDate], ["2026-11-09", visitDate, "2026-12-09"]);
    // A planting date later than the visit date (e.g. corrected after creation) is also enforced.
    seedFirstVisit();
    const early = await createFirst({ visitDate }); attachEvidence(early.id);
    table("verifiedPlantingCohorts").get("fv").source.plantingDate = "2026-11-12";
    await assert.rejects(() => submitFirst(early, { dateMonitored: "2026-11-11" }), e => e.status === 409 && e.code === "VISIT_BEFORE_ELIGIBILITY");
    assert.equal((await submitFirst(early, { dateMonitored: "2026-11-12" })).status, "PENDING_ADMIN_APPROVAL");
  });
});

// ---- Final fix wave D-5: read-only Section 1 context on readiness rows (before any visit exists) ----
const LEGACY_READINESS_KEYS = ["cohortId", "reportNumber", "siteName", "nextVisitNumber", "nextScheduledDueDate", "openingDate", "scheduleStatus", "canCreateVisit", "reasons"];
function seedSection1() {
  seedFirstVisit();
  table("sites").set("site", { siteName: "First Visit Site", barangay: "Bical", status: "active", locationDescription: "Sitio Proper, Bical",
    latitude: 12.662301, longitude: 123.932983, coverageRadiusMeters: 75, polygon: [{ lat: 12.6620, lng: 123.9326 }, null, { lat: 12.6626, lng: 123.9326 }, { lat: 12.6626, lng: 123.9333 }],
    createdBy: "SITE-CREATOR-UID" });
  Object.assign(table("plantingReports").get("rpt"), { plantingDate: "2026-10-01", requesterName: "PII-REQUESTER", requesterEmail: "pii@example.test",
    contactNumber: "09170000000", evidencePhotos: [{ objectName: "PRIVATE-EVIDENCE" }], reportingPolicy: { monitoring: "PERMANENT_SAMPLE" } });
}
test("D-5 an eligible first-visit readiness row carries the read-only Section 1 context before any visit exists", async () => {
  await withEnv({ ...FLAG_ON, PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" }, async () => {
    seedSection1();
    const data = await s.readiness({ actorId: "staff", actorRole: "staff" });
    const row = data.eligible.find(r => r.cohortId === "fv");
    assert.ok(row, "first-visit cohort is eligible");
    assert.deepEqual(row.context, {
      plantingReportId: "rpt", plantingReportNumber: "RPT-2026-020",
      site: { id: "site", siteName: "First Visit Site", barangay: "Bical", address: "Sitio Proper, Bical", latitude: 12.662301, longitude: 123.932983,
        coverageRadiusMeters: 75, polygon: [{ lat: 12.6620, lng: 123.9326 }, { lat: 12.6626, lng: 123.9326 }, { lat: 12.6626, lng: 123.9333 }] },
      plantingDate: "2026-10-01", verificationStatus: "Approved", verifiedPlantedQuantity: 25,
      species: [{ species: "Narra", quantity: 25 }],
      sampleTarget: 3, sampleRegistrationStatus: "NOT_STARTED", registeredSampleCount: 0,
      nextVisitNumber: 1, monitoringStatus: "FIRST_VISIT_AVAILABLE",
    });
    assert.doesNotMatch(JSON.stringify(data), /PII-REQUESTER|pii@example|09170000000|PRIVATE-EVIDENCE|SITE-CREATOR-UID|inventoryId|releasedQuantity|privateEvidence|objectName/);
    // Readiness stays read-only.
    assert.equal(table("sampleMonitoringVisits").size, 0);
    assert.equal(table("verifiedPlantingCohorts").get("fv").samplingPlan, undefined);
  });
});
test("D-5 a legacy readiness row is unchanged apart from the added context key", async () => {
  await withEnv({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: undefined, PERMANENT_SAMPLE_SCHEDULE_ENABLED: undefined }, async () => {
    seed();
    const c = table("verifiedPlantingCohorts").get("c");
    c.source = { ...c.source, plantingReportId: "report", plantingDate: "2026-10-01" };
    table("sites").set("site", { siteName: "Readiness site" });
    table("plantingReports").set("report", { reportNumber: "RPT-READY" });
    const row = (await s.readiness({ actorId: "staff", actorRole: "staff" })).cohorts.find(r => r.cohortId === "c");
    assert.deepEqual(Object.keys(row).filter(key => key !== "context"), LEGACY_READINESS_KEYS);
    assert.deepEqual({ ...row, context: undefined }, { cohortId: "c", reportNumber: "RPT-READY", siteName: "Readiness site", nextVisitNumber: 1,
      nextScheduledDueDate: today(), openingDate: today(), scheduleStatus: "DUE", canCreateVisit: false,
      reasons: [{ code: "VISIT_SCHEDULING_POLICY_PENDING" }], context: undefined });
    assert.equal(row.context.plantingReportNumber, "RPT-READY");
    assert.equal(row.context.site.siteName, "Readiness site");
    assert.equal(row.context.sampleTarget, null);
    assert.equal(row.context.registeredSampleCount, 2);
    assert.equal(row.context.sampleRegistrationStatus, "APPROVED");
    assert.deepEqual(row.context.species, []);
  });
});
test("D-5 readiness context never leaks out-of-scope pilot cohorts", async () => {
  await withEnv({ ...FLAG_ON, PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true", PERMANENT_SAMPLE_PILOT_ENABLED: "true",
    PERMANENT_SAMPLE_PILOT_USER_IDS: JSON.stringify(["staff"]), PERMANENT_SAMPLE_PILOT_COHORT_IDS: JSON.stringify(["fv"]) }, async () => {
    seedSection1();
    table("verifiedPlantingCohorts").set("secret", { source: { siteId: "secret-site", plantingReportId: "secret-rpt", plantingDate: "2026-10-01",
      species: [{ species: "SECRET-SPECIES", verifiedPlantedQuantity: 25 }] }, verifiedPlantedQuantity: 25, baselineVersion: 0, baseline: null });
    table("plantingReports").set("secret-rpt", { reportNumber: "RPT-SECRET", verificationStatus: "Approved", quantityPlanted: 25, siteId: "secret-site" });
    table("sites").set("secret-site", { siteName: "SECRET-SITE", barangay: "SECRET-BARANGAY", status: "active", latitude: 1, longitude: 2 });
    // The test double supports only "==" filters; add the pilot IN filter on document ids used by scopeQuery.
    const base = db.collection;
    db.collection = name => {
      const query = base(name);
      if (name !== "verifiedPlantingCohorts") return query;
      const where = query.where;
      query.where = (field, op, value) => op !== "in" ? where(field, op, value) : ({ limit: () => ({ get: async () => {
        const all = await base(name).get();
        return { docs: all.docs.filter(doc => value.includes(doc.id)), empty: false };
      } }) });
      return query;
    };
    try {
      const data = await s.readiness({ actorId: "staff", actorRole: "staff" });
      assert.deepEqual(data.cohorts.map(r => r.cohortId), ["fv"]);
      assert.equal(data.cohorts[0].context.site.id, "site");
      assert.doesNotMatch(JSON.stringify(data), /secret|SECRET/);
      await assert.rejects(() => s.readiness({ actorId: "other-staff", actorRole: "staff" }), e => e.status === 403);
    } finally { db.collection = base; }
  });
});

// ---- Final fix wave H-4 (D1): flag OFF after a first-visit baseline approval ----
function seedApprovedFirstVisitCohort() {
  seedFirstVisit();
  Object.assign(table("verifiedPlantingCohorts").get("fv"), {
    samplingPolicySnapshot: { percentage: 10, minimum: null, policyVersion: 1 },
    samplingPlan: { status: "APPROVED", version: 1, origin: "FIRST_VISIT", provisionalPolicy: "menro-ceil-10-percent-first-visit-baseline-v1", provisionalTarget: 3,
      selectedSamples: FV_IDS.map(permanentId => ({ permanentId, unitType: "tree", species: "Narra", siteReference: "site" })) },
    baselineVersion: 1, baseline: { approvalStatus: "APPROVED", sampleUnits: FV_IDS.map(permanentId => ({ permanentId })) },
  });
  table("sampleMonitoringVisits").set("visit-1", { cohortId: "fv", siteId: "site", visitNumber: 1, status: "APPROVED", registersBaseline: true,
    visitDate: "2026-10-05", scheduledDueDate: "2026-10-05", openingDate: "2026-10-05", dateMonitored: "2026-10-05", approvedAt: "2026-10-06T00:00:00.000Z",
    createdBy: "staff", sampleAssessments: [] });
}
test("H-4 flag OFF: an approved FIRST_VISIT cohort is blocked by SAMPLING_POLICY_PENDING and a legacy cohort is unaffected", async () => {
  const rowsWith = async flag => withEnv({ PERMANENT_SAMPLE_FIRST_VISIT_BASELINE_ENABLED: flag, PERMANENT_SAMPLE_SCHEDULE_ENABLED: "true" }, async () => {
    seedApprovedFirstVisitCohort(); provisionalAllowed = false;
    try { return (await s.readiness({ actorId: "staff", actorRole: "staff" })).cohorts; } finally { provisionalAllowed = true; }
  });
  const off = await rowsWith(undefined), on = await rowsWith("true");
  const fvOff = off.find(r => r.cohortId === "fv"), fvOn = on.find(r => r.cohortId === "fv");
  assert.ok(fvOff.reasons.some(r => r.code === "SAMPLING_POLICY_PENDING" && r.pending.includes("MINIMUM_SAMPLE_POLICY_PENDING")));
  assert.equal(fvOff.canCreateVisit, false);
  assert.equal(fvOff.registersBaseline, undefined);
  assert.ok(!fvOn.reasons.some(r => r.code === "SAMPLING_POLICY_PENDING"));
  // The legacy cohort's readiness row is identical whether or not the first-visit flag is on.
  assert.deepEqual(off.find(r => r.cohortId === "c"), on.find(r => r.cohortId === "c"));
  assert.ok(!off.find(r => r.cohortId === "c").reasons.some(r => /FIRST_VISIT/.test(r.code)));
});
