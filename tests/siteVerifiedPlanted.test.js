// Site utilization uses the verified planted quantity (the analytics "Verified Trees Planted" rules), not the stored
// `planted` field, which no workflow updates.
const assert = require("node:assert/strict");
const test = require("node:test");

const data = {
  sites: [
    { id: "s1", siteId: "SITE-2026-001", siteName: "Zone 8 Green Site", barangay: "Zone VIII Poblacion", municipality: "Bulan", province: "Sorsogon",
      latitude: 12.6662, longitude: 123.8806, maximumCapacity: 100, planted: 0, coverageRadiusMeters: 40, status: "active" },
    { id: "s2", siteId: "SITE-2026-002", siteName: "No Capacity Site", barangay: "Bical", municipality: "Bulan", province: "Sorsogon",
      latitude: 12.6598, longitude: 123.918, maximumCapacity: 0, planted: 0, status: "active" },
  ],
  events: [{ id: "e1", plantingSiteId: "s2" }],
  plantingReports: [
    { id: "r1", reportType: "parent", siteId: "s1", verificationStatus: "Approved", reportingProgress: "Completed" },
    { id: "r2", reportType: "parent", siteId: "s1", verificationStatus: "Pending Review" },
    { id: "r3", siteId: "s1", quantityPlanted: 15, verificationStatus: "Approved" },
    { id: "r4", eventId: "e1", quantityPlanted: 7, verificationStatus: "Approved" },
    { id: "r5", siteId: "s1", quantityPlanted: 500, verificationStatus: "Approved", archived: true },
  ],
  plantingContributions: [
    { id: "c1", reportId: "r1", quantity: 40, staffReviewStatus: "Accepted" },
    { id: "c2", reportId: "r1", quantity: 9, staffReviewStatus: "Rejected" },
    { id: "c3", reportId: "r2", quantity: 30, staffReviewStatus: "Pending Review", verificationStatus: "Needs Review" },
  ],
};
const db = {
  collection: (name) => ({
    get: async () => ({ docs: (data[name] || []).map((row) => ({ id: row.id, exists: true, data: () => row })) }),
    doc: (id) => ({ get: async () => { const row = (data[name] || []).find((item) => item.id === id); return { id, exists: Boolean(row), data: () => row }; } }),
  }),
};
const firebasePath = require.resolve("../src/config/firebase");
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db } };
const { getVerifiedPlantedBySite } = require("../src/services/analytics.service");
const siteService = require("../src/services/site.service");

test("verified planted per site counts only accepted, non-archived planting", async () => {
  const planted = await getVerifiedPlantedBySite();
  assert.equal(planted.get("s1"), 55, "40 accepted + 15 approved; rejected, pending and archived rows are excluded");
  assert.equal(planted.get("s2"), 7, "a report placed through its event's site");
});

test("the sites list carries the verified planted quantity; request-validation fields are unchanged", async () => {
  const sites = await siteService.getAllSites();
  const zone = sites.find((site) => site.id === "s1"), none = sites.find((site) => site.id === "s2");
  assert.equal(zone.verifiedPlanted, 55);
  assert.deepEqual([zone.planted, zone.utilizationPercentage, zone.utilizationStatus], [0, 0, "Available"], "stored fields used by seedling-request validation are untouched");
  assert.equal(none.verifiedPlanted, 7);
  const one = await siteService.getSiteById("s1");
  assert.equal(one.verifiedPlanted, 55);
  assert.ok(Object.prototype.hasOwnProperty.call(siteService.participantSafeSite(zone), "verifiedPlanted"), "participants see the same site colour");
});
