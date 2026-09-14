const { db } = require("../config/firebase");

const USERS_COLLECTION = "users";

const VALID_ROLES = [
  "admin",
  "staff",
  "participant"
];

const VALID_STATUSES = [
  "active",
  "inactive"
];

const getUserByUid = async (uid) => {
  const userDoc = await db
    .collection(USERS_COLLECTION)
    .doc(uid)
    .get();

  if (!userDoc.exists) {
    return null;
  }

  return {
    ...userDoc.data(),
    uid: userDoc.id,
  };
};

const getUserRoleByUid = async (uid) => {
  const user = await getUserByUid(uid);

  if (!user) {
    return "participant";
  }

  return user.role || "participant";
};

const getAllUsers = async () => {
  const snapshot = await db
    .collection(USERS_COLLECTION)
    .get();

  return snapshot.docs.map((doc) => ({
    ...doc.data(),
    uid: doc.id,
  }));
};

const updateUserRole = async (uid, role) => {
   const normalizedRole =
    String(role || "").toLowerCase();
    
  if (!VALID_ROLES.includes(normalizedRole)) {
    throw new Error("Invalid user role.");
  }

  const userRef = db
    .collection(USERS_COLLECTION)
    .doc(uid);

  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    throw new Error("User not found.");
  }

  await userRef.update({
    role: normalizedRole,
    updatedAt: new Date(),
  });

  const updatedDoc = await userRef.get();

  return {
    ...updatedDoc.data(),
    uid: updatedDoc.id,
  };
};

const updateUserStatus = async (uid, status) => {
  const normalizedStatus = String(status || "").toLowerCase();
  
  if (!VALID_STATUSES.includes(normalizedStatus)) {
    throw new Error("Invalid user status.");
  }

  const userRef = db
    .collection(USERS_COLLECTION)
    .doc(uid);

  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    throw new Error("User not found.");
  }

  await userRef.update({
    status,
    updatedAt: new Date(),
  });

  const updatedDoc = await userRef.get();

  return {
    ...updatedDoc.data(),
    uid: updatedDoc.id,
  };
};

const updateUserProfile = async (uid, data) => {
  const allowedUpdates = {};

  if (data.fullName !== undefined) {
    allowedUpdates.fullName = data.fullName;
  }

  if (data.username !== undefined) {
    allowedUpdates.username = data.username;
  }

  if (data.contactNumber !== undefined) {
    allowedUpdates.contactNumber = data.contactNumber;
  }

  if (data.organization !== undefined) {
    allowedUpdates.organization = data.organization;
  }

  allowedUpdates.updatedAt = new Date();

  const userRef = db
    .collection(USERS_COLLECTION)
    .doc(uid);

  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    throw new Error("User not found.");
  }

  await userRef.update(allowedUpdates);

  const updatedDoc = await userRef.get();

  return {
    ...updatedDoc.data(),
    uid: updatedDoc.id,
  };
};

module.exports = {
  getUserByUid,
  getUserRoleByUid,
  getAllUsers,
  updateUserRole,
  updateUserStatus,
  updateUserProfile,
};