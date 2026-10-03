const { auth } = require("../config/firebase");

const clean = (value) => String(value || "").trim();

const escapeHtml = (value) => clean(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function getFrontendUrl(env = process.env) {
  const value = clean(env.FRONTEND_URL).replace(/\/$/, "");
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function getMailConfiguration(env = process.env) {
  const provider = clean(env.MAIL_PROVIDER).toLowerCase();
  const apiKey = clean(env.RESEND_API_KEY);
  const from = clean(env.EMAIL_FROM);
  return {
    configured: provider === "resend" && Boolean(apiKey && from),
    provider,
    apiKey,
    from,
    replyTo: clean(env.EMAIL_REPLY_TO),
  };
}

function verificationEmail({ displayName, verificationUrl }) {
  const name = escapeHtml(displayName || "there");
  const url = escapeHtml(verificationUrl);
  return {
    subject: "Verify your MENRO Juban email address",
    text: [
      "MENRO Juban",
      "",
      `Hello ${clean(displayName) || "there"},`,
      "",
      "Thank you for creating your MENRO account.",
      "",
      "Please verify your email address to complete your registration.",
      "",
      verificationUrl,
      "",
      "If you did not create this account, you can safely ignore this email.",
      "",
      "Municipal Environment and Natural Resources Office",
      "Juban, Sorsogon",
    ].join("\n"),
    html: `<!doctype html><html><body style="margin:0;background:#f2f7f3;font-family:Arial,sans-serif;color:#173b2a"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #dce8df"><tr><td style="padding:24px 32px;background:#176b3a;color:#fff"><strong style="font-size:22px">MENRO Juban</strong></td></tr><tr><td style="padding:32px"><p style="font-size:17px">Hello ${name},</p><p>Thank you for creating your MENRO account.</p><p>Please verify your email address to complete your registration.</p><p style="padding:18px 0;text-align:center"><a href="${url}" style="display:inline-block;padding:13px 22px;border-radius:8px;background:#178447;color:#fff;text-decoration:none;font-weight:700">Verify Email Address</a></p><p style="font-size:13px;color:#52645a">If you did not create this account, you can safely ignore this email.</p><p style="margin-top:28px;font-size:13px;color:#52645a">Municipal Environment and Natural Resources Office<br>Juban, Sorsogon</p></td></tr></table></td></tr></table></body></html>`,
  };
}

function welcomeEmail({ displayName }) {
  const name = escapeHtml(displayName || "there");
  return {
    subject: "Welcome to the MENRO Reforestation Monitoring System",
    text: [
      "MENRO Juban",
      "",
      `Hello ${clean(displayName) || "there"},`,
      "",
      "Your account has been successfully registered in the MENRO Reforestation Monitoring System.",
      "",
      "Please verify your email address before accessing your account.",
      "",
      "Thank you.",
      "",
      "Municipal Environment and Natural Resources Office",
      "Juban, Sorsogon",
    ].join("\n"),
    html: `<!doctype html><html><body style="margin:0;background:#f2f7f3;font-family:Arial,sans-serif;color:#173b2a"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #dce8df"><tr><td style="padding:24px 32px;background:#176b3a;color:#fff"><strong style="font-size:22px">MENRO Juban</strong></td></tr><tr><td style="padding:32px"><p style="font-size:17px">Hello ${name},</p><p>Your account has been successfully registered in the MENRO Reforestation Monitoring System.</p><p>Please verify your email address before accessing your account.</p><p>Thank you.</p><p style="margin-top:28px;font-size:13px;color:#52645a">Municipal Environment and Natural Resources Office<br>Juban, Sorsogon</p></td></tr></table></td></tr></table></body></html>`,
  };
}

async function deliverEmail({ to, subject, html, text }, env = process.env) {
  const config = getMailConfiguration(env);
  if (!config.configured) {
    return { sent: false, reason: "EMAIL_PROVIDER_NOT_CONFIGURED" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [to],
      subject,
      html,
      text,
      ...(config.replyTo ? { reply_to: config.replyTo } : {}),
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("Email provider rejected the message.");
    error.code = "EMAIL_DELIVERY_FAILED";
    error.providerStatus = response.status;
    throw error;
  }
  return { sent: true, provider: "resend", messageId: payload.id || "" };
}

async function createVerificationUrl(email, env = process.env) {
  const frontendUrl = getFrontendUrl(env);
  if (!frontendUrl) {
    const error = new Error("FRONTEND_URL is not configured for email verification.");
    error.code = "EMAIL_CONFIGURATION_ERROR";
    throw error;
  }

  const firebaseLink = await auth.generateEmailVerificationLink(email, {
    url: `${frontendUrl}/verify-email`,
  });
  const generated = new URL(firebaseLink);
  const oobCode = generated.searchParams.get("oobCode");
  if (!oobCode) throw new Error("Firebase did not generate a verification code.");

  const verificationUrl = new URL("/verify-email", frontendUrl);
  verificationUrl.searchParams.set("mode", "verifyEmail");
  verificationUrl.searchParams.set("oobCode", oobCode);
  return verificationUrl.toString();
}

async function sendVerificationEmail({ email, displayName }, env = process.env) {
  if (!getMailConfiguration(env).configured) {
    return { sent: false, reason: "EMAIL_PROVIDER_NOT_CONFIGURED" };
  }
  const verificationUrl = await createVerificationUrl(email, env);
  return deliverEmail({ to: email, ...verificationEmail({ displayName, verificationUrl }) }, env);
}

async function sendWelcomeEmail({ email, displayName }, env = process.env) {
  return deliverEmail({ to: email, ...welcomeEmail({ displayName }) }, env);
}

async function sendRegistrationEmails(user, env = process.env) {
  const result = {
    verification: { sent: false, reason: "NOT_ATTEMPTED" },
    welcome: { sent: false, reason: "NOT_ATTEMPTED" },
  };

  if (!getMailConfiguration(env).configured) {
    result.verification = { sent: false, reason: "EMAIL_PROVIDER_NOT_CONFIGURED" };
    result.welcome = { sent: false, reason: "EMAIL_PROVIDER_NOT_CONFIGURED" };
    return result;
  }

  try {
    result.verification = await sendVerificationEmail(user, env);
  } catch (error) {
    console.error("Verification email delivery failed:", error.code || error.message);
    result.verification = { sent: false, reason: error.code || "EMAIL_DELIVERY_FAILED" };
  }

  try {
    result.welcome = await sendWelcomeEmail(user, env);
  } catch (error) {
    console.error("Welcome email delivery failed:", error.code || error.message);
    result.welcome = { sent: false, reason: error.code || "EMAIL_DELIVERY_FAILED" };
  }

  return result;
}

module.exports = {
  createVerificationUrl,
  deliverEmail,
  getFrontendUrl,
  getMailConfiguration,
  sendRegistrationEmails,
  sendVerificationEmail,
  verificationEmail,
  welcomeEmail,
};
