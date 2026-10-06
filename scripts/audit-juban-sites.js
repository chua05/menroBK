const { db } = require("../src/config/firebase");
const { barangayGeoJson } = require("../src/config/municipality");
const { isPointInGeoJsonFeatureCollection } = require("../src/utils/geo.util");

const REFERENCE_COLLECTIONS = [
  "seedlingRequests",
  "events",
  "distributions",
  "plantingReports",
  "plantingContributions",
  "monitoringRecords",
  "notifications",
  "generatedReports",
];

function containsSiteId(value, siteIds) {
  if (siteIds.has(value)) return true;
  if (Array.isArray(value)) return value.some((item) => containsSiteId(item, siteIds));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsSiteId(item, siteIds));
  }
  return false;
}

async function referencesFor(...siteIds) {
  const identifiers = new Set(siteIds.filter(Boolean));
  const references = [];
  for (const collectionName of REFERENCE_COLLECTIONS) {
    const snapshot = await db.collection(collectionName).get();
    for (const document of snapshot.docs) {
      if (containsSiteId(document.data(), identifiers)) {
        references.push(`${collectionName}/${document.id}`);
      }
    }
  }
  return references;
}

async function main() {
  const deletionArgument = process.argv.find((value) => value.startsWith("--delete-unreferenced="));
  const deletionIds = new Set(
    deletionArgument?.split("=")[1]?.split(",").map((value) => value.trim()).filter(Boolean) || []
  );
  const deletionConfirmed = process.argv.includes("--confirm-delete-unreferenced");
  if (deletionIds.size && !deletionConfirmed) {
    throw new Error("Deletion requires --confirm-delete-unreferenced after reviewing the audit output.");
  }

  const snapshot = await db.collection("sites").get();
  const results = [];
  for (const document of snapshot.docs) {
    const site = document.data();
    const latitude = Number(site.latitude);
    const longitude = Number(site.longitude);
    const insideBulan = isPointInGeoJsonFeatureCollection(latitude, longitude, barangayGeoJson);
    const legacyMunicipality = String(site.municipality || "").trim().toLowerCase() === "juban";
    if (!legacyMunicipality && insideBulan) continue;

    const references = await referencesFor(document.id, site.siteId);
    const result = {
      documentId: document.id,
      siteId: site.siteId || "",
      siteName: site.siteName || site.name || "",
      municipality: site.municipality || "",
      barangay: site.barangay || "",
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      insideBulan,
      legacyMunicipality,
      references,
      deletionEligible: legacyMunicipality && references.length === 0,
    };
    results.push(result);

    if (deletionIds.has(document.id)) {
      if (!result.deletionEligible) {
        throw new Error(`Refusing to delete ${document.id}: it is not an unreferenced Juban site.`);
      }
      await document.ref.delete();
      result.deleted = true;
    }
  }

  for (const requestedId of deletionIds) {
    if (!results.some((result) => result.documentId === requestedId)) {
      throw new Error(`Requested site ${requestedId} was not found among the reviewed legacy candidates.`);
    }
  }

  console.log(JSON.stringify({ siteCount: snapshot.size, candidates: results }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
