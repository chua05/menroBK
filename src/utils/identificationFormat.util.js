// These are syntax checks, never identity/authenticity verification. Ambiguous
// document families retain bounded printed identifiers for MENRO manual review.
function identificationFormatError(type, value) {
  const compact = String(value || "").replace(/[ -]/g, "");
  if (type === "national_id" && (!/^[\d -]+$/.test(value) || !/^\d{16}$/.test(compact))) return "Enter the 16-digit PhilSys Card Number (PCN), not the confidential 12-digit PSN.";
  if (type === "philhealth" && (!/^[\d -]+$/.test(value) || !/^\d{12}$/.test(compact))) return "Enter the 12-digit PhilHealth Identification Number (PIN).";
  if (type === "tin" && (!/^[\d -]+$/.test(value) || !/^(?:\d{9}|\d{12,14})$/.test(compact))) return "Enter the nine-digit TIN, optionally with its printed branch code.";
  return "";
}
module.exports = { identificationFormatError };
