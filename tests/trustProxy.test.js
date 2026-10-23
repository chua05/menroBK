const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { configureTrustProxy } = require("../src/config/trustProxy");

async function withServer(nodeEnv, configure, callback) {
  const app = express();
  configureTrustProxy(app, nodeEnv);
  configure(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(url, forwardedFor) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("local requests ignore caller-supplied forwarded addresses", async () => {
  await withServer("test", (app) => {
    app.get("/ip", (req, res) => res.json({ ip: req.ip }));
  }, async (baseUrl) => {
    const response = await request(`${baseUrl}/ip`, "198.51.100.25");
    assert.equal(response.status, 200);
    assert.notEqual(JSON.parse(response.body).ip, "198.51.100.25");
  });
});

test("production trusts exactly the nearest Render proxy hop", async () => {
  await withServer("production", (app) => {
    app.get("/ip", (req, res) => res.json({ ip: req.ip, ips: req.ips }));
  }, async (baseUrl) => {
    const response = await request(`${baseUrl}/ip`, "198.51.100.25, 203.0.113.9");
    const body = JSON.parse(response.body);
    assert.equal(body.ip, "203.0.113.9");
    assert.deepEqual(body.ips, ["203.0.113.9"]);
  });
});

test("spoofing an earlier forwarded entry cannot bypass the production limiter", async () => {
  await withServer("production", (app) => {
    app.use(rateLimit({ windowMs: 60_000, max: 1, standardHeaders: false, legacyHeaders: false }));
    app.get("/limited", (_req, res) => res.sendStatus(204));
  }, async (baseUrl) => {
    const first = await request(`${baseUrl}/limited`, "198.51.100.10, 203.0.113.9");
    const second = await request(`${baseUrl}/limited`, "198.51.100.11, 203.0.113.9");
    assert.equal(first.status, 204);
    assert.equal(second.status, 429);
  });
});
