const multer = require("multer");
const path = require("path");

const storage = multer.memoryStorage();
const MAX_AGGREGATE_BYTES = 60 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 3;
const UPLOAD_FORM_LIMITS = Object.freeze({
  fieldNameSize: 100,
  fieldSize: 1024 * 1024,
  fields: 100,
  fieldNestingDepth: 5,
  fieldArrayIndexLimit: 100,
});
let activeUploads = 0;

const uploadConcurrencyGuard = (req, res, next) => {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return res.status(503).json({
      success: false,
      message: "The upload service is busy. Please try again shortly.",
    });
  }
  activeUploads += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeUploads = Math.max(0, activeUploads - 1);
  };
  res.once("finish", release);
  res.once("close", release);
  next();
};

const validateAggregateUploadSize = (files) => {
  const list = Array.isArray(files)
    ? files
    : Object.values(files || {}).flat();
  const total = list.reduce((sum, file) => sum + Number(file?.size || file?.buffer?.length || 0), 0);
  if (total > MAX_AGGREGATE_BYTES) {
    const error = new Error("The combined evidence upload must not exceed 60 MB.");
    error.code = "LIMIT_AGGREGATE_FILE_SIZE";
    throw error;
  }
};

const imageFileFilter = (
  req,
  file,
  callback
) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
  ];

  const allowedExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
  ];

  const extension = path
    .extname(
      file.originalname || ""
    )
    .toLowerCase();

  const hasAllowedMimeType =
    allowedMimeTypes.includes(
      file.mimetype
    );

 
  const hasAllowedGenericMimeType =
    file.mimetype ===
      "application/octet-stream" &&
    allowedExtensions.includes(
      extension
    );

  if (
    !hasAllowedMimeType &&
    !hasAllowedGenericMimeType
  ) {
    return callback(
      new Error(
        "Only JPEG, PNG, and WEBP images are allowed."
      )
    );
  }

  callback(null, true);
};

const uploadPlantingPhoto = multer({
  storage,
  limits: {
    ...UPLOAD_FORM_LIMITS,
    // Maximum size PER photo.
    fileSize:
      10 * 1024 * 1024,
    files: 10,
    parts: 110,
  },
  fileFilter:
    imageFileFilter,
});

const uploadContributionEvidence = (req, res, next) =>
  uploadPlantingPhoto.array("photos", 10)(req, res, (error) => {
    if (!error) {
      try {
        validateAggregateUploadSize(req.files);
        return next();
      } catch (aggregateError) {
        error = aggregateError;
      }
    }
    return res.status(400).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Each planting evidence photo must not exceed 10 MB."
        : error.code === "LIMIT_UNEXPECTED_FILE"
          ? "A maximum of 10 planting evidence photos is allowed."
          : error.code === "LIMIT_AGGREGATE_FILE_SIZE"
            ? error.message
          : error.message || "Invalid planting evidence photos.",
    });
  });

module.exports = {
  uploadPlantingPhoto,
  uploadContributionEvidence,
  uploadConcurrencyGuard,
  validateAggregateUploadSize,
  UPLOAD_FORM_LIMITS,
};
