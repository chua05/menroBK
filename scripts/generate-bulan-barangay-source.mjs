import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(scriptDirectory, "../src/data");
const nationalPath = path.join(dataDirectory, "barangays.geojson");
const outputPath = path.join(dataDirectory, "bulan-barangays-source.geojson");

const national = JSON.parse(await readFile(nationalPath, "utf8"));
const features = national.features.filter(
  (feature) =>
    feature?.properties?.ADM2_EN === "Sorsogon" &&
    feature?.properties?.ADM3_EN === "Bulan"
);

if (features.length !== 63) {
  throw new Error(`Expected 63 Bulan barangays, found ${features.length}.`);
}

const ids = new Set(features.map((feature) => feature.properties.ADM4_PCODE));

if (ids.size !== features.length || ids.has(undefined)) {
  throw new Error("Bulan source contains missing or duplicate ADM4_PCODE values.");
}

const collection = {
  type: "FeatureCollection",
  name: "Bulan barangays — national source extract",
  metadata: {
    authoritativeSource: "barangays.geojson",
    filter: {
      ADM2_EN: "Sorsogon",
      ADM3_EN: "Bulan",
    },
    featureCount: features.length,
  },
  features,
};

await writeFile(outputPath, `${JSON.stringify(collection)}\n`, "utf8");
console.log(`Wrote ${features.length} features to ${outputPath}`);
