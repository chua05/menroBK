const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const { extractImageMetadata, generateImageHash, isClearlyScreenshot,
  validateImageBuffer } = require("../../src/utils/imageVerification.util");

const outputRoot = path.join(__dirname, "fixtures");

function rationalCoordinate(value) {
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutesValue = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesValue);
  const seconds = Math.round((minutesValue - minutes) * 600000);
  return `${degrees}/1 ${minutes}/1 ${seconds}/10000`;
}

async function jpeg({ color, latitude, longitude, software = "MENRO Synthetic Camera",
  capturedAt = "2026:10:01 08:30:00" } = {}) {
  const image = sharp({ create: { width: 640, height: 480, channels: 3, background: color } }).jpeg({ quality: 90 });
  const exif = { IFD0: { Make: "MENRO Test Device", Model: "Synthetic Camera", Software: software },
    IFD2: { DateTimeOriginal: capturedAt, DateTimeDigitized: capturedAt } };
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    exif.IFD3 = { GPSLatitudeRef: latitude >= 0 ? "N" : "S", GPSLatitude: rationalCoordinate(latitude),
      GPSLongitudeRef: longitude >= 0 ? "E" : "W", GPSLongitude: rationalCoordinate(longitude) };
  }
  return image.withMetadata({ exif }).toBuffer();
}

async function generate() {
  await fs.mkdir(outputRoot, { recursive: true });
  const original = await jpeg({ color: "#168a45", latitude: 12.671, longitude: 123.875 });
  const fixtures = {
    "valid-original.jpg": original,
    "valid-replacement.jpg": await jpeg({ color: "#227744", latitude: 12.6711, longitude: 123.8751,
      capturedAt: "2026:10:02 09:15:00" }),
    "valid-third.jpg": await jpeg({ color: "#336655", latitude: 12.6709, longitude: 123.8749,
      capturedAt: "2026:10:03 10:00:00" }),
    "valid-fourth.jpg": await jpeg({ color: "#445544", latitude: 12.6712, longitude: 123.8752,
      capturedAt: "2026:10:04 11:00:00" }),
    "valid-official-current.jpg": await jpeg({ color: "#285f48", latitude: 12.671, longitude: 123.875,
      capturedAt: "2026:10:15 09:00:00" }),
    "early-a.jpg": await jpeg({ color: "#176b3b", latitude: 12.671, longitude: 123.875,
      capturedAt: "2026:10:01 13:00:00" }),
    "early-b-initial.jpg": await jpeg({ color: "#8a6428", latitude: 12.69, longitude: 123.895,
      capturedAt: "2026:10:01 14:00:00" }),
    "early-b-replacement.jpg": await jpeg({ color: "#217047", latitude: 12.6711, longitude: 123.8751,
      capturedAt: "2026:10:02 14:00:00" }),
    "outside-site.jpg": await jpeg({ color: "#aa7722", latitude: 12.69, longitude: 123.895 }),
    "missing-gps.jpg": await jpeg({ color: "#777777" }),
    "screenshot-like.jpg": await jpeg({ color: "#333399", software: "Windows Snipping Tool" }),
    "duplicate-original.jpg": original,
  };
  for (const [name, buffer] of Object.entries(fixtures)) await fs.writeFile(path.join(outputRoot, name), buffer);

  const valid = await extractImageMetadata(original);
  if (!Number.isFinite(valid.latitude) || !Number.isFinite(valid.longitude)) {
    throw new Error("Generated valid fixture does not contain readable EXIF GPS metadata.");
  }
  await validateImageBuffer(original);
  const missing = await extractImageMetadata(fixtures["missing-gps.jpg"]);
  if (missing.latitude !== null || missing.longitude !== null) throw new Error("Missing-GPS fixture unexpectedly contains GPS.");
  const screenshotMetadata = await extractImageMetadata(fixtures["screenshot-like.jpg"]);
  if (!isClearlyScreenshot({ fileName: "screenshot-like.jpg", metadata: screenshotMetadata })) {
    throw new Error("Screenshot fixture is not detected by the existing algorithm.");
  }
  if (generateImageHash(original) !== generateImageHash(fixtures["duplicate-original.jpg"])) {
    throw new Error("Duplicate evidence fixture hash does not match its source.");
  }
  console.log(`Synthetic evidence fixtures generated in ${outputRoot}.`);
  console.log(`Valid GPS: ${valid.latitude}, ${valid.longitude}`);
}

generate().catch((error) => { console.error(error.message); process.exitCode = 1; });
