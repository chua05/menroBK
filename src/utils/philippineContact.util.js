// Mirrors menrofrontend/src/utils/philippineContact.js.
// Mobile: 09XX XXX XXXX. Landline: (02) XXXX XXXX or (0XX) XXX XXXX. Both accept +63 or 63.
const PHILIPPINE_CONTACT_NUMBER = /^(?:\+?63|0)(?:9\d{9}|[2-8]\d{8})$/;

function isValidPhilippineContactNumber(value) {
  return PHILIPPINE_CONTACT_NUMBER.test(String(value ?? "").replace(/[\s().-]/g, ""));
}

module.exports = { isValidPhilippineContactNumber };
