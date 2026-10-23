function configureTrustProxy(app, nodeEnv = process.env.NODE_ENV) {
  // Render places one trusted reverse-proxy hop directly in front of the app.
  // Keep local/test traffic untrusted so a caller cannot supply its own client IP.
  app.set("trust proxy", nodeEnv === "production" ? 1 : false);
}

module.exports = { configureTrustProxy };
