// Isolated-emulator acceptance: an unresolved purpose policy no longer blocks Admin approval. The request is
// approved with PENDING_MENRO_POLICY, its scheduled event is created, seedlings are released once, reporting stays
// "Reporting Policy Pending" (not required, not exempt), and no permanent-sample cohort is created.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const topology = require('../helpers/emulatorTestTopology');
assert.equal(topology.isolated, true, 'This acceptance requires disposable isolated emulators');
for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_CONFIG']) assert.equal(process.env[key], undefined);
Object.assign(process.env, {
  NODE_ENV: 'test', MENRO_INTEGRATION_TEST: 'true', MENRO_REQUEST_LETTER_ACCEPTANCE: 'true',
  GCLOUD_PROJECT: topology.project, FIREBASE_PROJECT_ID: topology.project,
  FIRESTORE_EMULATOR_HOST: topology.firestore, FIREBASE_AUTH_EMULATOR_HOST: topology.auth,
  FIREBASE_STORAGE_EMULATOR_HOST: topology.storage, FIREBASE_STORAGE_BUCKET: topology.bucket,
  EVIDENCE_STORAGE_PROVIDER: 'firebase', EVIDENCE_CLOUD_WORKFLOW_ENABLED: 'true', EVIDENCE_CLOUD_READ_ENABLED: 'true',
  REQUEST_LETTER_STORAGE_ENABLED: 'true', REQUEST_LETTER_STORAGE_REQUIRED: 'true', VERIFIED_PLANTING_COHORT_ENABLED: 'true',
  REQUEST_IDENTIFICATION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-pending-policy-${randomUUID()}`),
});
const { db, auth, getStorageBucket } = require('../../src/config/firebase');
const app = require('../../src/app');
const prefix = `pending-policy-${randomUUID()}`;
const users = Object.fromEntries(['staff', 'officer', 'admin'].map(role => [role, `${prefix}-${role}`]));
const cleanup = require('../helpers/emulatorCreatedResources').trackEmulatorCreatedResources({ db, auth, getBucket: getStorageBucket, prefix, users, ownedRequestSubjects: new Map(), requestWorkflowArtifacts: true });
const tokens = {}, siteId = `${prefix}-site`, inventoryId = `${prefix}-inventory`;
let server, base;
test.before(async () => {
  assert.equal(db.projectId, topology.project);
  for (const [role, uid] of Object.entries(users)) {
    const email = `${uid}@example.test`, password = 'Disposable-Workflow-2026!';
    await auth.createUser({ uid, email, password, emailVerified: true });
    await db.collection('users').doc(uid).create({ role: role === 'officer' ? 'staff' : role, status: 'active', fullName: `Fixture ${role}`, contactNumber: '09123456789', testFixture: prefix });
    const response = await fetch(`http://${topology.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    assert.equal(response.status, 200); tokens[role] = (await response.json()).idToken;
  }
  await db.collection('sites').doc(siteId).create({ siteName: 'Disposable pending-policy site', barangay: 'Bical', status: 'active', maximumCapacity: 1000, planted: 0, latitude: 12.662301, longitude: 123.932983, testFixture: prefix });
  await db.collection('seedlingInventory').doc(inventoryId).create({ species: 'Narra', availableQuantity: 100, currentQuantity: 100, reservedQuantity: 0, distributedQuantity: 0, testFixture: prefix });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await cleanup(); await cleanup(); });
