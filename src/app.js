const express = require("express");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

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

const app = express();

app.use(helmet());

// ---------------------------------------------
// CORS
// ---------------------------------------------

const allowedOrigins = [
  "http://localhost:5173",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests without an Origin header,
      // such as Postman/server-to-server requests.
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error(`CORS blocked request from origin: ${origin}`)
      );
    },
    credentials: true,
  })
);

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true,
  })
);

// ---------------------------------------------
// Local uploaded files
// ---------------------------------------------

app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "uploads"))
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
app.use("/api/monitoring", monitoringRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/analytics", analyticsRoutes);

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
  console.error(err);

  // CORS validation error
  if (err.message?.startsWith("CORS blocked request from origin:")) {
    return res.status(403).json({
      success: false,
      message: "Origin not allowed by CORS.",
    });
  }

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
