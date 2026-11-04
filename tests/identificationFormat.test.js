const test = require("node:test");
const assert = require("node:assert/strict");
const { identificationFormatError } = require("../src/utils/identificationFormat.util");
test("printed PCN, PhilHealth PIN and TIN formats reject nonnumeric and wrong-length values", () => {
  for (const [type, valid, invalid] of [["national_id", "1234-5678-9012-3456", "1234-5678-9012"], ["philhealth", "12-123456789-0", "ABC123456789"], ["tin", "123-456-789", "12345678"]]) {
    assert.equal(identificationFormatError(type, valid), ""); assert.ok(identificationFormatError(type, invalid));
  }
  assert.ok(identificationFormatError("national_id", "123456789012").includes("PSN"));
});
test("ambiguous document families retain manual review instead of an unsupported format rule", () => {
  for (const type of ["passport", "drivers_license", "voter", "school_id"]) assert.equal(identificationFormatError(type, "reference-123"), "");
});
