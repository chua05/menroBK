const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { PARTICIPANT_PLANTING_NOTICES, INTERNAL_STATUS_WORDS } = require("../src/utils/plantingReportNotifications");

test("Participant planting notices never reveal internal review or verification states", () => {
  const { submitted, recorded } = PARTICIPANT_PLANTING_NOTICES;
  for (const text of [submitted.title, submitted.message(), submitted.message("RPT-2026-001"), submitted.message("Your final planting report"), recorded.title, recorded.message])
    assert.doesNotMatch(text, INTERNAL_STATUS_WORDS, text);
  assert.equal(submitted.message("RPT-2026-001"), "RPT-2026-001 was submitted to MENRO.");
  assert.equal(recorded.title, "Planting Report Recorded");
});

test("Participant notices are produced only from the shared wording and no Participant review notice remains", () => {
  const source = readFileSync(path.join(__dirname, "../src/services/plantingReport.service.js"), "utf8");
  assert.doesNotMatch(source, /type: "planting_report_reviewed"/, "Staff review must not notify the Participant");
  assert.doesNotMatch(source, /pending MENRO Staff verification/);
  assert.doesNotMatch(source, /MENRO Admin approved your planting report/);
  // Staff/Admin-facing notices keep their existing wording and recipients.
  assert.match(source, /type: "planting_report_forwarded"/);
  assert.match(source, /Reviewed Planting Report Approved/);
  // Returned/Rejected outcomes stay explicit for the Participant.
  assert.match(source, /title: "Planting Report Returned for Correction"/);
  assert.match(source, /title: "Planting Report Rejected"/);
});
