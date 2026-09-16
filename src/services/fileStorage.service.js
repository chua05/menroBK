const fs = require("fs/promises");
const path = require("path");
const {
  randomUUID,
} = require("crypto");

const UPLOAD_ROOT = path.join(
  process.cwd(),
  "uploads"
);

const PLANTING_REPORT_FOLDER =
  "planting-reports";


const getExtensionFromMimeType = (
  mimeType
) => {
  const extensionMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };

  return extensionMap[mimeType] || null;
};


const getExtensionFromFileName = (
  fileName
) => {
  const extension = path
    .extname(fileName || "")
    .toLowerCase();

  const allowedExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
  ];

  if (
    !allowedExtensions.includes(
      extension
    )
  ) {
    return null;
  }

  if (
    extension === ".jpeg"
  ) {
    return "jpg";
  }

  return extension.replace(
    ".",
    ""
  );
};


const getSafeImageExtension = (
  file
) => {
  // First prefer the normal MIME type.
  const mimeExtension =
    getExtensionFromMimeType(
      file.mimetype
    );

  if (mimeExtension) {
    return mimeExtension;
  }

  // Some clients such as Postman
  // may send a valid image as
  // application/octet-stream.
  //
  // The actual file buffer has
  // already been validated by
  // validateImageBuffer() before
  // reaching this storage service.
  if (
    file.mimetype ===
    "application/octet-stream"
  ) {
    return getExtensionFromFileName(
      file.originalname
    );
  }

  return null;
};


const savePlantingPhoto = async ({
  file,
  participantId,
}) => {
  const extension =
    getSafeImageExtension(
      file
    );

  if (!extension) {
    throw new Error(
      "Unsupported image file type."
    );
  }

  const backendURL = (process.env.BACKEND_URL ||
    (process.env.NODE_ENV === "production" ? "" : "http://localhost:5000"))
    .trim().replace(/\/$/, "");

  if (!backendURL) {
    throw new Error("BACKEND_URL is required to create upload links in production.");
  }

  const participantFolder = path.join(
    UPLOAD_ROOT,
    PLANTING_REPORT_FOLDER,
    participantId
  );

  await fs.mkdir(
    participantFolder,
    {
      recursive: true,
    }
  );

  const fileName =
    `${Date.now()}-${randomUUID()}` +
    `.${extension}`;

  const absolutePath = path.join(
    participantFolder,
    fileName
  );

  await fs.writeFile(
    absolutePath,
    file.buffer
  );

  const relativePath = [
    PLANTING_REPORT_FOLDER,
    participantId,
    fileName,
  ].join("/");

  return {
    filePath: relativePath,

    photoURL:
      `${backendURL}/uploads/` +
      relativePath,
  };
};


const deletePlantingPhoto = async (
  relativePath
) => {
  if (!relativePath) {
    return;
  }

  const normalizedPath =
    path.normalize(
      relativePath
    );

  const absolutePath = path.join(
    UPLOAD_ROOT,
    normalizedPath
  );

  try {
    await fs.unlink(
      absolutePath
    );
  } catch (error) {
    if (
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
};


module.exports = {
  savePlantingPhoto,
  deletePlantingPhoto,
};
