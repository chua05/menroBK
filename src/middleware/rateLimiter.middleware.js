const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const actorKey = (req) => req.user?.uid
  ? `user:${req.user.uid}`
  : req.guestSession?.participantId
    ? `guest:${req.guestSession.participantId}`
    : ipKeyGenerator(req.ip);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: {
    success: false,
    message: "Too many attempts. Please try again after 15 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // A signed-in dashboard can make many read requests while navigating.
  // Keep a bounded per-IP ceiling without throttling ordinary page loads.
  max: 300,
  skip: (req) => req.method === "OPTIONS",
  message: {
    success: false,
    message: "Too many requests. Please slow down.",
  },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: actorKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many photo uploads. Please wait before trying again." },
});

const guestContributionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: actorKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many guest submissions. Please wait before trying again." },
});

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: actorKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many report requests. Please try again later." },
});

const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: actorKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many searches. Please wait before trying again." },
});

module.exports = {
  authLimiter,
  generalLimiter,
  uploadLimiter,
  guestContributionLimiter,
  reportLimiter,
  searchLimiter,
};
