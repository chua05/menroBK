// Firestore rejects a query whose composite index is missing with gRPC code 9
// (FAILED_PRECONDITION) and a message containing a Firebase console link. That
// link and the raw message are operator details, never user-facing text: the
// error is logged server-side and replaced by a stable public error.
const INDEX_MISSING_CODE = "MONITORING_QUERY_INDEX_MISSING";

function isMissingIndexError(error) {
  if (!error || error.status) return false;
  const message = String(error.message || "");
  return (error.code === 9 || error.code === "failed-precondition" || /FAILED_PRECONDITION/.test(message))
    && /requires an index/i.test(message);
}

function publicQueryError(error, context = "query") {
  if (!isMissingIndexError(error)) return error;
  // Operators need the index link to deploy firestore.indexes.json; users never see it.
  console.error(`[firestore-index-missing] ${context}`, { message: String(error.message || "") });
  return Object.assign(
    new Error("Monitoring visits are temporarily unavailable because a required database index is not ready. Contact the MENRO system administrator."),
    { status: 503, code: INDEX_MISSING_CODE },
  );
}

module.exports = { INDEX_MISSING_CODE, isMissingIndexError, publicQueryError };
