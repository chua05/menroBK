const assert = require("node:assert/strict");
const test = require("node:test");

const {
  USER_TYPES,
  validateParticipantProfile,
  isParticipantProfileComplete,
} = require("../src/utils/userProfile.util");

test("all supported participant user types validate with their required identity", () => {
  assert.equal(USER_TYPES.length, 7);
  const profiles = {
    "Barangay Official": { barangay: "North Poblacion" },
    Volunteer: { barangay: "South Poblacion" },
    "Organization Member": { userTypeDetail: "Juban Environment Group" },
    "Student / School Representative": { userTypeDetail: "Juban National High School" },
    "Government Employee": { userTypeDetail: "Municipal Environment Office" },
    "Private Sector Representative": { userTypeDetail: "Juban Green Company" },
    Other: { userTypeDetail: "Community Resident" },
  };
  const validated = USER_TYPES.map((userType) => validateParticipantProfile({ userType, ...profiles[userType] }));
  assert.equal(validated[0].organization, "North Poblacion");
  assert.equal(validated[1].organization, "South Poblacion");
  const student = validated[3];
  assert.equal(student.affiliationName, "Juban National High School");
  assert.equal(isParticipantProfileComplete({ ...student, fullName: "Test", username: "test", contactNumber: "09171234567" }), true);
});

test("conditional participant identity fields remain mandatory", () => {
  assert.throws(() => validateParticipantProfile({ userType: "Barangay Official" }), /Please select your barangay/);
  assert.throws(() => validateParticipantProfile({ userType: "Organization Member" }), /Please enter your organization name/);
  assert.throws(() => validateParticipantProfile({ userType: "Student / School Representative" }), /Please enter your school or institution name/);
  assert.throws(() => validateParticipantProfile({ userType: "Other" }), /Please specify your user type/);
});
