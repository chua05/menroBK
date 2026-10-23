// Keep private saved references inside trusted backend services, for EVERY role.
function sanitizeEvidence(value) {
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (!["privateEvidence", "_evidenceRecordId"].includes(key)) result[key] = sanitizeEvidence(child);
  }
  if (value.privateEvidence) result.hasEvidence = true;
  return result;
}
function privateEvidenceResponse(req, res, next) {
  const json = res.json;
  res.json = function (body) { return json.call(this, sanitizeEvidence(body)); };
  next();
}
module.exports = { sanitizeEvidence, privateEvidenceResponse };
