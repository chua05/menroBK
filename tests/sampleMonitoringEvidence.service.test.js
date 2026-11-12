const test = require("node:test");
const assert = require("node:assert/strict");

const rows = new Map();
const operations = new Map();
const revisions = new Map();
const uploadIntents = new Map();

const table = name => {
  if (!rows.has(name)) rows.set(name, new Map());
  return rows.get(name);
};

const ref = (collectionName, id) => ({
  id,
  collectionName,
  get: async () => {
    const value = table(collectionName).get(id);
    return { id, exists: value !== undefined, data: () => value };
  },
});

const documentKey = document => `${document.collectionName}/${document.id}`;
const revisionOf = document => revisions.get(documentKey(document)) || 0;

const db = {
  collection: name => ({ doc: id => ref(name, id) }),
  runTransaction: async callback => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reads = new Map();
      const writes = [];
      const tx = {
        get: async document => {
          reads.set(documentKey(document), revisionOf(document));
          return document.get();
        },
        update: (document, value) => writes.push([document, value, false]),
        create: (document, value) => writes.push([document, value, true]),
      };

      await callback(tx);
      const conflicted = [...reads].some(([key, revision]) =>
        (revisions.get(key) || 0) !== revision,
      );
      if (conflicted) continue;
      if (failNextFirestoreCommit) {
        failNextFirestoreCommit = false;
        throw new Error("simulated Firestore commit failure");
      }

      for (const [document, value, create] of writes) {
        const current = table(document.collectionName).get(document.id);
        table(document.collectionName).set(
          document.id,
          create ? value : { ...current, ...value },
        );
        if (
          document.collectionName === "captureSessions" &&
          current?.state !== "CONSUMED" &&
          value.state === "CONSUMED"
        ) {
          consumed += 1;
        }
        if (
          document.collectionName === "evidenceOperations" &&
          current?.status !== "COMPLETED" &&
          value.status === "COMPLETED"
        ) {
          linked += 1;
        }
        if (document.collectionName === "uploadIntents") {
          uploadIntents.get(document.id).status = value.status;
        }
        revisions.set(documentKey(document), revisionOf(document) + 1);
      }
      return;
    }

    throw Object.assign(new Error("transaction conflict"), { status: 409 });
  },
};

let enabled = true;
let captureEvidenceAllowed = true;
let consumed = 0;
let linked = 0;
let failNextStorageUpload = false;
let failNextFirestoreCommit = false;
let loseNextAcknowledgement = false;
let now = 0;

