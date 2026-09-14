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

const app = express();

app.use(helmet());

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);


app.use(express.json());

app.use(
  express.urlencoded({
    extended: true,
  })
);

app.use("/uploads",
  express.static(
    path.join(process.cwd(), "uploads")
  )
);


if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

app.use("/api", generalLimiter);


app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "MENRO Backend API Running",
    version: "1.0.0",
  });
});


app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/sites", siteRoutes);
app.use("/api/seedling-requests", seedlingRequestRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/distributions", distributionRoutes);
app.use("/api/planting-reports", plantingReportRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/monitoring",monitoringRoutes);


app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});


app.use((err, req, res, next) => {
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