// Isolated-emulator acceptance for the one-request historical correction (REQ-2026-054 shape): a Staff-encoded
// walk-in stored "Pending" before the Staff direct-to-Admin workflow is routed to Admin approval without inventing
// a Staff review, then Admin Approve/Reject work through the real API. Real Auth/Firestore/Storage emulators.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
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
  REQUEST_LETTER_STORAGE_ENABLED: 'true', REQUEST_LETTER_STORAGE_REQUIRED: 'true',
  REQUEST_IDENTIFICATION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  MENRO_UPLOAD_ROOT: path.join(os.tmpdir(), `menro-historical-correction-${randomUUID()}`),
});
const { db, auth, getStorageBucket } = require('../../src/config/firebase');
const app = require('../../src/app');
const { createHistoricalStaffRequestCorrection } = require('../../src/services/historicalStaffRequestCorrection.service');
const prefix = `historical-correction-${randomUUID()}`;
const users = Object.fromEntries(['staff', 'officer', 'participant', 'admin'].map(role => [role, `${prefix}-${role}`]));
const ownedRequestSubjects = new Map();
const cleanup = require('../helpers/emulatorCreatedResources').trackEmulatorCreatedResources({ db, auth, getBucket: getStorageBucket, prefix, users, ownedRequestSubjects, requestWorkflowArtifacts: true });
const tokens = {}, siteId = `${prefix}-site`, inventoryId = `${prefix}-inventory`;
const OPERATOR = 'operator@example.org';
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
  await db.collection('sites').doc(siteId).create({ siteName: 'Disposable correction site', barangay: 'Bical', status: 'active', maximumCapacity: 1000, planted: 0, latitude: 12.662301, longitude: 123.932983, testFixture: prefix });
  await db.collection('seedlingInventory').doc(inventoryId).create({ species: 'Narra', availableQuantity: 100, currentQuantity: 100, reservedQuantity: 0, distributedQuantity: 0, testFixture: prefix });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await cleanup(); await cleanup(); });