for (const [path, exports] of [
  ["../src/config/firebase", { db }],
  [
    "../src/config/verifiedPlantingCohort",
    { resolveVerifiedPlantingCohortConfig: () => ({ enabled }) },
  ],
  [
    "../src/services/evidenceCaptureSession.service",
    {
      resolveSubmissionEvidence: async () => captureEvidenceAllowed ? [
        {
          id: "session",
          imageSha256: "hash",
          latitude: 13,
          longitude: 124,
          accuracyMeters: 5,
        },
      ] : [null],
      prepareConsumption: async (transaction, sessions) => {
        const records = await Promise.all(
          sessions.map(session => transaction.get(ref("captureSessions", session.id))),
        );
        if (records.some(record => record.data()?.state !== "VERIFIED")) {
          throw Object.assign(new Error("capture replayed"), { status: 409 });
        }
        return recordId => {
          for (const session of sessions) {
            transaction.update(ref("captureSessions", session.id), {
              state: "CONSUMED",
              consumedRecordId: recordId,
            });
          }
        };
      },
    },
  ],
  [
    "../src/services/evidenceWorkflow.service",
    {
      resolveCompletedOperation: async (operation, resolve) => {
        const key = `${operation.actor.uid}:${operation.key}`;
        const payloadHash = JSON.stringify({
          payload: operation.payload,
          binding: operation.binding,
          files: operation.files.map(file => file.buffer.toString("hex")),
        });
        const durable = operations.get(key);
        if (!durable) return null;
        if (durable.payloadHash !== payloadHash) {
          throw Object.assign(new Error("idempotency conflict"), { status: 409 });
        }
        return durable.status === "COMPLETED" ? resolve(durable.result) : null;
      },
      runWorkflow: async (operation, callback) => {
        const key = `${operation.actor.uid}:${operation.key}`;
        const payloadHash = JSON.stringify({
          payload: operation.payload,
          binding: operation.binding,
          files: operation.files.map(file => file.buffer.toString("hex")),
        });
        let durable = operations.get(key);

        if (durable) {
          if (durable.payloadHash !== payloadHash) {
            throw Object.assign(new Error("idempotency conflict"), { status: 409 });
          }
          if (durable.status === "COMPLETED") return durable.result;
          if (durable.promise) return durable.promise;
          if (durable.leaseUntil > now) {
            throw Object.assign(new Error("evidence in progress"), { status: 202 });
          }
        } else {
          durable = {
            id: key,
            payloadHash,
            binding: operation.binding,
            intentId: `${key}:intent-0`,
          };
        }

        durable.status = "RUNNING";
        durable.leaseUntil = now + 100;
        table("evidenceOperations").set(durable.id, { status: "RUNNING" });
        const promise = Promise.resolve().then(() => callback(durable));
        durable.promise = promise;
        operations.set(key, durable);
        try {
          const result = await promise;
          durable.status = "COMPLETED";
          durable.leaseUntil = 0;
          durable.result = result;
          delete durable.promise;
          if (loseNextAcknowledgement) {
            loseNextAcknowledgement = false;
            throw new Error("simulated lost acknowledgement");
          }
          return result;
        } catch (error) {
          if (durable.status !== "COMPLETED") {
            durable.status = "RETRYABLE";
            durable.leaseUntil = 0;
            delete durable.promise;
          }
          throw error;
        }
      },
      workflow: () => ({
        resolveCompletedOperation: async (operation, resolve) => {
          const key = `${operation.actor.uid}:${operation.key}`;
          const payloadHash = JSON.stringify({
            payload: operation.payload,
            binding: operation.binding,
            files: operation.files.map(file => file.buffer.toString("hex")),
          });
          const durable = operations.get(key);
          if (!durable) return null;
          if (durable.payloadHash !== payloadHash) {
            throw Object.assign(new Error("idempotency conflict"), { status: 409 });
          }
          return durable.status === "COMPLETED" ? resolve(durable.result) : null;
        },
        upload: async (operation) => {
          if (failNextStorageUpload) {
            failNextStorageUpload = false;
            throw new Error("simulated private Storage failure");
          }
          uploadIntents.set(operation.intentId, {
            status: "UPLOADED",
            reference: { objectName: "private" },
          });
          table("uploadIntents").set(operation.intentId, {
            status: "UPLOADED",
            reference: { objectName: "private" },
          });
          return {
            sha256: "hash",
            imageSha256: "hash",
            privateEvidence: { objectName: "private" },
          };
        },
        prepareLink: async (transaction, operation) => () => {
          transaction.update(ref("evidenceOperations", operation.id), {
            status: "COMPLETED",
          });
          transaction.update(ref("uploadIntents", operation.intentId), {
            status: "LINKED",
          });
        },
      }),
    },
  ],
]) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { exports };
}

const servicePath = require.resolve("../src/services/sampleMonitoringEvidence.service");
let service = require(servicePath);

function restartService() {
  delete require.cache[servicePath];
  service = require(servicePath);
}

function seed() {
  captureEvidenceAllowed = true;
  rows.clear();
  operations.clear();
  revisions.clear();
  uploadIntents.clear();
  enabled = true;
  consumed = 0;
  linked = 0;
  failNextStorageUpload = false;
  failNextFirestoreCommit = false;
  loseNextAcknowledgement = false;
  now = 0;

  table("sampleMonitoringVisits").set("v", {
    cohortId: "c",
    siteId: "site",
    createdBy: "staff",
    status: "DRAFT",
    version: 1,
    samplingPlanVersion: 1,
    baselineVersion: 1,
    sampleAssessments: [
      { sampleId: "TREE-001", assessmentRevision: 0, condition: "Healthy" },
    ],
  });
  table("verifiedPlantingCohorts").set("c", {
    samplingPlan: { status: "APPROVED", version: 1 },
    baseline: { approvalStatus: "APPROVED" },
    baselineVersion: 1,
  });
  table("captureSessions").set("session", { state: "VERIFIED" });
  table("evidenceOperations").set("operation", { status: "RUNNING" });
}

const input = () => ({
  visitId: "v",
  sampleId: "TREE-001",
  assessmentRevision: 0,
  expectedVisitVersion: 1,
  actorId: "staff",
  files: [{ buffer: Buffer.from("x") }],
  evidenceManifest: [{ captureSessionId: "session" }],
  idempotencyKey: "valid_key_123",
});

