const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const topology = require('../helpers/emulatorTestTopology');
assert.equal(topology.isolated, true, 'This new workflow acceptance requires disposable isolated emulators');
for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_CONFIG']) assert.equal(process.env[key], undefined);
Object.assign(process.env, {
  NODE_ENV: 'test', MENRO_INTEGRATION_TEST: 'true', MENRO_REQUEST_LETTER_ACCEPTANCE: 'true',
  GCLOUD_PROJECT: topology.project, FIREBASE_PROJECT_ID: topology.project,
  FIRESTORE_EMULATOR_HOST: topology.firestore, FIREBASE_AUTH_EMULATOR_HOST: topology.auth,
  FIREBASE_STORAGE_EMULATOR_HOST: topology.storage, FIREBASE_STORAGE_BUCKET: topology.bucket,
  EVIDENCE_STORAGE_PROVIDER: 'firebase', EVIDENCE_CLOUD_WORKFLOW_ENABLED: 'true', EVIDENCE_CLOUD_READ_ENABLED: 'true',
  REQUEST_LETTER_STORAGE_ENABLED: 'true', REQUEST_LETTER_STORAGE_REQUIRED: 'true',
  REQUEST_IDENTIFICATION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-coordinated-request-${randomUUID()}`),
});
const { db, auth, getStorageBucket } = require('../../src/config/firebase');
const app = require('../../src/app');
const prefix = `coordinated-request-${randomUUID()}`;
const users = Object.fromEntries(['staff', 'officer', 'participant', 'admin'].map(role => [role, `${prefix}-${role}`]));
const ownedRequestSubjects = new Map();
const cleanup = require('../helpers/emulatorCreatedResources').trackEmulatorCreatedResources({ db, auth, getBucket: getStorageBucket, prefix, users, ownedRequestSubjects, requestWorkflowArtifacts: true });
const tokens = {}, siteId = `${prefix}-site`, inventoryId = `${prefix}-inventory`;
let server, base, firstApprovedRequest;
test.before(async () => {
  assert.equal(db.projectId, topology.project);
  for (const [role, uid] of Object.entries(users)) {
    const email = `${uid}@example.test`, password = 'Disposable-Workflow-2026!';
    await auth.createUser({ uid, email, password, emailVerified: true });
    await db.collection('users').doc(uid).create({ role: role === 'officer' ? 'staff' : role, status: 'active', fullName: `Fixture ${role}`, contactNumber: '09123456789', testFixture: prefix });
    const response = await fetch(`http://${topology.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    assert.equal(response.status, 200); tokens[role] = (await response.json()).idToken;
  }
  await db.collection('sites').doc(siteId).create({ siteName: 'Disposable workflow site', barangay: 'Bical', status: 'active', maximumCapacity: 1000, planted: 0, latitude: 12.662301, longitude: 123.932983, testFixture: prefix });
  await db.collection('seedlingInventory').doc(inventoryId).create({ species: 'Narra', availableQuantity: 100, currentQuantity: 100, reservedQuantity: 0, distributedQuantity: 0, testFixture: prefix });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await cleanup(); await cleanup(); });
