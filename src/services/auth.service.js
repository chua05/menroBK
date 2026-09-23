const { auth, db } = require("../config/firebase");
const { validateParticipantProfile, isParticipantProfileComplete } = require("../utils/userProfile.util");
const { nextRecordNumber } = require("../utils/recordNumber.util");

const users = db.collection("users");
const clean = (value) => typeof value === "string" ? value.trim() : "";
const withCompleteness = (profile) => ({
  ...profile,
  profileComplete: isParticipantProfileComplete(profile),
});

async function createUserProfile(user) {
  const ref = users.doc(user.uid);
  const doc = await ref.get();
  const now = new Date();
  if (!doc.exists) {
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if (current.exists) return;
      const userNumber = await nextRecordNumber(transaction, {
        prefix: "USR",
        counterKey: "users",
        date: now,
        timestamp: now,
      });
      transaction.create(ref, {
        uid: user.uid,
        userNumber,
        fullName: user.name || user.displayName || user.fullName || "",
        email: user.email || "",
        username: user.username || "",
        role: "participant",
        userType: "",
        userTypeDetail: "",
        affiliationName: "",
        organization: "",
        contactNumber: "",
        barangay: "",
        profileComplete: false,
        status: "active",
        photoURL: user.picture || user.photoURL || "",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      });
    });
  } else {
    await ref.update({ lastLoginAt: now, updatedAt: now });
  }
  return withCompleteness((await ref.get()).data());
}

async function getUserProfile(uid) {
  const doc = await users.doc(uid).get();
  if (!doc.exists) throw new Error("User not found");
  return withCompleteness(doc.data());
}

async function updateUserProfile(uid, data = {}) {
  const ref = users.doc(uid);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("User not found");
  const current = doc.data();
  const updates = {};
  for (const field of ["fullName", "username", "photoURL"]) {
    if (data[field] !== undefined) updates[field] = clean(data[field]);
  }
  if (data.contactNumber !== undefined) {
    const contactNumber = clean(data.contactNumber);
    if (!/^09\d{9}$/.test(contactNumber)) throw new Error("Invalid contact number");
    updates.contactNumber = contactNumber;
  }
  if (data.userType !== undefined || data.userTypeDetail !== undefined || data.barangay !== undefined) {
    Object.assign(updates, validateParticipantProfile({
      userType: data.userType ?? current.userType,
      userTypeDetail: data.userTypeDetail ?? current.userTypeDetail,
      barangay: data.barangay ?? current.barangay,
    }));
  }
  updates.profileComplete = isParticipantProfileComplete({ ...current, ...updates });
  updates.updatedAt = new Date();
  await ref.update(updates);
  return withCompleteness((await ref.get()).data());
}

async function registerUser({ fullName, username, email, contactNumber, password, userType, userTypeDetail, barangay }) {
  const participantProfile = validateParticipantProfile({ userType, userTypeDetail, barangay });
  const firebaseUser = await auth.createUser({ email, password, displayName: fullName });
  const now = new Date();
  const profile = {
    uid: firebaseUser.uid,
    fullName,
    username,
    email,
    role: "participant",
    ...participantProfile,
    contactNumber: contactNumber || "",
    profileComplete: true,
    status: "active",
    photoURL: "",
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  };
  try {
    const ref = users.doc(firebaseUser.uid);
    await db.runTransaction(async (transaction) => {
      const userNumber = await nextRecordNumber(transaction, {
        prefix: "USR",
        counterKey: "users",
        date: now,
        timestamp: now,
      });
      transaction.create(ref, { ...profile, userNumber });
      profile.userNumber = userNumber;
    });
  } catch (error) {
    try { await auth.deleteUser(firebaseUser.uid); } catch (cleanupError) {
      console.error("Failed to remove incomplete Firebase Auth account:", cleanupError);
    }
    throw new Error("User profile could not be created.");
  }
  return profile;
}

module.exports = { registerUser, createUserProfile, getUserProfile, updateUserProfile };
