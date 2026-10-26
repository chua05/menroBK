const { validateIntegrationEnvironment } = require("../../src/config/integrationEnvironment");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const state = validateIntegrationEnvironment();
if (!state.integration) throw new Error("Emulator seed refused outside integration mode.");

const { auth, db } = require("../../src/config/firebase");
const USERS = [
  ["phase2-participant", "phase2.participant@example.test", "participant", "Phase 2 Participant"],
  ["phase2-other", "phase2.other@example.test", "participant", "Other Participant"],
  ["phase2-staff", "phase2.staff@example.test", "staff", "MENRO Test Staff"],
  ["phase2-admin", "phase2.admin@example.test", "admin", "MENRO Test Admin"],
];
const PASSWORD = "Phase2-Test-Only!2026";
const FIXTURE_DOCS = {
  sites: ["phase2-site"], plantingReports: ["phase2-report", "phase2-report-a", "phase2-report-b", "phase2-report-c",
    "early-e2e-report-a", "early-e2e-report-b", "early-e2e-report-c"],
  monitoringRecords: ["phase2-legacy", "phase2-legacy-null-schedule"],
};

async function removeKnownFixtures() {
  const [monitoringSnapshot, hashSnapshot] = await Promise.all([
    db.collection("monitoringRecords").where("participantId", "==", "phase2-participant").get(),
    db.collection("monitoringEvidenceHashes").get(),
  ]);
  const batch = db.batch();
  const monitoringFixtureIds = new Set(monitoringSnapshot.docs
    .filter((doc) => {
      const reportId = String(doc.data().plantingReportId || "");
      return reportId.startsWith("phase2-") || reportId.startsWith("early-e2e-");
    })
    .map((doc) => doc.id));
  for (const [collection, ids] of Object.entries(FIXTURE_DOCS)) {
    ids.forEach((id) => batch.delete(db.collection(collection).doc(id)));
  }
  USERS.forEach(([uid]) => batch.delete(db.collection("users").doc(uid)));
  monitoringSnapshot.docs.filter((doc) => monitoringFixtureIds.has(doc.id))
    .forEach((doc) => batch.delete(doc.ref));
  hashSnapshot.docs
    .filter((doc) => String(doc.data().participantId || "") === "phase2-participant" ||
      monitoringFixtureIds.has(String(doc.data().lifecycleId || "")))
    .forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  await fs.rm(path.join(process.env.MENRO_UPLOAD_ROOT, "monitoring", "phase2-participant"),
    { recursive: true, force: true });
  await Promise.all(USERS.map(async ([uid]) => {
    try { await auth.deleteUser(uid); } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }));
}

