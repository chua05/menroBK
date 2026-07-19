const crypto = require("crypto");

const exifr = require("exifr");

const sharp = require("sharp");

// SHA-256 IMAGE HASH
const generateImageHash = (buffer) => {

  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");

};

// VALIDATE IMAGE
const validateImageBuffer = async (
  imageBuffer
) => {

  try {

    const metadata =
      await sharp(imageBuffer)
        .metadata();

    if (
      !metadata.width ||
      !metadata.height
    ) {

      throw new Error();

    }

    return {

      width:
        metadata.width,

      height:
        metadata.height,

      format:
        metadata.format,

    };

  }

  catch {

    throw new Error(
      "The uploaded file is not a valid image."
    );

  }

};

// EXTRACT EXIF METADATA
const extractImageMetadata =
  async (
    imageBuffer
  ) => {

    try {

      const metadata =
        await exifr.parse(
          imageBuffer,
          {
            gps: true,
            tiff: true,
            exif: true,
          }
        );

      return {

        latitude:
          metadata?.latitude ??
          null,

        longitude:
          metadata?.longitude ??
          null,

        capturedAt:
          metadata?.DateTimeOriginal ??
          metadata?.CreateDate ??
          null,

        deviceMake:
          metadata?.Make ??
          "",

        deviceModel:
          metadata?.Model ??
          "",

      };

    }

    catch {

      return {

        latitude: null,

        longitude: null,

        capturedAt: null,

        deviceMake: "",

        deviceModel: "",

      };

    }

};

module.exports = {

  generateImageHash,

  validateImageBuffer,

  extractImageMetadata,

};