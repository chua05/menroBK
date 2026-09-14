const {
  auth,
  db,
} = require("../config/firebase");


// =====================================================
// CREATE / VERIFY USER PROFILE
// =====================================================

const createUserProfile = async (
  user
) => {

  const userRef =
    db
      .collection("users")
      .doc(user.uid);


  const doc =
    await userRef.get();


  const now =
    new Date();


  if (!doc.exists) {

    await userRef.set({

      uid:
        user.uid,

      fullName:
        user.name ||
        user.displayName ||
        user.fullName ||
        "",

      email:
        user.email || "",

      username:
        user.username || "",

      role:
        "participant",

      organization:
        "",

      contactNumber:
        "",

      barangay:
        "",

      status:
        "active",

      photoURL:
        user.picture ||
        user.photoURL ||
        "",

      createdAt:
        now,

      updatedAt:
        now,

      lastLoginAt:
        now,

    });

  }

  else {

    await userRef.update({

      lastLoginAt:
        now,

      updatedAt:
        now,

    });

  }


  return (
    await userRef.get()
  ).data();

};


// =====================================================
// GET PROFILE
// =====================================================

const getUserProfile = async (
  uid
) => {

  const doc =
    await db
      .collection("users")
      .doc(uid)
      .get();


  if (!doc.exists) {

    throw new Error(
      "User not found"
    );

  }


  return doc.data();

};


// =====================================================
// UPDATE PROFILE
// =====================================================

const updateUserProfile = async (
  uid,
  data
) => {

  const allowedUpdates = {};


  if (
    data.fullName !== undefined
  ) {

    allowedUpdates.fullName =
      data.fullName;

  }


  if (
    data.username !== undefined
  ) {

    allowedUpdates.username =
      data.username;

  }


  if (
    data.contactNumber !== undefined
  ) {

    allowedUpdates.contactNumber =
      data.contactNumber;

  }


  if (
    data.organization !== undefined
  ) {

    allowedUpdates.organization =
      data.organization;

  }


  if (
    data.barangay !== undefined
  ) {

    allowedUpdates.barangay =
      data.barangay;

  }


  if (
    data.photoURL !== undefined
  ) {

    allowedUpdates.photoURL =
      data.photoURL;

  }


  allowedUpdates.updatedAt =
    new Date();


  await db
    .collection("users")
    .doc(uid)
    .update(
      allowedUpdates
    );


  return true;

};


// =====================================================
// REGISTER USER
// =====================================================

const registerUser = async ({

  fullName,

  username,

  email,

  contactNumber,

  password,

  organization,

  barangay,

}) => {


  const firebaseUser =
    await auth.createUser({

      email,

      password,

      displayName:
        fullName,

    });


  const role =
    "participant";


  const status =
    "active";


  const now =
    new Date();


  await db
    .collection("users")
    .doc(firebaseUser.uid)
    .set({

      uid:
        firebaseUser.uid,

      fullName,

      username,

      email,

      role,

      organization:
        organization || "",

      contactNumber:
        contactNumber || "",

      barangay:
        barangay || "",

      status,

      photoURL:
        "",

      createdAt:
        now,

      updatedAt:
        now,

      lastLoginAt:
        null,

    });


  return {

    uid:
      firebaseUser.uid,

    fullName,

    username,

    email,

    role,

    organization:
      organization || "",

    contactNumber:
      contactNumber || "",

    barangay:
      barangay || "",

    status,

  };

};


module.exports = {

  registerUser,

  createUserProfile,

  getUserProfile,

  updateUserProfile,

};