async function seed() {
  await removeKnownFixtures();
  for (const [uid, email, role, fullName] of USERS) {
    await auth.createUser({ uid, email, password: PASSWORD, emailVerified: true, displayName: fullName });
    await db.collection("users").doc(uid).set({ uid, email, role, fullName,
      username: uid, contactNumber: "09123456789", userType: "Volunteer",
      userTypeDetail: "", barangay: "Bical", profileComplete: true, status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"), testFixture: true });
  }
  await db.collection("sites").doc("phase2-site").set({ siteName: "Phase 2 Test Site",
    barangay: "Bical", municipality: "Bulan", province: "Sorsogon",
    latitude: 12.671, longitude: 123.875, coverageRadius: 100,
    polygon: [{ lat: 12.6705, lng: 123.8745 }, { lat: 12.6715, lng: 123.8745 },
      { lat: 12.6715, lng: 123.8755 }, { lat: 12.6705, lng: 123.8755 }],
    status: "Active", testFixture: true });
  await db.collection("plantingReports").doc("phase2-report").set({ reportNumber: "TEST-PR-001",
    participantId: "phase2-participant", participantName: "Phase 2 Participant", eventId: "phase2-event",
    eventName: "Phase 2 Test Planting", siteId: "phase2-site", siteName: "Phase 2 Test Site",
    barangay: "Bical", species: "Narra", quantityPlanted: 10, plantingDate: "2026-09-01",
    verificationStatus: "Approved", reportingProgress: "Completed", testFixture: true });
  for (const suffix of ["a", "b", "c"]) {
    await db.collection("plantingReports").doc(`phase2-report-${suffix}`).set({
      reportNumber: `TEST-PHASE2-${suffix.toUpperCase()}`,
      participantId: "phase2-participant", participantName: "Phase 2 Participant",
      eventId: `phase2-event-${suffix}`, eventName: `Phase 2 Workflow ${suffix.toUpperCase()}`,
      siteId: "phase2-site", siteName: "Phase 2 Test Site", barangay: "Bical",
      species: "Narra", quantityPlanted: 10, plantingDate: "2026-09-01",
      verificationStatus: "Approved", reportingProgress: "Completed", testFixture: true,
    });
  }
  for (const suffix of ["a", "b", "c"]) {
    await db.collection("plantingReports").doc(`early-e2e-report-${suffix}`).set({
      reportNumber: `TEST-EARLY-${suffix.toUpperCase()}`,
      participantId: "phase2-participant", participantName: "Phase 2 Participant",
      eventId: `early-e2e-event-${suffix}`, eventName: `Early Workflow ${suffix.toUpperCase()}`,
      siteId: "phase2-site", siteName: "Phase 2 Test Site", barangay: "Bical",
      species: "Narra", quantityPlanted: 10, plantingDate: suffix === "c" ? "2026-10-01" : "2026-10-06",
      verificationStatus: "Approved", reportingProgress: "Completed", testFixture: true,
      earlyMonitoring: { enabled: true, applicable: true, policyVersion: 1,
        openingDate: "2026-10-01", deadlineDate: "2026-10-07",
        officialOpeningDate: suffix === "c" ? "2026-10-15" : "2026-10-20" },
    });
  }
  const earlyCId = `MON-${crypto.createHash("sha256")
    .update(["phase2-participant", "early-e2e-report-c", "early-e2e-event-c", "phase2-site"].join("|"))
    .digest("hex").slice(0, 20)}`;
  FIXTURE_DOCS.monitoringRecords.push(earlyCId);
  await db.collection("monitoringRecords").doc(earlyCId).set({
    recordType: "monitoringLifecycle", participantId: "phase2-participant",
    plantingReportId: "early-e2e-report-c", eventId: "early-e2e-event-c",
    plantingReportNumber: "TEST-EARLY-C",
    siteId: "phase2-site", siteName: "Phase 2 Test Site", barangay: "Bical",
    species: "Narra", quantityPlanted: 10, authoritativePlantingDate: "2026-10-01",
    startMonitoringDate: "2026-10-15", nextMonitoringDate: null,
    monitoringEndDate: "2028-10-01", archived: false, testFixture: true,
    earlyMonitoring: { enabled: true, applicable: true, policyVersion: 1,
      openingDate: "2026-10-01", deadlineDate: "2026-10-07", officialOpeningDate: "2026-10-15" },
    history: [{ id: "early-e2e-pending", workflowVersion: 2, observationType: "early",
      observationPolicyVersion: 1, originalReporterId: "phase2-participant",
      monitoredBy: "phase2-participant", monitoredDate: "2026-10-01", totalMonitored: 5,
      cohortQuantityAtObservation: 10, isFullCohortAssessment: false,
      healthyCount: 4, damagedCount: 0, deadCount: 1, survivingCount: 4,
      survivalRate: 80, mortalityRate: 20, reviewStatus: "Pending Review", reviewVersion: 0,
      revisionNumber: 1, revisionHistory: [], auditHistory: [] }],
  });
  const legacyBase = { recordType: "monitoringLifecycle", plantingReportId: "phase2-report",
    participantId: "phase2-participant", siteId: "phase2-site", quantityPlanted: 10,
    startMonitoringDate: "2026-09-15", monitoringEndDate: "2028-09-01", archived: false, testFixture: true };
  await db.collection("monitoringRecords").doc("phase2-legacy").set({ ...legacyBase,
    nextMonitoringDate: "2026-10-20", history: [{ id: "legacy-observation", monitoredDate: "2026-09-15",
      totalMonitored: 10, healthyCount: 8, damagedCount: 1, deadCount: 1, reviewStatus: "Validated" }] });
  await db.collection("monitoringRecords").doc("phase2-legacy-null-schedule").set({ ...legacyBase,
    plantingReportId: "phase2-legacy-report", nextMonitoringDate: null,
    history: [{ id: "legacy-null-observation", monitoredDate: "2026-09-20", totalMonitored: 10,
      healthyCount: 7, damagedCount: 2, deadCount: 1, reviewStatus: "Validated" }] });
}

const cleanup = process.argv.includes("--cleanup");
(cleanup ? removeKnownFixtures() : seed()).then(() => {
  console.log(cleanup ? "Demo emulator fixtures removed." : "Demo emulator fixtures seeded.");
  process.exit(0);
}).catch((error) => { console.error(error.message); process.exit(1); });

module.exports = { FIXTURE_DOCS, PASSWORD, USERS, removeKnownFixtures, seed };
