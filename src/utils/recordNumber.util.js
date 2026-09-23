const { db } = require("../config/firebase");

const COUNTERS_COLLECTION = "counters";

function yearInJuban(date = new Date()) {
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

async function nextRecordNumber(transaction, { prefix, counterKey, date = new Date(), timestamp }) {
  const year = yearInJuban(date);
  const counterRef = db.collection(COUNTERS_COLLECTION).doc(`${counterKey}_${year}`);
  const counterDoc = await transaction.get(counterRef);
  const nextSequence = Number(counterDoc.data()?.lastNumber || 0) + 1;

  if (!Number.isSafeInteger(nextSequence) || nextSequence <= 0) {
    throw new Error("Unable to generate the next record number.");
  }

  const counterData = {
    year,
    lastNumber: nextSequence,
    updatedAt: timestamp || date,
  };

  if (counterDoc.exists) transaction.update(counterRef, counterData);
  else transaction.create(counterRef, counterData);

  return formatRecordNumber(prefix, year, nextSequence);
}

module.exports = {
  formatRecordNumber,
  nextRecordNumber,
  yearInJuban,
};

