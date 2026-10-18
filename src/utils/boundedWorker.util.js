const { FieldPath, Timestamp } = require("firebase-admin/firestore");

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_BUDGET = 5000;

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function safeErrorMessage(error) {
  const code = String(error?.code || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return code ? `Record processing failed (${code}).` : "Record processing failed.";
}

async function readCheckpoint(db, workerId) {
  const snapshot = await db.collection("workerCheckpoints").doc(workerId).get();
  return snapshot.exists && typeof snapshot.data().cursorId === "string"
    ? snapshot.data().cursorId
    : null;
}

async function compareAndSetCheckpoint(db, workerId, expectedCursor, nextCursor) {
  const ref = db.collection("workerCheckpoints").doc(workerId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists && typeof snapshot.data().cursorId === "string"
      ? snapshot.data().cursorId
      : null;
    if (current !== expectedCursor) return false;
    transaction.set(ref, {
      cursorId: nextCursor,
      updatedAt: Timestamp.now(),
    }, { merge: true });
    return true;
  });
}

/**
 * Scan a collection in stable document-id order without loading it all at once.
 * A small compare-and-set checkpoint is required to guarantee that a bounded
 * recurring worker eventually reaches records beyond its first run budget.
 */
async function processBoundedCollection({
  db,
  workerId,
  collectionName,
  buildQuery = (collection) => collection,
  processDocument,
  budget = DEFAULT_BUDGET,
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  const safeBudget = boundedInteger(budget, DEFAULT_BUDGET, 10000);
  const safePageSize = boundedInteger(pageSize, DEFAULT_PAGE_SIZE, 500);
  const initialCursor = await readCheckpoint(db, workerId);
  let cursor = initialCursor;
  let processed = 0;
  let reachedEnd = false;
  const results = [];
  const failures = [];

  while (processed < safeBudget) {
    const remaining = safeBudget - processed;
    const requested = Math.min(safePageSize, remaining) + 1;
    let query = buildQuery(db.collection(collectionName))
      .orderBy(FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.limit(requested).get();
    const documents = snapshot.docs.slice(0, Math.min(safePageSize, remaining));

    if (documents.length === 0) {
      reachedEnd = true;
      break;
    }

    for (const document of documents) {
      try {
        results.push(await processDocument(document));
      } catch (error) {
        const failure = { recordId: document.id, message: safeErrorMessage(error) };
        failures.push(failure);
        results.push({ recordId: document.id, outcome: "failed" });
        console.error(`[${workerId}] Record ${document.id} failed: ${failure.message}`);
      }
      processed += 1;
      cursor = document.id;
    }

    if (snapshot.docs.length <= documents.length) {
      reachedEnd = true;
      break;
    }
  }

  const nextCursor = reachedEnd ? null : cursor;
  const checkpointUpdated = await compareAndSetCheckpoint(
    db, workerId, initialCursor, nextCursor
  );

  Object.defineProperty(results, "summary", {
    enumerable: false,
    value: {
      workerId,
      processed,
      failures,
      budget: safeBudget,
      budgetExhausted: !reachedEnd,
      reachedEnd,
      nextCursor,
      checkpointUpdated,
    },
  });
  return results;
}

module.exports = {
  DEFAULT_BUDGET,
  DEFAULT_PAGE_SIZE,
  processBoundedCollection,
  safeErrorMessage,
};
