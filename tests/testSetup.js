if (process.env.NODE_ENV === "production") {
  throw new Error("The unit test suite cannot run with NODE_ENV=production.");
}

process.env.NODE_ENV = "test";
process.env.MENRO_UNIT_TEST_FIREBASE = "true";

for (const key of [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_CONFIG",
]) {
  delete process.env[key];
}
