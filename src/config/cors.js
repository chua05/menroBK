const normalizeOrigin = (value) => {
  const candidate = String(value || "").trim();
  if (!candidate) return "";

  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
};

const splitOrigins = (value) =>
  String(value || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

// The stable MENRO frontend remains available if Render's environment is
// temporarily incomplete. Additional origins must be explicit environment
// values; arbitrary Vercel deployments are never trusted.
const DEFAULT_PRODUCTION_ORIGINS = [
  "https://menro-xxtt-five.vercel.app",
];

const getConfiguredOrigins = (env = process.env) =>
  new Set([
    ...DEFAULT_PRODUCTION_ORIGINS,
    ...splitOrigins(env.FRONTEND_URL),
    ...splitOrigins(env.ALLOWED_ORIGINS),
  ]);

const isDevelopmentLoopbackOrigin = (origin, env = process.env) => {
  if (env.NODE_ENV === "production") return false;

  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

const isAuthorizedVercelPreviewOrigin = (origin, env = process.env) => {
  if (String(env.ALLOW_VERCEL_PREVIEWS || "").trim().toLowerCase() !== "true") {
    return false;
  }

  const project = String(env.VERCEL_FRONTEND_PROJECT || "")
    .trim()
    .toLowerCase();
  const team = String(env.VERCEL_FRONTEND_TEAM || "")
    .trim()
    .toLowerCase();

  if (
    !/^[a-z0-9-]+$/.test(project) ||
    !/^[a-z0-9-]+$/.test(team)
  ) {
    return false;
  }

  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.port || url.pathname !== "/") {
      return false;
    }

    const hostname = url.hostname.toLowerCase();
    const prefix = `${project}-`;
    const suffix = `-${team}.vercel.app`;
    const deploymentName = hostname.slice(
      prefix.length,
      hostname.length - suffix.length
    );

    return (
      hostname.startsWith(prefix) &&
      hostname.endsWith(suffix) &&
      /^[a-z0-9-]+$/.test(deploymentName)
    );
  } catch {
    return false;
  }
};

const isOriginAllowed = (origin, env = process.env) => {
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);
  return (
    getConfiguredOrigins(env).has(normalized) ||
    isDevelopmentLoopbackOrigin(normalized, env) ||
    isAuthorizedVercelPreviewOrigin(normalized, env)
  );
};

const createCorsOptions = (env = process.env) => ({
  origin(origin, callback) {
    if (isOriginAllowed(origin, env)) {
      return callback(null, true);
    }

    return callback(
      new Error(`CORS blocked request from origin: ${origin}`)
    );
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  optionsSuccessStatus: 204,
});

module.exports = {
  createCorsOptions,
  getConfiguredOrigins,
  isAuthorizedVercelPreviewOrigin,
  isDevelopmentLoopbackOrigin,
  isOriginAllowed,
  normalizeOrigin,
};
