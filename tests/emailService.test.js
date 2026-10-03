const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (parent?.filename?.endsWith("email.service.js") && request === "../config/firebase") {
    return { auth: {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  getFrontendUrl,
  getMailConfiguration,
  verificationEmail,
  welcomeEmail,
} = require("../src/services/email.service");
Module._load = originalLoad;

test("mail configuration requires an explicit server-side provider, key, and sender", () => {
  assert.equal(getMailConfiguration({}).configured, false);
  assert.equal(getMailConfiguration({
    MAIL_PROVIDER: "resend",
    RESEND_API_KEY: "test-key",
    EMAIL_FROM: "MENRO <no-reply@example.gov.ph>",
  }).configured, true);
});

test("frontend verification origin is normalized and rejects invalid URLs", () => {
  assert.equal(
    getFrontendUrl({ FRONTEND_URL: "https://menro.example.gov.ph/some-path" }),
    "https://menro.example.gov.ph",
  );
  assert.equal(getFrontendUrl({ FRONTEND_URL: "javascript:alert(1)" }), "");
});

test("MENRO email templates contain dynamic escaped names and the verification CTA", () => {
  const verification = verificationEmail({
    displayName: "Kyla <Admin>",
    verificationUrl: "https://menro.example/verify-email?oobCode=abc",
  });
  assert.match(verification.html, /Verify Email Address/);
  assert.match(verification.html, /Hello Kyla &lt;Admin&gt;/);
  assert.doesNotMatch(verification.html, /Hello Kyla,<\/p>/);

  const welcome = welcomeEmail({ displayName: "Juan" });
  assert.match(welcome.text, /Hello Juan,/);
  assert.match(welcome.text, /Please verify your email address before accessing your account/);
});
