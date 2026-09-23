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

        software:
          metadata?.Software ??
          "",

        orientation:
          metadata?.Orientation ??
          null,

      };

    }

    catch {

      return {

        latitude: null,

        longitude: null,

        capturedAt: null,

        deviceMake: "",

        deviceModel: "",

        software: "",

        orientation: null,

      };

    }

};

const isClearlyScreenshot = ({ fileName, metadata }) => {
  const name = String(fileName || "").toLowerCase();
  const software = String(metadata?.software || "").toLowerCase();
  const strongSoftwareSignal = /(screenshot|snipping tool|screen capture|greenshot|lightshot|sharex)/.test(software);
  const weakFilenameSignal = /(screenshot|screen[_ -]?shot|snip)/.test(name);
  const lacksCameraProvenance = !metadata?.deviceMake && !metadata?.deviceModel;
  const lacksGps = metadata?.latitude === null || metadata?.longitude === null ||
    !Number.isFinite(Number(metadata?.latitude)) ||
    !Number.isFinite(Number(metadata?.longitude));
  return strongSoftwareSignal ||
    (weakFilenameSignal && lacksCameraProvenance && lacksGps);
};

module.exports = {

  generateImageHash,

  validateImageBuffer,

  extractImageMetadata,

  isClearlyScreenshot,

};
