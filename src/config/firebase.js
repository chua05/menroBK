const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
require("dotenv").config();


const serviceAccount = require("../../serviceAccountKey.json");

const app = initializeApp({
  credential: cert(serviceAccount),
});


const db = getFirestore(app);
const auth = getAuth(app);

module.exports = {
  app,
  db,
  auth,
};