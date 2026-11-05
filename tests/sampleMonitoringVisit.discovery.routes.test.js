const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
let enabled=true,received=[];
const mock=(p,exports)=>{const id=require.resolve(p);require.cache[id]={id,filename:id,loaded:true,exports}};
mock("../src/middleware/auth.middleware",{verifyToken:(req,res,next)=>{const role=req.get("x-role"),uid=req.get("x-uid");if(!role)return res.status(401).json({code:"UNAUTHENTICATED"});req.user={uid,role};next()}});
mock("../src/config/verifiedPlantingCohort",{resolveVerifiedPlantingCohortConfig:()=>({enabled})});
mock("../src/services/sampleMonitoringVisit.service",{list:async input=>{received.push(input);return{visits:[{id:"owned",progress:{completed:1,total:1,rechecking:0},actions:{view:true},privateEvidence:undefined}],nextCursor:"next"}},get:async(id,input)=>{received.push({id,...input});if(id!=="owned"||input.actorRole==="staff"&&input.actorId!=="owner")throw Object.assign(new Error("Monitoring visit not found."),{status:404});return{id:"owned",sampleAssessments:[{sampleId:"TREE-001",evidenceHistory:[{revision:0}]}]}}});
const routes=require("../src/routes/sampleMonitoringVisit.routes");
const service = require("../src/services/sampleMonitoringVisit.service");
async function server(fn){const app=express();app.use(express.json());app.use("/api/verified-sample-monitoring",routes);const s=await new Promise(r=>{const x=app.listen(0,"127.0.0.1",()=>r(x))});try{await fn(`http://127.0.0.1:${s.address().port}`)}finally{await new Promise(r=>s.close(r))}}
test("discovery HTTP forwards Staff/Admin identity and pagination without private evidence",async()=>{enabled=true;received=[];await server(async base=>{let r=await fetch(`${base}/api/verified-sample-monitoring/visits?status=DRAFT&limit=10&cursor=page-1`,{headers:{"x-role":"staff","x-uid":"staff-1"}});assert.equal(r.status,200);const body=await r.json();assert.equal(body.data.nextCursor,"next");assert.equal(JSON.stringify(body).includes("privateEvidence"),false);assert.deepEqual(received[0],{actorId:"staff-1",actorRole:"staff",status:"DRAFT",limit:"10",cursor:"page-1"});r=await fetch(`${base}/api/verified-sample-monitoring/visits`,{headers:{"x-role":"admin","x-uid":"admin-1"}});assert.equal(r.status,200);assert.equal(received[1].actorRole,"admin")})});
test("discovery HTTP denies guest/participant and blocks disabled gate",async()=>{await server(async base=>{let r=await fetch(`${base}/api/verified-sample-monitoring/visits`);assert.equal(r.status,401);r=await fetch(`${base}/api/verified-sample-monitoring/visits`,{headers:{"x-role":"participant","x-uid":"p"}});assert.equal(r.status,403);enabled=false;r=await fetch(`${base}/api/verified-sample-monitoring/visits`,{headers:{"x-role":"staff","x-uid":"s"}});assert.equal(r.status,409);enabled=true})});
test("detail HTTP forwards authenticated identity and hides unauthorized records",async()=>{enabled=true;received=[];await server(async base=>{let r=await fetch(`${base}/api/verified-sample-monitoring/visits/owned`,{headers:{"x-role":"staff","x-uid":"owner"}});assert.equal(r.status,200);assert.equal((await r.json()).data.sampleAssessments[0].sampleId,"TREE-001");assert.deepEqual(received[0],{id:"owned",actorId:"owner",actorRole:"staff"});r=await fetch(`${base}/api/verified-sample-monitoring/visits/owned`,{headers:{"x-role":"staff","x-uid":"other"}});assert.equal(r.status,404);assert.equal(JSON.stringify(await r.json()).includes("privateEvidence"),false);r=await fetch(`${base}/api/verified-sample-monitoring/visits/owned`,{headers:{"x-role":"admin","x-uid":"admin"}});assert.equal(r.status,200);r=await fetch(`${base}/api/verified-sample-monitoring/visits/missing`,{headers:{"x-role":"admin","x-uid":"admin"}});assert.equal(r.status,404);r=await fetch(`${base}/api/verified-sample-monitoring/visits/owned`);assert.equal(r.status,401);r=await fetch(`${base}/api/verified-sample-monitoring/visits/owned`,{headers:{"x-role":"participant","x-uid":"p"}});assert.equal(r.status,403);enabled=false;r=await fetch(`${base}/api/verified-sample-monitoring/visits/owned`,{headers:{"x-role":"staff","x-uid":"owner"}});assert.equal(r.status,409);enabled=true})});

test("visit mutations preserve authenticated actor and route identity and omit private evidence transports", async () => {
  enabled = true;
  const calls = [];
  const visit = { id: "owned", sampleAssessments: [{ sampleId: "TREE-001", assessmentRevision: 1,
    evidenceHistory: [{ revision: 0, linkedAt: "fixture-time", captureSessionId: "internal-session",
      privateEvidence: { objectName: "private-object-path", uploadIntentId: "private-intent" } }] }] };
  service.save = service.review = async input => { calls.push(input); return visit; };
  await server(async base => {
    for (const [method, suffix, role] of [["PUT", "", "staff"], ["POST", "/review", "admin"]]) {
      const response = await fetch(`${base}/api/verified-sample-monitoring/visits/owned${suffix}`, {
        method, headers: { "x-role": role, "x-uid": "authenticated-user", "content-type": "application/json" },
        body: JSON.stringify({ actorId: "forged-owner", visitId: "forged-visit", expectedVersion: 1,
          assessments: [], submit: false, approve: false, reasons: "Correction needed" }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.data.sampleAssessments[0].evidenceHistory, [{ revision: 0, linkedAt: "fixture-time" }]);
      assert.equal(JSON.stringify(body).includes("private-"), false);
      assert.equal(JSON.stringify(body).includes("internal-session"), false);
      assert.equal(calls.at(-1).actorId, "authenticated-user");
      assert.equal(calls.at(-1).visitId, "owned");
    }
  });
});
