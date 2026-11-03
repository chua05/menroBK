const test = require("node:test");
const assert = require("node:assert/strict");

const visits = new Map();
let cohortEnabled = true;
const resolvedInputs = [];

const db = {
  collection(name) {
    return {
      doc(id) {
        return {
          async get() {
            const value = name === "sampleMonitoringVisits" ? visits.get(id) : undefined;
            return { exists: value !== undefined, data: () => value };
          },
        };
      },
    };
  },
};

function mock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock("../src/config/firebase", { db });
mock("../src/config/evidenceStorage", { resolveEvidenceStorageConfig: () => ({ cloudRead: true }) });
mock("../src/config/verifiedPlantingCohort", {
  resolveVerifiedPlantingCohortConfig: () => ({ enabled: cohortEnabled }),
});
mock("../src/services/firebaseEvidenceRetrieval.service", {
  createFirebaseEvidenceRetrieval: () => ({ serverResolvedEvidence: input => {
    resolvedInputs.push(input);
    return { provider: "firebase" };
  } }),
});

const { sampleMonitoringEvidenceForUser } = require("../src/services/evidenceAccess.service");
const routes = require("../src/routes/evidence.routes");

const privateEvidence = {
  provider: "firebase", storageVersion: 1, bucket: "demo-menro-phase2.firebasestorage.app",
  objectName: "evidence/v1/sample-monitoring/VPME-test/00000000-0000-4000-8000-000000000001",
  generation: "1", contentType: "image/jpeg", format: "jpeg", sizeBytes: 3,
  sha256: "a".repeat(64), uploadIntentId: "00000000-0000-4000-8000-000000000001",
};

function seed() {
  cohortEnabled = true;
  resolvedInputs.length = 0;
  visits.clear();
  visits.set("visit-1", {
    createdBy: "staff-1",
    sampleAssessments: [{ sampleId: "TREE-001", assessmentRevision: 2, evidenceHistory: [
      { revision: 1, privateEvidence }, { revision: 2, privateEvidence },
    ] }],
  });
}

test("route is registered and Admin or visit-owner Staff can resolve current and historical evidence", async () => {
  seed();
  assert.ok(routes.stack.find(layer => layer.route?.path === "/sample-monitoring/visits/:visitId/samples/:sampleId/evidence/:evidenceIndex"));
  for (const user of [{ uid: "admin-1", role: "admin" }, { uid: "staff-1", role: "staff" }]) {
    const current = await sampleMonitoringEvidenceForUser("visit-1", "TREE-001", "1", user);
    const historical = await sampleMonitoringEvidenceForUser("visit-1", "TREE-001", "0", user);
    assert.equal(current.provider, "firebase");
    assert.equal(historical.provider, "firebase");
    const resolved = resolvedInputs.at(-1);
    assert.equal(resolved.evidenceType, "sample-monitoring");
    assert.equal(resolved.recordId.startsWith("VPME-"), true);
  }
});

test("retrieval denies unauthorized access and invalid authoritative bindings", async () => {
  seed();
  const cases = [
    [undefined, "visit-1", "TREE-001", "0", "EVIDENCE_FORBIDDEN"],
    [{ uid: "participant-1", role: "participant" }, "visit-1", "TREE-001", "0", "EVIDENCE_FORBIDDEN"],
    [{ uid: "staff-2", role: "staff" }, "visit-1", "TREE-001", "0", "EVIDENCE_FORBIDDEN"],
    [{ uid: "staff-1", role: "staff" }, "missing", "TREE-001", "0", "EVIDENCE_NOT_FOUND"],
    [{ uid: "staff-1", role: "staff" }, "visit-1", "TREE-999", "0", "EVIDENCE_NOT_FOUND"],
    [{ uid: "staff-1", role: "staff" }, "visit-1", "TREE-001", "9", "EVIDENCE_NOT_FOUND"],
  ];
  for (const [user, visitId, sampleId, index, code] of cases) {
    await assert.rejects(() => sampleMonitoringEvidenceForUser(visitId, sampleId, index, user), error => error.code === code);
  }
  cohortEnabled = false;
  await assert.rejects(() => sampleMonitoringEvidenceForUser("visit-1", "TREE-001", "0", { uid: "admin-1", role: "admin" }), error => error.code === "COHORT_WORKFLOW_DISABLED");
});
