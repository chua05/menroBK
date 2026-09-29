const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const fixtureRoot = path.join(process.cwd(), "uploads", "planting-reports", "security-test");
const fixturePath = path.join(fixtureRoot, "evidence.png");
const monitoringFixtureRoot = path.join(process.cwd(), "uploads", "monitoring", "security-test");
const monitoringFixturePath = path.join(monitoringFixtureRoot, "evidence.png");
let plantingReport;
let monitoringRecord;

const originalLoad = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (parent?.filename?.endsWith("evidenceAccess.service.js")) {
    if (request === "./plantingReport.service") {
      return { getPlantingReportById: async () => plantingReport };
    }
    if (request === "./monitoring.service") {
      return {
        getMonitoringRecordById: async () => monitoringRecord,
        getAllMonitoringRecords: async () => [],
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

const evidence = require("../src/services/evidenceAccess.service");
Module._load = originalLoad;

test.before(async () => {
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(monitoringFixtureRoot, { recursive: true });
  await fs.writeFile(fixturePath, Buffer.from("89504e470d0a1a0a", "hex"));
  await fs.writeFile(monitoringFixturePath, Buffer.from("89504e470d0a1a0a", "hex"));
});

test.after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.rm(monitoringFixtureRoot, { recursive: true, force: true });
});

test("resolves an approved legacy /uploads reference inside its evidence root", async () => {
  const result = await evidence.resolveStoredEvidence(
    "/uploads/planting-reports/security-test/evidence.png",
    "planting"
  );
  assert.equal(result.absolutePath, fixturePath);
  assert.equal(result.contentType, "image/png");
});

test("rejects traversal and cross-evidence paths", async () => {
  await assert.rejects(
    evidence.resolveStoredEvidence("/uploads/planting-reports/../../serviceAccountKey.json", "planting"),
    { code: "INVALID_EVIDENCE_PATH" }
  );
  await assert.rejects(
    evidence.resolveStoredEvidence("/uploads/monitoring/user/evidence.png", "planting"),
    { code: "INVALID_EVIDENCE_PATH" }
  );
});

test("authorizes planting owner, contributor, staff, and admin but denies unrelated participants", async () => {
  plantingReport = {
    participantId: "owner",
    photos: [{ photoPath: "planting-reports/security-test/evidence.png" }],
    submissions: [{ contributorId: "contributor" }],
  };

  for (const user of [
    { uid: "owner", role: "participant" },
    { uid: "contributor", role: "participant" },
    { uid: "staff-user", role: "staff" },
    { uid: "admin-user", role: "admin" },
  ]) {
    const result = await evidence.plantingEvidenceForUser("report", "0", user);
    assert.equal(result.absolutePath, fixturePath);
  }

  await assert.rejects(
    evidence.plantingEvidenceForUser("report", "0", { uid: "other", role: "participant" }),
    { code: "EVIDENCE_FORBIDDEN" }
  );
});

test("authorizes monitoring owner, staff, and admin but denies unrelated participants", async () => {
  monitoringRecord = {
    participantId: "owner",
    history: [{ photoUrl: "/uploads/monitoring/security-test/evidence.png" }],
  };

  await assert.rejects(
    evidence.monitoringEvidenceForUser("record", "0", { uid: "other", role: "participant" }),
    { code: "EVIDENCE_FORBIDDEN" }
  );

  for (const user of [
    { uid: "owner", role: "participant" },
    { uid: "staff-user", role: "staff" },
    { uid: "admin-user", role: "admin" },
  ]) {
    const result = await evidence.monitoringEvidenceForUser("record", "0", user);
    assert.equal(result.absolutePath, monitoringFixturePath);
  }
});
