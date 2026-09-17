const multer = require("multer");
const path = require("path");

const storage = multer.memoryStorage();

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

  // Some clients such as Postman may
  // send valid image files using
  // application/octet-stream.
  //
  // We only allow it here when the
  // filename has an accepted image
  // extension.
  //
  // The actual image buffer is still
  // validated later by
  // validateImageBuffer().
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
    // Maximum size PER photo.
    fileSize:
      10 * 1024 * 1024,
  },
  fileFilter:
    imageFileFilter,
});

const uploadContributionEvidence = (req, res, next) =>
  uploadPlantingPhoto.array("photos", 10)(req, res, (error) => {
    if (!error) return next();
    return res.status(400).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Each planting evidence photo must not exceed 10 MB."
        : error.code === "LIMIT_UNEXPECTED_FILE"
          ? "A maximum of 10 planting evidence photos is allowed."
          : error.message || "Invalid planting evidence photos.",
    });
  });

module.exports = {
  uploadPlantingPhoto,
  uploadContributionEvidence,
};
