const crypto = require("crypto");

const exifr = require("exifr");

const sharp = require("sharp");
const { extractGpsCoordinates } = require("./exifGps.util");
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 12_000;

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
      await sharp(imageBuffer, {
        failOn: "warning",
        limitInputPixels: MAX_IMAGE_PIXELS,
        sequentialRead: true,
      })
        .metadata();

    if (
      !metadata.width ||
      !metadata.height
    ) {

      throw new Error();

    }

    if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION ||
        metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
      throw new Error("IMAGE_DIMENSIONS_EXCEEDED");
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

  catch (error) {

    if (error?.message === "IMAGE_DIMENSIONS_EXCEEDED") {
      throw new Error("The image dimensions are too large to process safely.");
    }

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

      const gps = extractGpsCoordinates(metadata || {});

      return {

        latitude: gps.latitude,

        longitude: gps.longitude,

        gpsStatus: gps.status,

        capturedAt:
          metadata?.DateTimeOriginal ??
          metadata?.DateTimeDigitized ??
          metadata?.CreateDate ??
          metadata?.DateTime ??
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

    catch (error) {

      return {

        latitude: null,

        longitude: null,

        gpsStatus: "unparseable",

        metadataReadError: true,

        metadataErrorName: String(error?.name || "MetadataParseError"),

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
