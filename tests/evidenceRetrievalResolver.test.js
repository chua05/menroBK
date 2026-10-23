const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const Module = require("node:module");
const { createEvidenceRetrievalResolver } = require("../src/services/evidenceRetrievalResolver.service");
const { fixture, sink, demoEnv } = require("./helpers/evidenceRetrievalFixture");
const originalEnv = { ...process.env };
test.before(() => Object.assign(process.env, demoEnv));
test.after(() => { for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv); });
const selection = { kind: "planting", recordId: "report", photoIndex: "0" };
const owner = { uid: "owner", role: "participant" };
test("authorization completes before cloud capability creation or any Storage access", async () => {
  const h = await fixture(); let calls = 0;
  const resolver = createEvidenceRetrievalResolver({ cloud: h, async authorizeAndResolve(selector, user) {
    calls++; assert.equal(selector.recordId, "report");
    if (user.uid !== owner.uid) throw Object.assign(Error("private record"), { code: "EVIDENCE_FORBIDDEN" });
    return { provider: "firebase", ...h.context() };
  } });
  await assert.rejects(() => resolver.resolve(selection, null), { code: "EVIDENCE_FORBIDDEN" });
  assert.equal(calls, 0);
  await assert.rejects(() => resolver.resolve(selection, { uid: "other", role: "participant" }), { code: "EVIDENCE_FORBIDDEN" });
  assert.equal(h.stats.calls.length, 0);
  const resolved = await resolver.resolve(selection, owner), response = sink();
  assert.equal(resolved.reference, undefined); assert.equal(resolved.bucket, undefined);
  await resolved.streamTo(response.output); assert.deepEqual(response.data(), h.buffer);
});
test("selectors cannot supply raw references, buckets, paths or provider overrides", async () => {
  let calls = 0;
  const resolver = createEvidenceRetrievalResolver({ async authorizeAndResolve() { calls++; } });
  for (const patch of [{ reference: {} }, { bucket: "other" }, { objectName: "other" }, { provider: "firebase" }]) {
    await assert.rejects(() => resolver.resolve({ ...selection, ...patch }, owner), { code: "INVALID_EVIDENCE_CONTEXT" });
  }
  assert.equal(calls, 0);
});
test("explicit cloud failures never fall back to an unrelated local descriptor", async () => {
  for (const kind of ["missing", "invalid", "unsupported", "malformed"]) {
    const h = await fixture(); h.faults.metadataStatus = 404;
    const resolver = createEvidenceRetrievalResolver({ cloud: h, async authorizeAndResolve() {
      return { provider: kind === "unsupported" ? "gcs" : kind === "malformed" ? "local" : "firebase",
        reference: kind === "invalid" ? { ...h.reference, bucket: "wrong" } : h.reference,
        evidenceType: h.context().evidenceType, recordId: h.context().recordId,
        evidence: { absolutePath: path.join(os.tmpdir(), "unrelated.jpg"), contentType: "image/jpeg" } };
    } });
    const response = sink();
    await assert.rejects(async () => {
      const resolved = await resolver.resolve(selection, owner);
      await resolved.streamTo(response.output);
    });
    assert.equal(response.bytes(), 0);
  }
});
test("raw legacy reference alone is not sufficient authorization or a file descriptor", async () => {
  const resolver = createEvidenceRetrievalResolver({ async authorizeAndResolve() {
    return { reference: "/uploads/monitoring/other/photo.jpg", provider: "local" };
  } });
  await assert.rejects(() => resolver.resolve(selection, owner), { code: "INVALID_EVIDENCE_REFERENCE" });
});
test("resolver failures never expose raw SDK or private filesystem errors", async () => {
  const resolver = createEvidenceRetrievalResolver({ async authorizeAndResolve() { throw Error("secret bucket/private/path"); } });
  await assert.rejects(() => resolver.resolve(selection, owner), error => {
    assert.equal(error.code, "EVIDENCE_RESOLUTION_FAILED"); assert.equal(error.message.includes("secret"), false); return true;
  });
});
test("default legacy path reuses actual record/revision authorization and existing local resolution without Storage", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "menro-phase4-legacy-"));
  const plantingDir = path.join(root, "planting-reports", "synthetic");
  const monitoringDir = path.join(root, "monitoring", "synthetic");
  const plantingPath = path.join(plantingDir, "evidence.png"), monitoringPath = path.join(monitoringDir, "evidence.png");
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  process.env.MENRO_UPLOAD_ROOT = root;
  await fsp.mkdir(plantingDir, { recursive: true }); await fsp.mkdir(monitoringDir, { recursive: true });
  await fsp.writeFile(plantingPath, bytes, { flag: "wx" }); await fsp.writeFile(monitoringPath, bytes, { flag: "wx" });
  const accessPath = require.resolve("../src/services/evidenceAccess.service"), previous = require.cache[accessPath];
  const originalLoad = Module._load;
  delete require.cache[accessPath];
  Module._load = function (request, parent, isMain) {
    if (["firebase-admin/storage", "@google-cloud/storage"].includes(request)) throw Error("Legacy resolution must not load Storage");
    if (parent?.filename === accessPath && request === "./plantingReport.service") return {
      getPlantingReportById: async () => ({ participantId: "owner", submissions: [{ contributorId: "contributor" }],
        photos: [{ photoURL: "/uploads/planting-reports/synthetic/evidence.png" }] }) };
    if (parent?.filename === accessPath && request === "./monitoring.service") return {
      getRawMonitoringRecordById: async () => ({ participantId: "cohort-owner", history: [{ id: "observation",
        originalReporterId: "owner", photoUrl: "/uploads/monitoring/synthetic/evidence.png",
        revisionHistory: [{ revisionNumber: 1, evidenceRef: { photoUrl: "/uploads/monitoring/synthetic/evidence.png" } }] }] }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(async () => {
    Module._load = originalLoad;
    delete require.cache[accessPath]; if (previous) require.cache[accessPath] = previous;
    if (originalEnv.MENRO_UPLOAD_ROOT === undefined) delete process.env.MENRO_UPLOAD_ROOT;
    else process.env.MENRO_UPLOAD_ROOT = originalEnv.MENRO_UPLOAD_ROOT;
    await fsp.unlink(plantingPath); await fsp.unlink(monitoringPath);
    for (const directory of [plantingDir, monitoringDir, path.dirname(plantingDir), path.dirname(monitoringDir), root]) await fsp.rmdir(directory);
  });
  const resolver = createEvidenceRetrievalResolver();
  for (const user of [owner, { uid: "contributor", role: "participant" }, { uid: "staff", role: "staff" }, { uid: "admin", role: "admin" }]) {
    const resolved = await resolver.resolve(selection, user);
    assert.equal(resolved.provider, "local"); assert.equal(resolved.evidence.absolutePath, plantingPath);
    assert.deepEqual(await fsp.readFile(resolved.evidence.absolutePath), bytes);
  }
  await assert.rejects(() => resolver.resolve(selection, { uid: "other", role: "participant" }), { code: "EVIDENCE_FORBIDDEN" });
  const revision = { kind: "monitoring-revision", recordId: "cohort", observationId: "observation", revisionNumber: "1" };
  for (const user of [owner, { uid: "staff", role: "staff" }, { uid: "admin", role: "admin" }]) {
    const resolved = await resolver.resolve(revision, user);
    assert.deepEqual(await fsp.readFile(resolved.evidence.absolutePath), bytes);
  }
  await assert.rejects(() => resolver.resolve(revision, { uid: "cohort-owner", role: "participant" }), { code: "EVIDENCE_FORBIDDEN" });
  const current = await resolver.resolve({ kind: "monitoring", recordId: "cohort", entryIndex: "0" }, owner);
  assert.equal(current.evidence.absolutePath, monitoringPath);
});