async function api(endpoint, role, method = 'GET', body) {
  const response = await fetch(`${base}${endpoint}`, { method, headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
function otherPurposeRequest() {
  return { clientSubmissionId: randomUUID(), items: [{ inventoryId, quantity: 2 }], purpose: 'Community special planting', plantingLocation: 'Bical, Bulan', preferredReleaseDate: '2099-01-01',
    workflow: { requestContractVersion: 2, sector: 'Resident / Individual', purpose: 'Other', purposeOther: 'Community special planting', addressProvince: 'Sorsogon', addressMunicipality: 'Bulan', addressBarangay: 'Bical', street: 'Fixture street', siteBarangay: 'Bical', siteMode: 'existing', existingSiteId: siteId,
      areaChoice: 'Other / Exact Area', exactArea: '0.5', releaseMethod: 'Pick-up', caretaker: 'Requester', carePlan: 'Water and protect seedlings', monitoringFrequency: 'Weekly' },
    identification: { identificationType: 'national_id', idNumber: '1234-5678-9012-3456', confirmed: true },
    eventProposal: { eventName: 'Individual planting schedule', barangay: 'Bical', plantingSiteId: siteId, proposedDate: '2099-01-02', proposedStartTime: '08:00', proposedEndTime: '', eventLocation: 'Bical, Bulan', latitude: 12.662301, longitude: 123.932983, expectedParticipants: 1 } };
}

test('unresolved purpose policy: approval, scheduled event and single release proceed; reporting stays pending; no cohort', async () => {
  const created = await api('/seedling-requests', 'staff', 'POST', otherPurposeRequest());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const request = created.body.data;
  assert.equal(request.purposePolicyManaged, true);
  // A Staff submission goes directly to Admin approval (Awaiting Approval); Staff review is refused.
  assert.deepEqual([request.status, request.submissionPath, request.reviewStatus], ['Reviewed', 'STAFF_DIRECT_TO_ADMIN', 'Not Required']);

  const refusedReview = await api(`/seedling-requests/${request.id}/review`, 'officer', 'PATCH', { expectedVersion: request.requestVersion, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate });
  assert.equal(refusedReview.status, 409, JSON.stringify(refusedReview.body));
  const reviewed = { body: { data: request } };
  // RBAC and version guards are unchanged.
  assert.equal((await api(`/seedling-requests/${request.id}/approve`, 'officer', 'PATCH', { expectedVersion: reviewed.body.data.requestVersion })).status, 403);
  assert.equal((await api(`/seedling-requests/${request.id}/approve`, 'admin', 'PATCH', { expectedVersion: reviewed.body.data.requestVersion + 5 })).status, 409);
  const invalid = await api(`/seedling-requests/${request.id}/approve`, 'admin', 'PATCH', { expectedVersion: reviewed.body.data.requestVersion, policyDecision: { reporting: 'PENDING_MENRO_POLICY', monitoring: 'NONE', reason: 'not a decision' } });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal((await db.collection('seedlingRequests').doc(request.id).get()).data().status, 'Reviewed', 'a rejected decision saves nothing');

  const approved = await api(`/seedling-requests/${request.id}/approve`, 'admin', 'PATCH', { expectedVersion: reviewed.body.data.requestVersion });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const snapshot = approved.body.data.approvedPurposePolicy;
  assert.equal(approved.body.data.status, 'Approved');
  assert.equal(snapshot.policyStatus, 'PENDING_MENRO_POLICY'); assert.deepEqual(snapshot.pendingReasons, ['OTHER_PURPOSE', 'CONDITIONAL_THRESHOLD_PENDING']);
  assert.equal(snapshot.definition.reporting, 'PENDING_MENRO_POLICY'); assert.equal(snapshot.definition.monitoring, 'PENDING_MENRO_POLICY');
  // The approved Event Calendar schedule is created from the request and not overridden.
  const eventId = approved.body.data.eventId;
  assert.ok(eventId); assert.equal(approved.body.data.eventCreated, true);
  const event = (await db.collection('events').doc(eventId).get()).data();
  assert.equal(String(event.date || event.eventDate).slice(0, 10), '2099-01-02');
  // Approval alone never touches inventory.
  assert.equal((await db.collection('seedlingInventory').doc(inventoryId).get()).data().currentQuantity, 100);

  const released = await api(`/seedling-requests/${request.id}/release`, 'officer', 'PATCH', { expectedVersion: approved.body.data.requestVersion, availableReleaseDate: '2099-01-01', items: [{ inventoryId, releasedQuantity: 2 }] });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const policy = released.body.data.reportingPolicy;
  assert.equal(policy.reporting, 'PENDING_POLICY'); assert.equal(policy.reportingStatus, 'Reporting Policy Pending');
  assert.equal(policy.reportingOverdueApplicable, false); assert.equal(policy.monitoring, 'PENDING_MENRO_POLICY');
  const again = await api(`/seedling-requests/${request.id}/release`, 'officer', 'PATCH', { expectedVersion: released.body.data.requestVersion, availableReleaseDate: '2099-01-01', items: [{ inventoryId, releasedQuantity: 2 }] });
  assert.notEqual(again.status, 200, 'seedlings are released only once');
  assert.equal((await db.collection('seedlingInventory').doc(inventoryId).get()).data().currentQuantity, 98);
  const events = await db.collection('events').where('sourceRequestId', '==', request.id).get();
  assert.ok(events.size <= 1, 'no duplicate event');

  // The parent planting report keeps the pending policy; verification would not create a permanent-sample cohort.
  const parent = (await db.collection('plantingReports').doc(`event_${eventId}`).get()).data();
  assert.equal(parent.reportingPolicy.reporting, 'PENDING_POLICY'); assert.equal(parent.reportingPolicy.monitoring, 'PENDING_MENRO_POLICY');
  const { ensureCohortForAuthoritativeReportInTransaction } = require('../../src/services/verifiedPlantingCohort.service');
  const cohort = await db.runTransaction(transaction => ensureCohortForAuthoritativeReportInTransaction(transaction, { reportId: `event_${eventId}`, report: { ...parent, acceptedQuantity: 2, quantityPlanted: 2 } }));
  assert.equal(cohort, null);
  assert.equal((await db.collection('verifiedPlantingCohorts').where('source.plantingReportId', '==', `event_${eventId}`).get()).empty, true);
  assert.equal((await db.collection('sampleMonitoringVisits').where('sourceRequestId', '==', request.id).get()).empty, true);
});
