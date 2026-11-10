const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseFinalItems, finalRowsFor, isActiveFinalRow, assertNoActiveFinalReport, nextFinalRevision, finalReportIdFor,
} = require("../src/utils/finalPlantingReport.util");

const balances = [
  { inventoryId: "narra", species: "Narra", remaining: 25 },
  { inventoryId: "mahogany", species: "Mahogany", remaining: 15 },
  { inventoryId: "molave", species: "Molave", remaining: 0 },
];

test("final items: per-type leftovers need a reason; shape errors are field-specific", () => {
  assert.deepEqual(parseFinalItems('[{"inventoryId":"narra","leftoverQuantity":"0"}]'), [{ inventoryId: "narra", leftoverQuantity: 0, leftoverReason: "" }]);
  assert.deepEqual(parseFinalItems([{ inventoryId: "narra", leftoverQuantity: 3, leftoverReason: "  Wilted  " }]),
    [{ inventoryId: "narra", leftoverQuantity: 3, leftoverReason: "Wilted" }]);
  // A reason sent with zero leftovers is not recorded.
  assert.equal(parseFinalItems([{ inventoryId: "narra", leftoverQuantity: 0, leftoverReason: "n/a" }])[0].leftoverReason, "");
  assert.throws(() => parseFinalItems([{ inventoryId: "narra", leftoverQuantity: 3 }]), (error) => error.status === 400 && Boolean(error.fieldErrors["leftoverReason-0"]));
  assert.throws(() => parseFinalItems([{ inventoryId: "narra", leftoverQuantity: 3, leftoverReason: "x".repeat(501) }]), (error) => error.status === 400);
  for (const leftoverQuantity of [-1, 1.5, "1e3", Infinity]) {
    assert.throws(() => parseFinalItems([{ inventoryId: "narra", leftoverQuantity }]), (error) => error.status === 400);
  }
  assert.throws(() => parseFinalItems([]), (error) => error.status === 400);
  assert.throws(() => parseFinalItems("not json"), (error) => error.status === 400);
  assert.throws(() => parseFinalItems([{ inventoryId: "narra" }, { inventoryId: "narra" }]), (error) => error.status === 400);
  assert.throws(() => parseFinalItems([{ inventoryId: "../etc" }]), (error) => error.status === 400);
});

test("final rows: Planted = Remaining - Leftovers for every type with a balance, never from the client", () => {
  const rows = finalRowsFor(parseFinalItems([
    { inventoryId: "narra", leftoverQuantity: 5, leftoverReason: "Spare" }, { inventoryId: "mahogany", leftoverQuantity: 0 }]), balances);
  assert.deepEqual(rows.map((row) => [row.inventoryId, row.remaining, row.quantity, row.leftoverQuantity]), [["narra", 25, 20, 5], ["mahogany", 15, 15, 0]]);
  // All leftovers is still a valid final report for that type.
  assert.equal(finalRowsFor(parseFinalItems([{ inventoryId: "narra", leftoverQuantity: 25, leftoverReason: "Site flooded" }, { inventoryId: "mahogany", leftoverQuantity: 0 }]), balances)[0].quantity, 0);
  assert.throws(() => finalRowsFor(parseFinalItems([{ inventoryId: "narra", leftoverQuantity: 0 }]), balances), (error) => error.status === 409, "missing type");
  assert.throws(() => finalRowsFor(parseFinalItems([{ inventoryId: "narra", leftoverQuantity: 0 }, { inventoryId: "mahogany", leftoverQuantity: 0 }, { inventoryId: "molave", leftoverQuantity: 0 }]), balances),
    (error) => error.status === 409, "a type with no balance left is not part of the final report");
  assert.throws(() => finalRowsFor(parseFinalItems([{ inventoryId: "narra", leftoverQuantity: 26, leftoverReason: "x" }, { inventoryId: "mahogany", leftoverQuantity: 0 }]), balances), (error) => error.status === 409);
  assert.throws(() => finalRowsFor([], [{ inventoryId: "narra", remaining: 0 }]), (error) => error.status === 409 && /No seedlings remain/.test(error.message));
});

