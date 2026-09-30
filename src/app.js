const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { createCorsOptions } = require("./config/cors");

// Middlewares
const { generalLimiter } = require("./middleware/rateLimiter.middleware");

// Routes
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const siteRoutes = require("./routes/site.routes");
const seedlingRequestRoutes = require("./routes/seedlingRequest.routes");
const inventoryRoutes = require("./routes/inventory.routes");
const distributionRoutes = require("./routes/distribution.routes");
const plantingReportRoutes = require("./routes/plantingReport.routes");
const eventRoutes = require("./routes/event.routes");
const monitoringRoutes = require("./routes/monitoring.routes");
const notificationRoutes = require("./routes/notification.routes");
const analyticsRoutes = require("./routes/analytics.routes");
const guestEventRoutes = require("./routes/guestEvent.routes");
const reportRoutes = require("./routes/report.routes");
const searchRoutes = require("./routes/search.routes");
const evidenceRoutes = require("./routes/evidence.routes");

const app = express();

app.use(helmet());

// ---------------------------------------------
// CORS
// ---------------------------------------------

app.use(cors(createCorsOptions()));

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true,
  })
);

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// ---------------------------------------------
// Rate limiting
// ---------------------------------------------

app.use("/api", generalLimiter);

// ---------------------------------------------
// Health check
// ---------------------------------------------

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "MENRO Backend API Running",
    version: "1.0.0",
  });
});

// ---------------------------------------------
// API routes
// ---------------------------------------------

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/sites", siteRoutes);
app.use("/api/seedling-requests", seedlingRequestRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/distributions", distributionRoutes);
app.use("/api/planting-reports", plantingReportRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/guest-events", guestEventRoutes);
app.use("/api/monitoring", monitoringRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/evidence", evidenceRoutes);

// ---------------------------------------------
// 404
// ---------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// ---------------------------------------------
// Global error handler
// ---------------------------------------------

app.use((err, req, res, next) => {
  // CORS validation error
  if (err.message?.startsWith("CORS blocked request from origin:")) {
    return res.status(403).json({
      success: false,
      message: "Origin not allowed by CORS.",
    });
  }

  console.error(err);

  // Multer / upload validation errors
  if (
    err.message ===
    "Only JPEG, PNG, and WEBP images are allowed."
  ) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      message: "Planting photo must not exceed 10 MB.",
    });
  }

  if (err.code === "LIMIT_FILE_COUNT") {
    return res.status(400).json({
      success: false,
      message:
        "A maximum of 10 planting evidence photos is allowed.",
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal Server Error",
  });
});

module.exports = app;