async function api(endpoint, role, method = 'GET', body) {
  const response = await fetch(`${base}${endpoint}`, { method, headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
function requestBody(extra = {}) {
  return { clientSubmissionId: randomUUID(), items: [{ inventoryId, quantity: 3 }], purpose: 'Household / Backyard', plantingLocation: 'Bical, Bulan', preferredReleaseDate: '2099-01-01',
    workflow: { requestContractVersion: 2, sector: 'Resident / Individual', purpose: 'Household / Backyard', addressProvince: 'Sorsogon', addressMunicipality: 'Bulan', addressBarangay: 'Bical', street: 'Fixture street', siteBarangay: 'Bical', siteMode: 'existing', existingSiteId: siteId, releaseMethod: 'Pick-up', caretaker: 'Requester', carePlan: 'Water and protect seedlings', monitoringFrequency: 'Weekly' },
    identification: { identificationType: 'national_id', idNumber: '1234-5678-9012-3456', confirmed: true },
    eventProposal: { eventName: 'Individual planting schedule', barangay: 'Bical', plantingSiteId: siteId, proposedDate: '2099-01-02', proposedStartTime: '08:00', proposedEndTime: '', eventLocation: 'Bical, Bulan', latitude: 12.662301, longitude: 123.932983, expectedParticipants: 1 },
    ...extra };
}
// Creates a walk-in through the real endpoint, then stores it exactly as the pre-fix backend did (REQ-2026-054 shape).
async function historicalWalkIn(name) {
  const body = requestBody(); body.citizen = { fullName: name, contactNumber: '09171234567', assistedByName: 'Fixture Assistant' };
  const subject = `walkin_${createHash('sha256').update(`${users.staff}:${body.clientSubmissionId}`).digest('hex').slice(0, 32)}`;
  ownedRequestSubjects.set(require('../../src/services/seedlingRequest.service').deriveSeedlingRequestDocumentId(subject, body.clientSubmissionId), subject);
  const form = new FormData(); form.append('request', JSON.stringify(body));
  const created = await api('/seedling-requests/walk-in', 'staff', 'POST', form);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const ref = db.collection('seedlingRequests').doc(created.body.data.id);
  const record = (await ref.get()).data();
  for (const key of ['submissionPath', 'staffReviewRequired', 'reviewStatus', 'submittedByUid', 'submittedByRole', 'submittedByName', 'routedToAdminAt']) delete record[key];
  record.status = 'Pending'; record.reviewHistory = record.reviewHistory.map(({ routedTo, ...entry }) => entry);
  await ref.set(record);
  return { id: ref.id, ref, record };
}
const snapshotOf = async ref => JSON.stringify((await ref.get()).data());
const countOf = async name => (await db.collection(name).get()).size;

test('the pre-fix walk-in reproduces the reported issue, then a one-request correction routes it to Admin approval without a Staff review', async () => {
  const target = await historicalWalkIn('Historical Citizen');
  const bystander = await historicalWalkIn('Unrelated Citizen');
  const bystanderBefore = await snapshotOf(bystander.ref);
  // Reported issue: Pending Review and no Admin decision possible.
  const premature = await api(`/seedling-requests/${target.id}/approve`, 'admin', 'PATCH', { expectedVersion: target.record.requestVersion });
  assert.equal(premature.status, 400, JSON.stringify(premature.body));
  // With the fixed backend, the encoder's My Requests already lists it (persisted walkIn.encodedBy).
  assert.ok((await api('/seedling-requests/my', 'staff')).body.data.some(row => row.id === target.id && row.status === 'Pending'));

  const tool = createHistoricalStaffRequestCorrection({ db, requestNumber: target.record.requestNumber, operator: OPERATOR });
  const before = await snapshotOf(target.ref); const counts = { events: await countOf('events'), notifications: await countOf('notifications'), distributions: await countOf('distributions') };
  const dry = await tool.dryRun();
  assert.deepEqual([dry.state, dry.blockers, dry.requestId, dry.current.status, dry.current.encodedBy, dry.current.participantName], ['CORRECTABLE', [], target.id, 'Pending', users.staff, 'Historical Citizen']);
  assert.deepEqual(dry.writeScope.submittedByUid, users.staff); assert.equal(dry.writeScope.otherDocumentsWritten, 0); assert.match(dry.planDigest, /^[0-9a-f]{16}$/);
  assert.equal(await snapshotOf(target.ref), before, 'the dry run writes nothing');

  for (const [args, pattern] of [[{ confirmRequestId: bystander.id, confirmPlanDigest: dry.planDigest, reason: 'Route the historical walk-in' }, /\[confirmation\].*request ID/],
    [{ confirmRequestId: target.id, confirmPlanDigest: '0000000000000000', reason: 'Route the historical walk-in' }, /\[confirmation\].*changed/],
    [{ confirmRequestId: target.id, confirmPlanDigest: dry.planDigest, reason: 'short' }, /\[reason\]/]]) {
    await assert.rejects(tool.execute(args), pattern);
    assert.equal(await snapshotOf(target.ref), before, 'a refused correction writes nothing');
  }

  const result = await tool.execute({ confirmRequestId: target.id, confirmPlanDigest: dry.planDigest, reason: 'Route the pre-fix Staff walk-in to Admin approval' });
  assert.equal(result.status, 'CORRECTED'); assert.equal(result.postVerification.ok, true, JSON.stringify(result.postVerification.problems));
  const after = (await target.ref.get()).data();
  assert.deepEqual([after.status, after.submissionPath, after.staffReviewRequired, after.reviewStatus, after.submittedByUid, after.submittedByRole, after.requestVersion],
    ['Reviewed', 'STAFF_DIRECT_TO_ADMIN', false, 'Not Required', users.staff, 'staff', target.record.requestVersion + 1]);
  assert.deepEqual([after.historicalCorrection.correctedBy, after.historicalCorrection.previousStatus, after.reviewHistory.at(-1).action, after.reviewHistory.at(-1).actorRole],
    [OPERATOR, 'Pending', 'routed_to_admin_approval', 'operator']);
  // Citizen, quantities, schedule, walk-in record and audit history are preserved; no review exists.
  for (const field of ['participantId', 'participantName', 'items', 'totalQuantity', 'eventProposal', 'walkIn', 'workflow', 'originalSchedule', 'createdAt'])
    assert.deepEqual(after[field], target.record[field], field);
  assert.deepEqual(after.reviewHistory.slice(0, -1), target.record.reviewHistory);
  for (const field of ['reviewId', 'reviewedBy', 'reviewedByUid', 'reviewedByName']) assert.equal(after[field] || '', '', field);
  assert.equal(after.reviewHistory.some(entry => entry.action === 'reviewed'), false);
  assert.equal(await snapshotOf(bystander.ref), bystanderBefore, 'no other request changes');
  assert.deepEqual({ events: await countOf('events'), notifications: await countOf('notifications'), distributions: await countOf('distributions') }, counts, 'only the one request document is written');
  assert.equal((await db.collection('seedlingInventory').doc(inventoryId).get()).data().currentQuantity, 100);

  // Reads through the fixed backend never invent a review; repeat is idempotent.
  const listed = (await api('/seedling-requests', 'admin')).body.data.find(row => row.id === target.id);
  assert.equal(listed.status, 'Reviewed'); assert.equal(listed.reviewId || '', ''); assert.equal(listed.reviewedByName || '', '');
  assert.ok((await api('/seedling-requests/my', 'staff')).body.data.some(row => row.id === target.id && row.status === 'Reviewed'));
  assert.ok(!(await api('/seedling-requests/my', 'officer')).body.data.some(row => row.id === target.id));
  assert.equal((await tool.dryRun()).state, 'ALREADY_CORRECTED');
  const unchanged = await snapshotOf(target.ref);
  assert.equal((await tool.execute({ confirmRequestId: target.id, confirmPlanDigest: dry.planDigest, reason: 'Route the pre-fix Staff walk-in to Admin approval' })).status, 'NO_CHANGE');
  assert.equal(await snapshotOf(target.ref), unchanged);

  // Admin decides directly; Staff review is refused; the encoder cannot approve.
  const review = await api(`/seedling-requests/${target.id}/review`, 'officer', 'PATCH', { expectedVersion: after.requestVersion, items: after.items, purpose: after.purpose, plantingLocation: after.plantingLocation, preferredReleaseDate: after.preferredReleaseDate });
  assert.equal(review.status, 409, JSON.stringify(review.body));
  assert.equal((await api(`/seedling-requests/${target.id}/approve`, 'staff', 'PATCH', { expectedVersion: after.requestVersion })).status, 403);
  const approved = await api(`/seedling-requests/${target.id}/approve`, 'admin', 'PATCH', { expectedVersion: after.requestVersion });
  assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.data.status, 'Approved');
  assert.equal(approved.body.data.participantName, 'Historical Citizen'); assert.equal(approved.body.data.reviewId || '', '');
  const event = (await db.collection('events').doc(approved.body.data.eventId).get()).data();
  assert.equal(event.sourceRequestId, target.id); assert.equal(String(event.date || event.eventDate).slice(0, 10), '2099-01-02');
  assert.equal((await db.collection('seedlingInventory').doc(inventoryId).get()).data().currentQuantity, 100, 'approval never deducts inventory');
  assert.equal((await tool.dryRun()).state, 'BLOCKED', 'an approved request is never re-corrected');

  // Reject also works on a corrected request.
  const second = await historicalWalkIn('Second Historical Citizen');
  const secondTool = createHistoricalStaffRequestCorrection({ db, requestNumber: second.record.requestNumber, operator: OPERATOR });
  const secondDry = await secondTool.dryRun();
  await secondTool.execute({ confirmRequestId: second.id, confirmPlanDigest: secondDry.planDigest, reason: 'Route the pre-fix Staff walk-in to Admin approval' });
  const rejected = await api(`/seedling-requests/${second.id}/reject`, 'admin', 'PATCH', { expectedVersion: second.record.requestVersion + 1, reason: 'Species unavailable this season' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body)); assert.equal(rejected.body.data.status, 'Rejected');
});

test('preconditions block a reviewed, schedule-pending, non-walk-in or ambiguous request without writing', async () => {
  const reviewedRequest = await historicalWalkIn('Reviewed Citizen');
  await reviewedRequest.ref.update({ reviewedBy: users.officer, reviewedByUid: users.officer, reviewId: 'REV-2026-900' });
  const scheduleRequest = await historicalWalkIn('Schedule Citizen');
  await scheduleRequest.ref.update({ preApprovalSchedule: { status: 'AwaitingRequesterConfirmation', plantingDate: '2099-01-05', startTime: '09:00', proposalVersion: 1 } });
  const participant = await api('/seedling-requests', 'participant', 'POST', requestBody());
  assert.equal(participant.status, 201, JSON.stringify(participant.body));
  const pastRequest = await historicalWalkIn('Past Schedule Citizen');
  await pastRequest.ref.update({ 'eventProposal.proposedDate': '2020-01-02' });
  for (const [id, number, blocker] of [[reviewedRequest.id, reviewedRequest.record.requestNumber, 'STAFF_REVIEW_ALREADY_RECORDED'], [scheduleRequest.id, scheduleRequest.record.requestNumber, 'SCHEDULE_CONFIRMATION_PENDING'],
    [participant.body.data.id, participant.body.data.requestNumber, 'NOT_A_STAFF_ENCODED_WALK_IN'], [pastRequest.id, pastRequest.record.requestNumber, 'SCHEDULE_NOT_IN_FUTURE']]) {
    const ref = db.collection('seedlingRequests').doc(id); const before = await snapshotOf(ref);
    const tool = createHistoricalStaffRequestCorrection({ db, requestNumber: number, operator: OPERATOR });
    const dry = await tool.dryRun();
    assert.equal(dry.state, 'BLOCKED'); assert.ok(dry.blockers.includes(blocker), `${blocker}: ${dry.blockers}`); assert.equal(dry.writeScope, null);
    await assert.rejects(tool.execute({ confirmRequestId: id, confirmPlanDigest: dry.planDigest, reason: 'Attempt a blocked correction' }), /\[preconditions\]/);
    assert.equal(await snapshotOf(ref), before);
  }
  // Duplicate request numbers are refused before any write.
  const duplicate = await historicalWalkIn('Duplicate Number Citizen');
  await db.collection('seedlingRequests').doc(`${prefix}-duplicate`).set({ ...duplicate.record, testFixture: prefix });
  await assert.rejects(createHistoricalStaffRequestCorrection({ db, requestNumber: duplicate.record.requestNumber, operator: OPERATOR }).dryRun(), /\[target\].*found 2/);
  await db.collection('seedlingRequests').doc(`${prefix}-duplicate`).delete();
});
