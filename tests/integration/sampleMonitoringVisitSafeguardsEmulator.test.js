// Real Auth/Firestore emulator regression for the policy-independent visit safeguards:
// T4 single open visit per cohort under concurrency, production creation block, and T6 readiness RBAC.
const test = require("node:test"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
const topology = require("../helpers/emulatorTestTopology");
const validation = require("../../src/config/integrationEnvironment").validateIntegrationEnvironment();
assert.equal(validation.integration, true); assert.equal(validation.projectId, topology.project);
if (!topology.isolated) throw new Error("Visit safeguard acceptance requires an approved isolated emulator topology.");
for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) assert.equal(process.env[name], undefined);
const { db, auth, getStorageBucket } = require("../../src/config/firebase"), app = require("../../src/app"), visits = require("../../src/services/sampleMonitoringVisit.service");
const prefix = `visit-safeguards-${randomUUID()}`, siteId = `${prefix}-site`, reportId = `${prefix}-report`;
const readyCohort = `${prefix}-ready`, pendingCohort = `${prefix}-pending`;
const ids = Object.fromEntries(["staff", "otherStaff", "admin", "participant"].map(role => [role, `${prefix}-${role}`]));
const cleanupCreated = require("../helpers/emulatorCreatedResources").trackEmulatorCreatedResources({ db, auth, getBucket: getStorageBucket, prefix, users: ids });
const tokens = {}; let server, base;
async function api(path, role = "staff", method = "GET", body) {
  const response = await fetch(base + path, { method, headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const cohortVisits = async cohortId => (await db.collection("sampleMonitoringVisits").where("cohortId", "==", cohortId).get()).docs;
test.before(async () => {
  for (const [role, uid] of Object.entries(ids)) {
    const email = `${uid}@example.test`;
    await auth.createUser({ uid, email, password: "Local-Safeguard-Fixture-2026!", emailVerified: true });
    await db.collection("users").doc(uid).set({ role: role === "otherStaff" ? "staff" : role, status: "active", testFixture: prefix });
    const response = await fetch(`http://${topology.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Local-Safeguard-Fixture-2026!", returnSecureToken: true }) });
    assert.equal(response.status, 200); tokens[role] = (await response.json()).idToken;
  }
  await db.collection("sites").doc(siteId).set({ siteName: "Safeguard emulator site", testFixture: prefix });
  await db.collection("plantingReports").doc(reportId).set({ reportNumber: "PR-SAFEGUARD", testFixture: prefix });
  await db.collection("verifiedPlantingCohorts").doc(readyCohort).set({ source: { siteId, plantingReportId: reportId }, verifiedPlantedQuantity: 20, baselineVersion: 1,
    samplingPlan: { status: "APPROVED", version: 1, selectedSamples: [{ permanentId: "TREE-A", species: "Narra" }] },
    baseline: { approvalStatus: "APPROVED", sampleUnits: [{ permanentId: "TREE-A", condition: "Healthy" }] }, testFixture: prefix });
  await db.collection("verifiedPlantingCohorts").doc(pendingCohort).set({ source: { siteId }, verifiedPlantedQuantity: 40,
    samplingPolicySnapshot: { percentage: 10, minimum: null, policyVersion: 1 }, samplingPlan: { status: "DRAFT", version: 0 }, baseline: { approvalStatus: "REGISTERED" }, testFixture: prefix });
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const cohortId of [readyCohort, pendingCohort]) for (const doc of await cohortVisits(cohortId)) await doc.ref.delete();
  for (const [collection, id] of [["verifiedPlantingCohorts", readyCohort], ["verifiedPlantingCohorts", pendingCohort], ["sites", siteId], ["plantingReports", reportId], ...Object.values(ids).map(id => ["users", id])]) await db.collection(collection).doc(id).delete();
  await cleanupCreated(); await cleanupCreated();
  assert.equal((await cohortVisits(readyCohort)).length, 0);
});
test("real HTTP visit creation stays blocked without the isolated test flag", async () => {
  const blocked = await api(`/verified-sample-monitoring/cohorts/${readyCohort}/visits`, "staff", "POST", { visitDate: "2031-01-01" });
  assert.equal(blocked.status, 409); assert.match(blocked.body.message, /Future visit scheduling requires MENRO policy approval/);
  assert.equal((await cohortVisits(readyCohort)).length, 0);
});
test("real concurrent creations for one cohort leave exactly one open visit", async () => {
  const dates = ["2031-02-01", "2031-02-02", "2031-02-03", "2031-02-04", "2031-02-05"];
  const results = await Promise.allSettled(dates.map((visitDate, index) => visits.create({ cohortId: readyCohort, actorId: index % 2 ? ids.otherStaff : ids.staff, visitDate, testOnly: true })));
  const created = results.filter(result => result.status === "fulfilled"), refused = results.filter(result => result.status === "rejected");
  assert.equal(created.length, 1, JSON.stringify(refused.map(result => result.reason?.code || result.reason?.message)));
  for (const result of refused) assert.equal(result.reason.code, "OPEN_VISIT_EXISTS", result.reason.message);
  const stored = await cohortVisits(readyCohort);
  assert.equal(stored.length, 1); assert.equal(stored[0].id, created[0].value.id); assert.equal(stored[0].data().status, "DRAFT");
  assert.equal((await db.collection("verifiedPlantingCohorts").doc(readyCohort).get()).data().monitoringVisitCreation.lastVisitId, stored[0].id);
});
test("real readiness explains blockers to authorized Staff only", async () => {
  const staff = await api("/verified-sample-monitoring/readiness");
  assert.equal(staff.status, 200, JSON.stringify(staff.body));
  assert.equal(staff.body.data.visitCreationAvailable, false);
  const ready = staff.body.data.cohorts.find(row => row.cohortId === readyCohort), pending = staff.body.data.cohorts.find(row => row.cohortId === pendingCohort);
  assert.equal(ready.reportNumber, "PR-SAFEGUARD"); assert.equal(ready.siteName, "Safeguard emulator site");
  assert.deepEqual(ready.reasons.map(reason => reason.code), ["OPEN_VISIT_EXISTS", "VISIT_SCHEDULING_POLICY_PENDING"]);
  assert.equal(typeof ready.reasons[0].ownedByYou, "boolean");
  assert.deepEqual(pending.reasons.map(reason => reason.code), ["SAMPLING_POLICY_PENDING", "SAMPLING_PLAN_NOT_APPROVED", "BASELINE_NOT_APPROVED", "VISIT_SCHEDULING_POLICY_PENDING"]);
  assert.doesNotMatch(JSON.stringify(staff.body), new RegExp(`${ids.otherStaff}|createdBy|privateEvidence`));
  assert.equal((await api("/verified-sample-monitoring/readiness", "admin")).status, 200);
  assert.equal((await api("/verified-sample-monitoring/readiness", "participant")).status, 403);
  assert.equal((await api("/verified-sample-monitoring/readiness", null)).status, 401);
});