const operationPayloadHash = request =>
  JSON.stringify({
    payload: {
      visitId: request.visitId,
      sampleId: request.sampleId,
      assessmentRevision: request.assessmentRevision,
      expectedVisitVersion: request.expectedVisitVersion,
    },
    binding: {
      cohortId: "c",
      siteId: "site",
      visitId: request.visitId,
      sampleId: request.sampleId,
      samplingPlanVersion: 1,
      baselineVersion: 1,
      visitVersion: request.expectedVisitVersion,
      assessmentRevision: request.assessmentRevision,
      captureSessionId: request.evidenceManifest?.[0]?.captureSessionId || "",
    },
    files: request.files.map(file => file.buffer.toString("hex")),
  });

test("links immutable evidence only after all cohort and visit reads validate", async () => {
  seed();

  const out = await service.upload(input());

  assert.deepEqual(out, { visitId: "v", sampleId: "TREE-001" });
  const assessment = table("sampleMonitoringVisits").get("v").sampleAssessments[0];
  assert.equal(assessment.evidenceHistory.length, 1);
  assert.equal(table("sampleMonitoringEvidenceHashes").has("hash"), true);
  assert.deepEqual(operations.get("staff:valid_key_123").binding, {
    cohortId: "c", siteId: "site", visitId: "v", sampleId: "TREE-001",
    samplingPlanVersion: 1, baselineVersion: 1, visitVersion: 1,
    assessmentRevision: 0, captureSessionId: "session",
  });
  assert.equal(consumed, 1);
  assert.equal(linked, 1);
});

test("returns the acknowledged result without repeating per-tree linkage", async () => {
  seed();

  const first = await service.upload(input());
  const second = await service.upload(input());

  assert.deepEqual(second, first);
  const assessment = table("sampleMonitoringVisits").get("v").sampleAssessments[0];
  assert.equal(assessment.evidenceHistory.length, 1);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 1);
  assert.equal(consumed, 1);
  assert.equal(linked, 1);
});

test("an exact completed retry is read-only after the visit is approved", async () => {
  seed();
  const first = await service.upload(input());
  table("sampleMonitoringVisits").get("v").status = "APPROVED";
  const second = await service.upload(input());
  assert.deepEqual(second, first);
  assert.equal(table("sampleMonitoringVisits").get("v").sampleAssessments[0].evidenceHistory.length, 1);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 1);
  assert.equal(consumed, 1);
  assert.equal(linked, 1);
});

test("new or altered uploads remain blocked after approval", async () => {
  seed();
  await service.upload(input());
  table("sampleMonitoringVisits").get("v").status = "APPROVED";
  await assert.rejects(() => service.upload({ ...input(), idempotencyKey: "other_valid_key_123" }), /no longer editable/);
  await assert.rejects(() => service.upload({ ...input(), files: [{ buffer: Buffer.from("changed") }] }), /idempotency conflict/);
  assert.equal(table("sampleMonitoringVisits").get("v").sampleAssessments[0].evidenceHistory.length, 1);
});

test("coalesces simultaneous same-key uploads into one linkage", async () => {
  seed();

  const [first, second] = await Promise.all([
    service.upload(input()),
    service.upload(input()),
  ]);

  assert.deepEqual(second, first);
  const assessment = table("sampleMonitoringVisits").get("v").sampleAssessments[0];
  assert.equal(assessment.evidenceHistory.length, 1);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 1);
  assert.equal(consumed, 1);
  assert.equal(linked, 1);
});

test("rejects a concurrent different-key upload for the same photo linkage", async () => {
  seed();

  const primary = service.upload(input());
  const conflicting = service.upload({
    ...input(),
    idempotencyKey: "different_valid_key_456",
  });

  const [first, second] = await Promise.allSettled([primary, conflicting]);

  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.status, 409);
  const assessment = table("sampleMonitoringVisits").get("v").sampleAssessments[0];
  assert.equal(assessment.evidenceHistory.length, 1);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 1);
  assert.equal(consumed, 1);
  assert.equal(linked, 1);
});

test("recovers a lost acknowledgement after restart without duplicate linkage", async () => {
  seed();
  loseNextAcknowledgement = true;

  await assert.rejects(() => service.upload(input()), /lost acknowledgement/);
  restartService();

  const recovered = await service.upload(input());

  assert.deepEqual(recovered, { visitId: "v", sampleId: "TREE-001" });
  const assessment = table("sampleMonitoringVisits").get("v").sampleAssessments[0];
  assert.equal(assessment.evidenceHistory.length, 1);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 1);
  assert.equal(consumed, 1);
  assert.equal(linked, 1);
  assert.equal(uploadIntents.size, 1);
  assert.equal([...uploadIntents.values()][0].status, "LINKED");
});

