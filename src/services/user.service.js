const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const USERS_COLLECTION = "users";
const AUDIT_COLLECTION = "auditLogs";

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

const updatePrivilegedField = async ({ uid, field, value, actorId, action }) => {
  if (typeof uid !== "string" || !uid.trim() || uid.includes("/") || !actorId) {
    throw new Error("Invalid user operation.");
  }
  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  const auditRef = db.collection(AUDIT_COLLECTION).doc();
  await db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) throw new Error("User not found.");
    const oldValue = userDoc.data()[field];
    if (oldValue === value) return;
    const timestamp = Timestamp.now();
    transaction.update(userRef, { [field]: value, updatedAt: timestamp });
    transaction.create(auditRef, {
      action,
      targetUserId: uid,
      performedBy: actorId,
      oldValue: oldValue ?? null,
      newValue: value,
      timestamp,
    });
  });
  const updatedDoc = await userRef.get();
  return { ...updatedDoc.data(), uid: updatedDoc.id };
};

const updateUserRole = async (uid, role, actorId) => {
   const normalizedRole =
    String(role || "").toLowerCase();
    
  if (!VALID_ROLES.includes(normalizedRole)) {
    throw new Error("Invalid user role.");
  }

  return updatePrivilegedField({ uid, field: "role", value: normalizedRole,
    actorId, action: "USER_ROLE_CHANGED" });
};

const updateUserStatus = async (uid, status, actorId) => {
  const normalizedStatus = String(status || "").toLowerCase();
  
  if (!VALID_STATUSES.includes(normalizedStatus)) {
    throw new Error("Invalid user status.");
  }

  return updatePrivilegedField({ uid, field: "status", value: normalizedStatus,
    actorId, action: "USER_STATUS_CHANGED" });
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

  if (data.userType !== undefined) allowedUpdates.userType = data.userType;
  if (data.userTypeDetail !== undefined) allowedUpdates.userTypeDetail = data.userTypeDetail;
  if (data.affiliationName !== undefined) allowedUpdates.affiliationName = data.affiliationName;
  if (data.barangay !== undefined) allowedUpdates.barangay = data.barangay;

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
