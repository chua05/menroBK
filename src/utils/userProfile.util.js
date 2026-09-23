const USER_TYPES = [
  "Barangay Official", "Volunteer", "Organization Member",
  "Student / School Representative", "Government Employee",
  "Private Sector Representative", "Other",
];

const clean = (value) => typeof value === "string" ? value.trim() : "";

function validateParticipantProfile(input = {}) {
  const userType = clean(input.userType);
  const userTypeDetail = clean(input.userTypeDetail);
  const barangay = clean(input.barangay);
  if (!USER_TYPES.includes(userType)) throw new Error("Please select your user type.");
  if (["Barangay Official", "Volunteer"].includes(userType) && !barangay) {
    throw new Error("Please select your barangay.");
  }
  const errors = {
    "Organization Member": "Please enter your organization name.",
    "Student / School Representative": "Please enter your school or institution name.",
    "Government Employee": "Please enter your office name.",
    "Private Sector Representative": "Please enter your company or organization name.",
    Other: "Please specify your user type.",
  };
  if (errors[userType] && !userTypeDetail) throw new Error(errors[userType]);
  return {
    userType,
    userTypeDetail,
    barangay: ["Barangay Official", "Volunteer"].includes(userType) ? barangay : "",
    affiliationName: userTypeDetail || barangay,
    organization: userTypeDetail || barangay,
  };
}

function isParticipantProfileComplete(profile = {}) {
  if (!clean(profile.fullName) || !clean(profile.username) || !clean(profile.contactNumber)) return false;
  try { validateParticipantProfile(profile); return true; } catch { return false; }
}

module.exports = { USER_TYPES, validateParticipantProfile, isParticipantProfileComplete };
