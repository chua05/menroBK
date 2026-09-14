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

module.exports = {
  uploadPlantingPhoto,
};