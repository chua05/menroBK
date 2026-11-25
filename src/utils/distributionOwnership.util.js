// A released distribution belongs only to the requester of its seedling request (the citizen for a Staff-encoded walk-in).
// The request is authoritative; a distribution whose copied requester disagrees with it belongs to nobody until MENRO reconciles it.
// Only a legacy distribution without a stored request falls back to its own requester. Names, encoders and event membership never count.
const requestIdOf = (distribution) => String(distribution?.requestId || "").trim();

function isDistributionOwner(distribution, request, uid) {
  if (typeof uid !== "string" || !uid || distribution?.participantId !== uid) return false;
  return request ? request.participantId === uid : true;
}

async function loadDistributionRequest(db, distribution) {
  const id = requestIdOf(distribution);
  if (!id) return null;
  const doc = await db.collection("seedlingRequests").doc(id).get();
  return doc.exists ? doc.data() : null;
}

module.exports = { isDistributionOwner, loadDistributionRequest };
