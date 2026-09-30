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
  FRONTEND_URL: " https://menrofrontend-xxtt.vercel.app/ ",
  ALLOWED_ORIGINS: "https://menro.example.gov.ph, https://authorized.example",
  VERCEL_FRONTEND_PROJECT: "menrofrontend-xxtt",
  VERCEL_FRONTEND_TEAM: "chuas-projects-310db6fd",
};

test("CORS allows the configured production origin and normalizes trailing slashes", () => {
  assert.equal(
    isOriginAllowed("https://menrofrontend-xxtt.vercel.app", productionEnv),
    true
  );
  assert.equal(
    isOriginAllowed("https://menro.example.gov.ph/", productionEnv),
    true
  );
});

test("CORS permits only this project's Vercel preview deployment pattern", () => {
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
      "https://menrofrontend-xxtt.vercel.app",
      renderProductionEnv
    ),
    true
  );
  assert.equal(
    isOriginAllowed(
      "https://menrofrontend-xxtt-lydk6lzj3-chuas-projects-310db6fd.vercel.app",
      renderProductionEnv
    ),
    true
  );
  assert.equal(
    isOriginAllowed(
      "https://menrofrontend-xxtt-lydk6lzj3-another-team.vercel.app",
      renderProductionEnv
    ),
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
  app.get("/api/auth/profile", (_req, res) => res.sendStatus(204));
  app.get("/api/inventory", (_req, res) => res.sendStatus(204));

  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });
  try {
    const { port } = server.address();
    const origin =
      "https://menrofrontend-xxtt-lydk6lzj3-chuas-projects-310db6fd.vercel.app";
    for (const [path, method] of [
      ["/api/auth/verify", "POST"],
      ["/api/auth/profile", "GET"],
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
