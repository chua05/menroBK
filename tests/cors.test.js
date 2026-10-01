const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cors = require("cors");

const {
  createCorsOptions,
  isOriginAllowed,
} = require("../src/config/cors");

const productionEnv = {
  NODE_ENV: "production",
  FRONTEND_URL: " https://menro-xxtt-five.vercel.app/ ",
  ALLOWED_ORIGINS: "http://localhost:5173, https://authorized.example",
  ALLOW_VERCEL_PREVIEWS: "true",
  VERCEL_FRONTEND_PROJECT: "menrofrontend-xxtt",
  VERCEL_FRONTEND_TEAM: "chuas-projects-310db6fd",
};

test("CORS allows the configured production origin and normalizes trailing slashes", () => {
  assert.equal(
    isOriginAllowed("https://menro-xxtt-five.vercel.app", productionEnv),
    true
  );
  assert.equal(
    isOriginAllowed("http://localhost:5173/", productionEnv),
    true
  );
});

test("CORS permits only an explicitly enabled project preview pattern", () => {
  assert.equal(
    isOriginAllowed(
      "https://menrofrontend-xxtt-lydk6lzj3-chuas-projects-310db6fd.vercel.app",
      productionEnv
    ),
    true
  );
  assert.equal(
    isOriginAllowed(
      "https://unrelated-project-lydk6lzj3-chuas-projects-310db6fd.vercel.app",
      productionEnv
    ),
    false
  );
  assert.equal(
    isOriginAllowed("https://attacker.vercel.app", productionEnv),
    false
  );

  const renderProductionEnv = { NODE_ENV: "production" };
  assert.equal(
    isOriginAllowed(
      "https://menro-xxtt-five.vercel.app",
      renderProductionEnv
    ),
    true
  );
  assert.equal(
    isOriginAllowed(
      "https://menrofrontend-xxtt-lydk6lzj3-chuas-projects-310db6fd.vercel.app",
      renderProductionEnv
    ),
    false
  );
  assert.equal(
    isOriginAllowed(
      "https://menrofrontend-xxtt-lydk6lzj3-another-team.vercel.app",
      renderProductionEnv
    ),
    false
  );
});

test("CORS rejects unknown origins and malformed configured values", () => {
  assert.equal(isOriginAllowed("https://example-attacker.com", productionEnv), false);
  assert.equal(
    isOriginAllowed("https://authorized.example", {
      ...productionEnv,
      ALLOWED_ORIGINS: "https://authorized.example/path",
    }),
    false
  );
});

test("CORS allows loopback development origins but not arbitrary development origins", () => {
  const developmentEnv = { NODE_ENV: "development" };
  assert.equal(isOriginAllowed("http://localhost:5173", developmentEnv), true);
  assert.equal(isOriginAllowed("http://127.0.0.1:5174", developmentEnv), true);
  assert.equal(isOriginAllowed("https://not-authorized.example", developmentEnv), false);
});

test("authorized OPTIONS preflight covers verify, profile, and a protected API", async () => {
  const app = express();
  app.use(cors(createCorsOptions(productionEnv)));
  app.post("/api/auth/verify", (_req, res) => res.sendStatus(204));
  app.get("/api/auth/me", (_req, res) => res.sendStatus(204));
  app.get("/api/auth/profile", (_req, res) => res.sendStatus(204));
  app.put("/api/auth/profile", (_req, res) => res.sendStatus(204));
  app.get("/api/inventory", (_req, res) => res.sendStatus(204));

  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });
  try {
    const { port } = server.address();
    const origin = "https://menro-xxtt-five.vercel.app";
    for (const [path, method] of [
      ["/api/auth/verify", "POST"],
      ["/api/auth/me", "GET"],
      ["/api/auth/profile", "GET"],
      ["/api/auth/profile", "PUT"],
      ["/api/inventory", "GET"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
      assert.match(
        response.headers.get("access-control-allow-headers") || "",
        /Authorization/i
      );
      assert.match(
        response.headers.get("access-control-allow-methods") || "",
        new RegExp(method, "i")
      );
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("allowed-origin API error responses retain CORS headers", async () => {
  const app = express();
  app.use(cors(createCorsOptions(productionEnv)));
  for (const status of [400, 401, 403, 404, 429, 500]) {
    app.get(`/status-${status}`, (_req, res) => res.status(status).json({ success: false }));
  }

  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });
  try {
    const { port } = server.address();
    const origin = "https://menro-xxtt-five.vercel.app";
    for (const status of [400, 401, 403, 404, 429, 500]) {
      const response = await fetch(`http://127.0.0.1:${port}/status-${status}`, {
        headers: { Origin: origin },
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
