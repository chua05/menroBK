const multer = require("multer");

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

  if (!allowedMimeTypes.includes(file.mimetype)) {
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
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: imageFileFilter,
});

module.exports = {
  uploadPlantingPhoto,
};