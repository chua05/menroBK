const test = require("node:test");
const assert = require("node:assert/strict");
const { plantingArea, normalizeRequestPlantingArea, verifiedProposedSite } = require("../src/utils/plantingArea.util");
test("Other requires a positive finite exact decimal, including small values", () => {
  for (const value of ["0.5", ".25", "0.000001", 0.0000001, "12.75"]) assert.equal(plantingArea("Other / Exact Area", value).hectares, Number(value));
  for (const value of ["", " ", null, undefined, "0", "-1", "NaN", "Infinity", "1e3", "0x10", "1,5", "1.2.3", "1/2", false, Infinity]) {
    const result = plantingArea("Other / Exact Area", value);
    assert.ok(result.error); assert.equal(result.field, "exactArea"); assert.equal(result.hectares, null);
  }
});
test("Staff review requires explicit measured area and capacity without inventing defaults", () => {
  for (const values of [null, {}, { areaHectares: "0.5", maximumCapacity: 0 }, { areaHectares: "", maximumCapacity: 100 }, { areaHectares: "Infinity", maximumCapacity: 100 }, { areaHectares: "0.5", maximumCapacity: 1.1 }]) {
    assert.throws(() => verifiedProposedSite(values, "staff-1"), error => error.status === 400 && Boolean(error.fieldErrors));
  }
  assert.deepEqual(verifiedProposedSite({ areaHectares: ".5", maximumCapacity: "30", reviewedBy: "client-spoof" }, "real-staff"), { areaHectares: .5, maximumCapacity: 30, reviewedBy: "real-staff" });
  assert.throws(() => verifiedProposedSite({ areaHectares: .5, maximumCapacity: 30 }, ""), /authenticated Staff/);
});
test("proposed area may be blank/null but Other cannot omit its exact value", () => {
  assert.equal(plantingArea("", "", { optional: true }).hectares, null);
  assert.equal(plantingArea(null, null, { optional: true }).error, "");
  assert.ok(plantingArea("Other / Exact Area", "", { optional: true }).error);
  assert.ok(plantingArea("", "").error);
});
test("fixed options ignore stale exact values and unknown dropdown values fail", () => {
  assert.equal(plantingArea("2 hectares", "999").hectares, 2);
  assert.ok(plantingArea("free-text", "2").error);
  assert.ok(plantingArea("6–10 hectares", "5").error);
  assert.equal(plantingArea("6–10 hectares", "7.25").hectares, 7.25);
  assert.ok(plantingArea("Less than 1 hectare", "1").error);
});
test("normalization preserves coordinates, clears stale exact values and never converts blank to zero", () => {
  const source = { siteMode: "proposed", areaChoice: "", exactArea: "old", latitude: "12.662301", longitude: "123.932983" };
  const result = normalizeRequestPlantingArea(source);
  assert.equal(result.areaHectares, null); assert.equal(result.exactArea, "");
  assert.equal(result.latitude, source.latitude); assert.equal(result.longitude, source.longitude);
  assert.equal(source.exactArea, "old");
  assert.throws(() => normalizeRequestPlantingArea({ ...source, areaChoice: "Other / Exact Area", exactArea: "NaN" }), error => Boolean(error.fieldErrors?.exactArea));
  assert.equal(normalizeRequestPlantingArea(undefined), undefined);
});
