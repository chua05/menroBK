const rateLimit = require("express-rate-limit");

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
  message: {
    success: false,
    message: "Too many requests. Please slow down.",
  },
});

module.exports = { 
    authLimiter, 
    generalLimiter };