test("retries after private Storage failure without consuming the capture session", async () => {
  seed();
  failNextStorageUpload = true;

  await assert.rejects(() => service.upload(input()), /Storage failure/);
  assert.equal(operations.get("staff:valid_key_123").status, "RETRYABLE");
  assert.equal(uploadIntents.size, 0);
  assert.equal(consumed, 0);
  assert.equal(linked, 0);

  restartService();
  await service.upload(input());

  const assessment = table("sampleMonitoringVisits").get("v").sampleAssessments[0];
  assert.equal(assessment.evidenceHistory.length, 1);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 1);
  assert.equal(consumed, 1);
  assert.equal(linked, 1);
});

test("reconciles an uploaded intent after Firestore linkage failure", async () => {
  seed();
  failNextFirestoreCommit = true;

  await assert.rejects(() => service.upload(input()), /Firestore commit failure/);
  assert.equal(operations.get("staff:valid_key_123").status, "RETRYABLE");
  assert.equal(uploadIntents.size, 1);
  assert.equal([...uploadIntents.values()][0].status, "UPLOADED");
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 0);
  assert.equal(consumed, 0);
  assert.equal(linked, 0);

  restartService();
  await service.upload(input());

  const assessment = table("sampleMonitoringVisits").get("v").sampleAssessments[0];
  assert.equal(assessment.evidenceHistory.length, 1);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 1);
  assert.equal(consumed, 1);
  assert.equal(linked, 1);
  assert.equal(uploadIntents.size, 1);
  assert.equal([...uploadIntents.values()][0].status, "LINKED");
});

test("resumes an expired lease once and coalesces concurrent recovery", async () => {
  seed();
  const request = input();
  operations.set("staff:valid_key_123", {
    id: "staff:valid_key_123",
    intentId: "staff:valid_key_123:intent-0",
    payloadHash: operationPayloadHash(request),
    status: "RUNNING",
    leaseUntil: -1,
  });

  const [first, second] = await Promise.all([
    service.upload(request),
    service.upload(input()),
  ]);

  assert.deepEqual(second, first);
  const assessment = table("sampleMonitoringVisits").get("v").sampleAssessments[0];
  assert.equal(assessment.evidenceHistory.length, 1);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 1);
  assert.equal(consumed, 1);
  assert.equal(linked, 1);
});

test("rejects changed cohort state before hash reservation or capture consumption", async () => {
  seed();
  table("verifiedPlantingCohorts").get("c").samplingPlan.status = "RETURNED";

  await assert.rejects(() => service.upload(input()), error => error.status === 409);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 0);
  assert.equal(consumed, 0);
  assert.equal(linked, 0);
});

test("rejects baseline, visit, sample, revision, and duplicate-hash changes without partial linkage", async () => {
  const cases = [
    () => {
      table("verifiedPlantingCohorts").get("c").baseline.approvalStatus = "RETURNED";
    },
    () => {
      table("verifiedPlantingCohorts").get("c").baselineVersion = 2;
    },
    () => {
      table("sampleMonitoringVisits").get("v").version = 2;
    },
    () => {
      table("sampleMonitoringVisits").get("v").sampleAssessments[0].assessmentRevision = 1;
    },
    () => {
      table("sampleMonitoringVisits").get("v").sampleAssessments = [];
    },
    () => {
      table("sampleMonitoringEvidenceHashes").set("hash", { visitId: "other" });
    },
  ];

  for (const mutate of cases) {
    seed();
    mutate();

    await assert.rejects(() => service.upload(input()), error => error.status === 409);
    const assessment = table("sampleMonitoringVisits").get("v").sampleAssessments[0];
    assert.equal(assessment?.evidenceHistory, undefined);
    assert.equal(consumed, 0);
    assert.equal(linked, 0);
  }
});


test("unsupported original evidence reports a capture-required code without storage or linkage", async () => {
  seed(); captureEvidenceAllowed = false;
  const request = { ...input(), evidenceManifest: [{ source: "uploaded-original" }] };
  await assert.rejects(() => service.upload(request), error => error.status === 409 &&
    error.code === "MONITORING_CAPTURE_REQUIRED" && /Verified Staff capture is required/.test(error.message));
  assert.equal(uploadIntents.size, 0);
  assert.equal(table("sampleMonitoringEvidenceHashes").size, 0);
  assert.equal(table("sampleMonitoringVisits").get("v").sampleAssessments[0].evidenceHistory, undefined);
  assert.equal(table("captureSessions").get("session").state, "VERIFIED");
  assert.equal(consumed, 0); assert.equal(linked, 0);
  // A rejected unsupported file does not poison a later legitimate camera operation.
  captureEvidenceAllowed = true;
  await service.upload({ ...input(), idempotencyKey: "camera_after_rejection_123" });
  assert.equal(consumed, 1); assert.equal(linked, 1);
});
