const crypto = require("crypto");

const sharp = require("sharp");
const { captureTime, parsePhotoMetadata, photoContainer } = require("./photoMetadata.util");
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 12_000;

const detectSupportedImageFormat = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return null;

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )) {
    return "png";
  }

  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }

  return null;
};

// SHA-256 IMAGE HASH
const generateImageHash = (buffer) => {

  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");

};

// VALIDATE IMAGE
const validateImageBuffer = async (
  imageBuffer,
  { allowHeic = false } = {}
) => {

  try {

    // Original iPhone/Android HEIC: kept exactly as taken. Only planting evidence accepts it.
    if (allowHeic && photoContainer(imageBuffer) === "heic") {
      const heic = parsePhotoMetadata(imageBuffer);
      if (!heic.width || !heic.height || !heic.hasHevc) throw new Error("UNSUPPORTED_IMAGE_FORMAT");
      if (heic.width > MAX_IMAGE_DIMENSION || heic.height > MAX_IMAGE_DIMENSION || heic.width * heic.height > MAX_IMAGE_PIXELS) {
        throw new Error("IMAGE_DIMENSIONS_EXCEEDED");
      }
      return { width: heic.width, height: heic.height, format: "heic" };
    }

    const expectedFormat = detectSupportedImageFormat(imageBuffer);
    if (!expectedFormat) throw new Error("UNSUPPORTED_IMAGE_FORMAT");

    const metadata =
      await sharp(imageBuffer, {
        failOn: "warning",
        limitInputPixels: MAX_IMAGE_PIXELS,
        sequentialRead: true,
      })
        .metadata();

    if (
      !metadata.width ||
      !metadata.height ||
      metadata.format !== expectedFormat
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

      const photo = parsePhotoMetadata(imageBuffer), taken = captureTime(photo);

      return {

        latitude: photo.gps.latitude,

        longitude: photo.gps.longitude,

        gpsStatus: photo.gps.status,

        // The phone kept the GPS tags but blanked their values.
        gpsRemoved: photo.gps.removed === true,

        // The photo's own estimate in metres; null means unknown, never zero.
        gpsAccuracyMeters: photo.gps.accuracyMeters,

        gpsTimestampUtc: photo.gps.timestampUtc,

        metadataStatus: photo.metadataStatus,

        capturedAt: taken.capturedAt,

        captureTimeStatus: taken.status,

        captureTimeZone: taken.zone,

        captureTimeContradictory: taken.contradictory === true,

        captureOffset: photo.offset,

        deviceMake: photo.make,

        deviceModel: photo.model,

        software: photo.software,

        orientation: photo.orientation,

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

        captureOffset: "",

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

// What exactly is wrong with an uploaded photo's location metadata; null when it has usable coordinates.
function gpsMetadataProblem(metadata) {
  if (metadata.gpsStatus === "valid" || metadata.gpsStatus === "browser-session") return null;
  if (metadata.metadataStatus === "malformed" || metadata.metadataReadError) return { code: "PHOTO_METADATA_UNREADABLE", message: "The photo metadata could not be read. Please upload the original geotagged photo." };
  if (metadata.gpsStatus === "unparseable") return { code: "PHOTO_GPS_UNREADABLE", message: "GPS metadata was found but could not be read from this photo. Please upload the original geotagged photo." };
  if (metadata.gpsStatus === "invalid") return { code: "PHOTO_GPS_INVALID", message: "This photo contains invalid GPS coordinates. Please upload an original geotagged photo with valid location information." };
  return metadata.gpsRemoved
    ? { code: "PHOTO_GPS_REMOVED", message: "This photo does not contain GPS coordinates. The phone removed them when the photo was shared or selected. Please upload the original file." }
    : { code: "PHOTO_GPS_MISSING", message: "This photo does not contain GPS coordinates. Please upload the original geotagged photo and try again." };
}

module.exports = {

  gpsMetadataProblem,


  generateImageHash,

  validateImageBuffer,

  extractImageMetadata,

  isClearlyScreenshot,

};
