const test = require("node:test");
const assert = require("node:assert/strict");
const { INDEX_MISSING_CODE, isMissingIndexError, publicQueryError } = require("../src/utils/firestoreQueryError");

const raw = Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/demo/firestore/indexes?create_composite=abc"), { code: 9 });

test("a missing Firestore index becomes a stable 503 without the console link", (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  const error = publicQueryError(raw, "sample-monitoring-visits");
  assert.equal(error.status, 503);
  assert.equal(error.code, INDEX_MISSING_CODE);
  assert.doesNotMatch(error.message, /console\.firebase|FAILED_PRECONDITION|create_composite/);
  // Operators still get the original link in the server log.
  assert.equal(logged.length, 1);
  assert.match(JSON.stringify(logged[0]), /create_composite/);
});

test("other errors pass through unchanged", () => {
  const conflict = Object.assign(new Error("Monitoring visit is not ready for review."), { status: 409 });
  assert.equal(publicQueryError(conflict), conflict);
  const other = Object.assign(new Error("9 FAILED_PRECONDITION: transaction aborted"), { code: 9 });
  assert.equal(isMissingIndexError(other), false);
  assert.equal(publicQueryError(other), other);
  assert.equal(isMissingIndexError(null), false);
});

test("string error codes from the client SDK are recognised", () => {
  assert.equal(isMissingIndexError({ code: "failed-precondition", message: "The query requires an index." }), true);
});
