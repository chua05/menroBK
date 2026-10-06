const fs = require("node:fs");
const path = require("node:path");

const sourcePath = path.resolve(__dirname, "../src/data/gadm41_PHL_3.json");
const outputPath = path.resolve(__dirname, "../src/data/bulan-barangays.json");

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (source.type !== "FeatureCollection" || !Array.isArray(source.features)) {
  throw new Error("The GADM source is not a valid GeoJSON FeatureCollection.");
}

const features = source.features
  .filter((feature) => feature?.properties?.NAME_1 === "Sorsogon" && feature?.properties?.NAME_2 === "Bulan")
  .map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      prov_name: feature.properties.NAME_1,
      city_name: feature.properties.NAME_2,
      brgy_name: feature.properties.NAME_3,
    },
  }));

if (features.length === 0) throw new Error("No Bulan, Sorsogon barangays were found.");
for (const feature of features) {
  if (feature.properties.NAME_1 !== "Sorsogon" || feature.properties.NAME_2 !== "Bulan") {
    throw new Error(`Unexpected administrative hierarchy for ${feature.properties.NAME_3}.`);
  }
  if (!["Polygon", "MultiPolygon"].includes(feature.geometry?.type) || !Array.isArray(feature.geometry.coordinates)) {
    throw new Error(`Invalid geometry for ${feature.properties.NAME_3}.`);
  }
}

fs.writeFileSync(outputPath, `${JSON.stringify({ type: "FeatureCollection", features })}\n`);
console.log(`Extracted ${features.length} Bulan barangays to ${outputPath}`);
console.log(features.map((feature) => feature.properties.NAME_3).sort().join("\n"));