async function api(endpoint, role, method = 'GET', body) {
  const response = await fetch(`${base}${endpoint}`, { method, headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
  return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : { bytes: (await response.arrayBuffer()).byteLength } };
}
function request() {
  return { clientSubmissionId: randomUUID(), items: [{ inventoryId, quantity: 2 }], purpose: 'Household / Backyard', plantingLocation: 'Bical, Bulan', preferredReleaseDate: '2099-01-01',
    workflow: { requestContractVersion: 2, sector: 'Student (Individual)', schoolName: 'Disposable Fixture School', purpose: 'Household / Backyard', addressProvince: 'Sorsogon', addressMunicipality: 'Bulan', addressBarangay: 'Bical', street: 'Fixture street', siteBarangay: 'Bical', siteMode: 'existing', existingSiteId: siteId, areaChoice: 'Other / Exact Area', exactArea: '0.5', releaseMethod: 'Pick-up', caretaker: 'Requester', carePlan: 'Water and protect seedlings', monitoringFrequency: 'Weekly' },
    identification: { identificationType: 'national_id', idNumber: '1234-5678-9012-3456', confirmed: true },
    eventProposal: { eventName: 'Individual planting schedule', barangay: 'Bical', plantingSiteId: siteId, proposedDate: '2099-01-02', proposedStartTime: '08:00', proposedEndTime: '', eventLocation: 'Bical, Bulan', latitude: 12.662301, longitude: 123.932983, expectedParticipants: 1 } };
}
async function processRequest(created) {
  const request = created.body.data;
  let version = request.requestVersion;
  if (request.submissionPath === 'STAFF_DIRECT_TO_ADMIN') {
    // Staff-submitted (own or walk-in): Awaiting Approval directly; Staff review is refused, nothing is written.
    assert.equal(request.status, 'Reviewed'); assert.equal(request.reviewStatus, 'Not Required');
    const refused = await api(`/seedling-requests/${request.id}/review`, 'officer', 'PATCH', { expectedVersion: request.requestVersion, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate });
    assert.equal(refused.status, 409, JSON.stringify(refused.body)); assert.equal(refused.body.code, 'STAFF_REVIEW_NOT_REQUIRED');
  } else {
    const reviewed = await api(`/seedling-requests/${request.id}/review`, 'officer', 'PATCH', { expectedVersion: request.requestVersion, items: request.items, purpose: request.purpose, plantingLocation: request.plantingLocation, preferredReleaseDate: request.preferredReleaseDate });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    version = reviewed.body.data.requestVersion;
  }
  const approved = await api(`/seedling-requests/${request.id}/approve`, 'admin', 'PATCH', { expectedVersion: version });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const released = await api(`/seedling-requests/${request.id}/release`, 'officer', 'PATCH', { expectedVersion: approved.body.data.requestVersion, availableReleaseDate: '2099-01-01', items: [{ inventoryId, releasedQuantity: 2 }] });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.data.reportingPolicy.reporting, 'NOT_REQUIRED');
  assert.equal(released.body.data.reportingPolicy.reportingOverdueApplicable, false);
  return released.body.data;
}
test('real Auth/Firestore Student request snapshots policy, releases inventory once and creates no permanent visit', async () => {
  const created = await api('/seedling-requests', 'staff', 'POST', request());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.participantId, users.staff); assert.equal(created.body.data.workflow.effectiveRequestType, 'individual');
  const released = await processRequest(created); firstApprovedRequest = released.id;
  assert.equal((await db.collection('distributions').doc(released.id).get()).data().reportingPolicy.reporting, 'NOT_REQUIRED');
  assert.equal((await db.collection('sampleMonitoringVisits').where('sourceRequestId', '==', released.id).get()).empty, true);
});
test('real Staff walk-in stores private signed acknowledgement, separates citizen and encoder, and follows Admin approval/release', async () => {
  const body = request(); body.citizen = { fullName: 'Actual Disposable Citizen', contactNumber: '09171234567', assistedByName: 'Fixture Assistant', receiptReference: `${prefix}-receipt` };
  const subject = `walkin_${createHash('sha256').update(`${users.staff}:${body.clientSubmissionId}`).digest('hex').slice(0, 32)}`;
  ownedRequestSubjects.set(require('../../src/services/seedlingRequest.service').deriveSeedlingRequestDocumentId(subject, body.clientSubmissionId), subject);
  const form = new FormData(); form.append('request', JSON.stringify(body));
  form.append('acknowledgement', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQkAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'signed.png');
  const created = await api('/seedling-requests/walk-in', 'staff', 'POST', form);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const record = created.body.data; assert.notEqual(record.participantId, users.staff); assert.equal(record.walkIn.encodedBy, users.staff);
  const privateAck = (await db.collection('walkInAcknowledgements').doc(record.id).get()).data();
  assert.equal(privateAck.requestId, record.id); assert.equal((await getStorageBucket().file(privateAck.descriptor.objectName).exists())[0], true);
  assert.equal(JSON.stringify(created.body).includes('request-letters/v1/'), false);
  assert.equal((await api(`/seedling-requests/${record.id}/acknowledgement`, 'participant')).status, 403);
  const retrieval = await api(`/seedling-requests/${record.id}/acknowledgement`, 'admin'); assert.equal(retrieval.status, 200); assert.ok(retrieval.body.bytes > 0);
  // Staff-encoded walk-in: Awaiting Approval directly (citizen stays the requester; encoder is the submitter).
  assert.deepEqual([record.status, record.submissionPath, record.submittedByUid, record.participantName], ['Reviewed', 'STAFF_DIRECT_TO_ADMIN', users.staff, 'Actual Disposable Citizen']);
  const mine = await api('/seedling-requests/my', 'staff'); assert.equal(mine.status, 200);
  assert.ok(mine.body.data.some(row => row.id === record.id), "the encoder's My Requests lists the walk-in (real nested query)");
  assert.ok(!(await api('/seedling-requests/my', 'officer')).body.data.some(row => row.id === record.id));
  const listed = (await api('/seedling-requests', 'admin')).body.data.find(row => row.id === record.id);
  assert.equal(listed.reviewId || '', ''); assert.equal(listed.reviewedByName || '', '', 'a list read never invents a Staff review');
  const stored = (await db.collection('seedlingRequests').doc(record.id).get()).data();
  assert.equal(stored.reviewId || '', ''); assert.equal(stored.reviewStatus, 'Not Required');
  assert.equal((await db.collection('notifications').where('relatedRecordId', '==', record.id).where('type', '==', 'request_awaiting_admin_approval').get()).size, 1);
  await processRequest(created);
});
test('real Admin policy versions do not retroactively change a released request snapshot', async () => {
  assert.equal((await api('/purpose-policies', 'staff')).status, 403);
  const initial = await api('/purpose-policies', 'admin'); assert.equal(initial.status, 200);
  const settings = { ...initial.body.data, expectedVersion: initial.body.data.version, effectiveDate: '2020-01-01', reason: 'Disposable emulator policy audit' };
  settings.purposes[0].reporting = 'REQUIRED';
  const saved = await api('/purpose-policies', 'admin', 'PUT', settings); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.updatedBy, users.admin);
  assert.equal((await api('/purpose-policies', 'admin', 'PUT', settings)).status, 409);
  const request = (await db.collection('seedlingRequests').doc(firstApprovedRequest).get()).data();
  assert.equal(request.reportingPolicy.reporting, 'NOT_REQUIRED'); assert.equal(request.approvedPurposePolicy.policyVersion, initial.body.data.version);
});
