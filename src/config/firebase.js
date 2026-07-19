const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage,} = require("firebase-admin/storage");

require("dotenv").config();

const serviceAccount = require("../../serviceAccountKey.json");

const app = initializeApp({
  credential: cert(serviceAccount),
  storageBucket:
    process.env.FIREBASE_STORAGE_BUCKET,
});

const db = getFirestore(app);
const auth = getAuth(app);
const bucket = getStorage(app).bucket();

module.exports = {
  app,
  db,
  auth,
  bucket,
};