const { auth, db } = require("../config/firebase");



// CREATE USER PROFILE
const createUserProfile = async (user) => {

  const userRef = db.collection("users").doc(user.uid);

  const doc = await userRef.get();


  if (!doc.exists) {

    await userRef.set({

      uid: user.uid,

      fullName: user.name || user.displayName || "",

      email: user.email,

      role: "participant",

      organization: "",

      contactNumber: "",

      status: "active",

      photoURL: user.picture || "",

      createdAt: new Date(),

      updatedAt: new Date()

    });

  }


  return (await userRef.get()).data();

};




// GET PROFILE

const getUserProfile = async (uid) => {

  const doc = await db
    .collection("users")
    .doc(uid)
    .get();


  if (!doc.exists) {

    throw new Error("User not found");

  }


  return doc.data();

};




// UPDATE PROFILE

const updateUserProfile = async (uid, data) => {

  await db
    .collection("users")
    .doc(uid)
    .update({

      ...data,

      updatedAt: new Date()

    });


  return true;

};




// REGISTER USER

const registerUser = async ({


  fullName,
  username,
  email,
  contactNumber,
  password,
  organization,
}) => {


  const firebaseUser = await auth.createUser({
    email,

    password,

    displayName: fullName


  });

  const role = "participant";

  const status = "active";



  await db
    .collection("users")
    .doc(firebaseUser.uid)
    .set({


      uid: firebaseUser.uid,


      fullName,

      username,

      email,

      role,

      organization: organization || "",

      contactNumber: contactNumber || "",

      status,

      photoURL: "",

      createdAt: new Date(),

      updatedAt: new Date()


    });



  return {


    uid: firebaseUser.uid,

    fullName,

    username,

    email,

    role,

    organization: organization || "",

    contactNumber: contactNumber || "",

    status


  };


};


module.exports = {
  registerUser,
  createUserProfile,
  getUserProfile,
  updateUserProfile
};