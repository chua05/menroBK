require("dotenv").config();

const { db } = require("./config/firebase");

async function testFirebase() {
  try {
    await db.collection("test").doc("connection").set({
      status: "success",
      createdAt: new Date(),
    });

    console.log("✅ Firebase Connected");
  } catch (error) {
    console.error("❌ Firebase Error");
    console.error(error);
  }
}

testFirebase();