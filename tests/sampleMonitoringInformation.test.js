const { test } = require("node:test");
const assert = require("node:assert/strict");
const { memoryFirestore } = require("./helpers/evidenceQuotaMemory");
const { createService } = require("../src/services/sampleMonitoringInformation.service");
function setup() {
  const memory = memoryFirestore();
  const put = (collection, id, row) => memory.records(collection).set(id, row);
  put("sampleMonitoringVisits", "visit", { createdBy: "owner", cohortId: "cohort", siteId: "site", status: "APPROVED" });
  put("verifiedPlantingCohorts", "cohort", { source: { siteId: "site", requestId: "source", plantingReportId: "report" } });
  put("plantingReports", "report", { requestId: "source", verificationStatus: "Approved", quantityPlanted: 5 });
  put("seedlingRequests", "source", { participantId: "requester" });
  put("users", "requester", { role: "participant", status: "active" });
  let enabled = true;
  const service = createService({ db: memory.db, enabled: () => enabled, now: () => 123,
    notify: (tx, data) => tx.create(memory.db.collection("notifications").doc(data.notificationId), data) });
  const question = { visitId: "visit", actorId: "owner", actorRole: "staff", key: "same", question: "Please confirm the access condition." };
  return { ...memory, put, service, question, disable: () => { enabled = false; } };
}
test("question and reply are atomic, recipient-derived, private and auditable", async () => {
  const f = setup();
  const first = await f.service.create({ ...f.question, recipientUserId: "attacker" });
  assert.equal(first.status, "OPEN");
  assert.equal(f.records("notifications").get(`${first.id}-question`).recipientUserId, "requester");
  assert.equal(first.recipientUserId, undefined);
  const reply = { requestId: first.id, actorId: "requester", actorRole: "participant", expectedVersion: 0, key: "reply", answer: "Access is open." };
  const result = await f.service.answer(reply);
  assert.equal(result.status, "ANSWERED"); assert.equal(result.history.length, 2);
  assert.deepEqual(await f.service.answer(reply), result);
  assert.equal(f.records("notifications").size, 2);
  assert.equal((await f.service.get({ requestId: first.id, actorId: "owner", actorRole: "staff" })).answer, reply.answer);
  assert.equal(f.records("sampleMonitoringVisits").get("visit").status, "APPROVED");
});
test("exact question retry does not duplicate; changed payload conflicts", async () => {
  const f = setup(); const first = await f.service.create(f.question);
  assert.deepEqual(await f.service.create(f.question), first);
  await assert.rejects(f.service.create({ ...f.question, question: "Changed" }), { status: 409 });
  assert.equal(f.records("notifications").size, 1);
});
test("ownership, roles, unauthenticated and disabled gate fail before writes", async () => {
  const f = setup();
  for (const actor of [{ actorId: "other", actorRole: "staff" }, { actorId: "requester", actorRole: "participant" }, { actorId: "", actorRole: "staff" }]) {
    await assert.rejects(f.service.create({ ...f.question, ...actor }));
  }
  f.disable(); await assert.rejects(f.service.create(f.question), { status: 409 });
  assert.equal(f.records("sampleMonitoringInformationRequests").size, 0);
});
test("missing or altered authoritative requester relation fails closed", async () => {
  const f = setup();
  f.put("plantingReports", "report", { requestId: "different", verificationStatus: "Approved", quantityPlanted: 5 });
  await assert.rejects(f.service.create(f.question), { status: 409 });
  assert.equal(f.records("notifications").size, 0);
});
test("other requester cannot read or reply; Staff cannot answer; stale answers conflict", async () => {
  const f = setup(); const { id } = await f.service.create(f.question);
  await assert.rejects(f.service.get({ requestId: id, actorId: "other", actorRole: "participant" }), { status: 404 });
  const reply = { requestId: id, actorId: "requester", actorRole: "participant", expectedVersion: 1, key: "r", answer: "Answer" };
  await assert.rejects(f.service.answer(reply), { status: 409 });
  await assert.rejects(f.service.answer({ ...reply, actorRole: "staff" }), { status: 403 });
  await assert.rejects(f.service.answer({ ...reply, actorId: "other" }), { status: 404 });
  assert.equal(f.records("notifications").size, 1);
});
test("changed requester ownership prevents access and no monitoring evidence leaks", async () => {
  const f = setup(); const { id } = await f.service.create(f.question);
  f.put("seedlingRequests", "source", { participantId: "different" });
  await assert.rejects(f.service.get({ requestId: id, actorId: "requester", actorRole: "participant" }));
  const admin = await f.service.get({ requestId: id, actorId: "admin", actorRole: "admin" });
  assert.equal(admin.privateEvidence, undefined); assert.equal(admin.fingerprint, undefined);
});
test("concurrent exact retries create one request and notification", async () => {
  const f = setup();
  const results = await Promise.all([f.service.create(f.question), f.service.create(f.question)]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(f.records("sampleMonitoringInformationRequests").size, 1);
  assert.equal(f.records("notifications").size, 1);
});
test("blank, overlong and missing-key submissions are rejected without writes", async () => {
  const f = setup();
  for (const changed of [{ question: " " }, { question: "a".repeat(2001) }, { key: undefined }, { visitId: "../visit" }]) {
    await assert.rejects(f.service.create({ ...f.question, ...changed }));
  }
  assert.equal(f.records("sampleMonitoringInformationRequests").size, 0);
});


test("tree clarification binds the saved revision and deduplicates the same case across retry keys", async () => {
  const f=setup();f.put("sampleMonitoringVisits","visit",{createdBy:"owner",cohortId:"cohort",siteId:"site",status:"DRAFT",sampleAssessments:[{sampleId:"TREE-001",condition:"Needs Rechecking",assessmentRevision:2}]});
  const input={...f.question,sampleId:"TREE-001",assessmentRevision:2};const first=await f.service.create(input);const retry=await f.service.create({...input,key:"different-retry-key"});
  assert.equal(first.id,retry.id);assert.equal(first.sampleId,"TREE-001");assert.equal(first.assessmentRevision,2);assert.equal(f.records("notifications").size,1);
  await assert.rejects(f.service.create({...input,question:"A different question"}),error=>error.status===409);
  const answered=await f.service.answer({requestId:first.id,actorId:"requester",actorRole:"participant",expectedVersion:0,key:"reply-tree",answer:"The marker is still beside the path."});
  assert.equal(answered.sampleId,"TREE-001");assert.equal(answered.history.length,2);
});
test("tree information rejects unknown trees, stale revisions and unauthorized actors without notifications", async () => {
  const f=setup();f.put("sampleMonitoringVisits","visit",{createdBy:"owner",cohortId:"cohort",siteId:"site",sampleAssessments:[{sampleId:"TREE-001",condition:"Needs Rechecking",assessmentRevision:1}]});
  for(const change of [{sampleId:"TREE-OTHER",assessmentRevision:1},{sampleId:"TREE-001",assessmentRevision:0},{sampleId:"TREE-001",assessmentRevision:1,actorId:"other"},{sampleId:"TREE-001",assessmentRevision:1,actorId:"requester",actorRole:"participant"}])await assert.rejects(f.service.create({...f.question,...change}));
  assert.equal(f.records("notifications").size,0);assert.equal(f.records("sampleMonitoringInformationRequests").size,0);
});
