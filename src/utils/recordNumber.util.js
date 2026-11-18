const { db } = require("../config/firebase");

const COUNTERS_COLLECTION = "counters";

function yearInManila(date = new Date()) {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
  }).format(date));
}

function formatRecordNumber(prefix, year, sequence) {
  const normalizedPrefix = String(prefix || "").trim().toUpperCase();
  const normalizedYear = Number(year);
  const normalizedSequence = Number(sequence);

  if (!/^[A-Z]{2,8}$/.test(normalizedPrefix) ||
      !Number.isInteger(normalizedYear) || normalizedYear < 1000 || normalizedYear > 9999 ||
      !Number.isSafeInteger(normalizedSequence) || normalizedSequence <= 0) {
    throw new Error("Invalid record number configuration.");
  }

  return `${normalizedPrefix}-${normalizedYear}-${String(normalizedSequence).padStart(3, "0")}`;
}

// Read phase only: reserves the next year-based sequence inside a transaction without writing, so callers
// can finish every transaction read before any write. The counter read makes Firestore retry the whole
// transaction if another transaction takes the same number first, so two records never share a number.
async function reserveRecordNumber(transaction, { prefix, counterKey, date = new Date() }) {
  const year = yearInManila(date);
  const counterRef = db.collection(COUNTERS_COLLECTION).doc(`${counterKey}_${year}`);
  const counterDoc = await transaction.get(counterRef);
  const nextSequence = Number(counterDoc.data()?.lastNumber || 0) + 1;

  if (!Number.isSafeInteger(nextSequence) || nextSequence <= 0) {
    throw new Error("Unable to generate the next record number.");
  }
  return { counterRef, exists: counterDoc.exists, year, nextSequence, number: formatRecordNumber(prefix, year, nextSequence), date };
}

// Write phase: records the reserved sequence on the counter.
function commitRecordNumber(transaction, reservation, timestamp) {
  const counterData = {
    year: reservation.year,
    lastNumber: reservation.nextSequence,
    updatedAt: timestamp || reservation.date,
  };
  if (reservation.exists) transaction.update(reservation.counterRef, counterData);
  else transaction.create(reservation.counterRef, counterData);
  return reservation.number;
}

async function nextRecordNumber(transaction, { prefix, counterKey, date = new Date(), timestamp }) {
  const reservation = await reserveRecordNumber(transaction, { prefix, counterKey, date });
  return commitRecordNumber(transaction, reservation, timestamp);
}

module.exports = {
  commitRecordNumber,
  formatRecordNumber,
  nextRecordNumber,
  reserveRecordNumber,
  yearInManila,
};