test("only pending or approved final reports block a new one; revisions continue across returns and rejections", () => {
  const row = (fields) => ({ submissionWorkflowVersion: 4, finalReportGroupId: "g1", staffReviewStatus: "Pending Review", ...fields });
  assert.equal(isActiveFinalRow(row({})), true);
  assert.equal(isActiveFinalRow(row({ staffReviewStatus: "Accepted", workflowStatus: "Completed" })), true);
  assert.equal(isActiveFinalRow(row({ staffReviewStatus: "Rejected", workflowStatus: "Returned for Correction" })), false);
  assert.equal(isActiveFinalRow(row({ staffReviewStatus: "Rejected", workflowStatus: "Rejected" })), false);
  assert.equal(isActiveFinalRow(row({ correctedBySubmission: "g2" })), false);
  assert.equal(isActiveFinalRow({ staffReviewStatus: "Pending Review" }), false, "legacy rows never block a final report");
  assert.throws(() => assertNoActiveFinalReport([row({})]), (error) => error.status === 409);
  assert.doesNotThrow(() => assertNoActiveFinalReport([{ staffReviewStatus: "Accepted" }]));
  assert.equal(nextFinalRevision([]), 0);
  assert.equal(nextFinalRevision([row({ finalReportRevision: 0 }), row({ finalReportRevision: 2 }), { revision: 9 }]), 3);
  assert.equal(finalReportIdFor("EVT-1"), "FPR-EVT-1");
});

const { staffCorrectableFields, parseCorrectionFields, editableCorrectionPaths, correctionChanges } = require("../src/utils/finalPlantingReport.util");

test("correctable fields come from what was actually submitted; authoritative data is never selectable", () => {
  const rows = [
    { inventoryId: "narra", species: "Narra", leftoverQuantity: 2, leftoverReason: "Wilted", confirmationBasis: "menro-field-report", remarks: "R" },
    { inventoryId: "molave", species: "Molave", leftoverQuantity: 0, confirmationBasis: "menro-field-report", remarks: "R" },
  ];
  const paths = (operation) => staffCorrectableFields(rows, operation).map((field) => field.path);
  assert.deepEqual(paths({}), ["items.narra.leftoverQuantity", "items.narra.leftoverReason", "items.molave.leftoverQuantity", "confirmationBasis", "remarks"]);
  assert.deepEqual(paths({ evidenceVerified: true, evidenceSubmissionId: "e1", attendance: { sha256: "a" } }).slice(-2), ["evidence.photos", "evidence.attendance"]);
  const releaseBased = staffCorrectableFields(rows.map((row) => ({ ...row, confirmationBasis: "release-based" })), { evidenceVerified: true });
  assert.equal(releaseBased.some((field) => field.path === "evidence.photos"), false, "no photo evidence on release-based reports");
  assert.ok(staffCorrectableFields(rows, {}).every((field) => !/plantingDate|siteId|eventId|requestId|quantityPlanted|\.quantity$/.test(field.path)));

  const allowed = staffCorrectableFields(rows, {});
  assert.deepEqual(parseCorrectionFields([{ path: "remarks", comment: " Add names " }], allowed), [{ path: "remarks", label: "Remarks", comment: "Add names", previousValue: "R" }]);
  assert.throws(() => parseCorrectionFields([{ path: "items.molave.leftoverReason", comment: "x" }], allowed), (error) => error.status === 400, "no reason was submitted for molave");
});

test("only selected fields (and a selected leftover's reason) may differ in the resubmission", () => {
  const previous = [
    { inventoryId: "narra", leftoverQuantity: 2, leftoverReason: "Wilted", confirmationBasis: "menro-field-report", remarks: "R" },
    { inventoryId: "molave", leftoverQuantity: 0 },
  ];
  const same = { items: [{ inventoryId: "narra", leftoverQuantity: 2, leftoverReason: " Wilted " }, { inventoryId: "molave", leftoverQuantity: 0, leftoverReason: "ignored" }], confirmationBasis: "menro-field-report", remarks: "R " };
  assert.deepEqual(correctionChanges(previous, same), [], "whitespace and reasons on zero leftovers are not changes");
  assert.deepEqual(correctionChanges(previous, { ...same, items: [{ inventoryId: "narra", leftoverQuantity: 3, leftoverReason: "Broken" }, same.items[1]], remarks: "New" }),
    ["items.narra.leftoverQuantity", "items.narra.leftoverReason", "remarks"]);
  assert.deepEqual(correctionChanges(previous, { ...same, items: [same.items[0]] }), ["items.molave.leftoverQuantity"], "a type cannot be dropped");
  assert.deepEqual([...editableCorrectionPaths(["items.narra.leftoverQuantity", "remarks"])].sort(),
    ["items.narra.leftoverQuantity", "items.narra.leftoverReason", "remarks"]);
});
