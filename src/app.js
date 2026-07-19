const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

// Middlewares
const { generalLimiter } = require("./middleware/rateLimiter.middleware");

// Routes
const authRoutes = require("./routes/auth.routes");
const siteRoutes = require("./routes/site.routes");
const seedlingRequestRoutes = require("./routes/seedlingRequest.routes");
const inventoryRoutes = require("./routes/inventory.routes");
const distributionRoutes = require("./routes/distribution.routes");
const plantingReportRoutes = require("./routes/plantingReport.routes");

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
app.use("/api/sites", siteRoutes);
app.use("/api/seedling-requests", seedlingRequestRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/distributions", distributionRoutes);
app.use("/api/planting-reports", plantingReportRoutes);


app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});


app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    success: false,
    message: "Internal Server Error",
  });
});

module.exports = app;