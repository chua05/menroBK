function rationalToNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (Array.isArray(value) && value.length === 2) {
    const numerator = Number(value[0]);
    const denominator = Number(value[1]);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
      ? numerator / denominator : NaN;
  }
  if (value && typeof value === "object") {
    const numerator = Number(value.numerator ?? value.num);
    const denominator = Number(value.denominator ?? value.den);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) return numerator / denominator;
  }
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?\s*\/\s*-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const [numerator, denominator] = value.split("/").map(Number);
    return denominator !== 0 ? numerator / denominator : NaN;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function dmsParts(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const values = Array.from(value);
    // Some EXIF readers expose a single rational decimal coordinate as
    // [numerator, denominator]. Do not mistake that scalar for incomplete DMS.
    if (values.length === 2 && values.every((part) =>
      typeof part === "number" || (typeof part === "string" && !part.includes("/")))) return null;
    return values;
  }
  if (value && typeof value === "object" && (value.degrees !== undefined || value.degree !== undefined)) {
    return [value.degrees ?? value.degree, value.minutes ?? value.minute ?? 0, value.seconds ?? value.second ?? 0];
  }
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/[NSEW]\s*$/i, "");
    const tokens = cleaned.match(/-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+(?:\.\d+)?)?/g);
    if (tokens?.length >= 3) return tokens.slice(0, 3);
  }
  return null;
}

function normalizeDirection(reference) {
  let value = reference;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const bytes = Array.from(value);
    value = bytes.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
      ? String.fromCharCode(...bytes)
      : bytes.join("");
  } else if (typeof value === "number" && [69, 78, 83, 87].includes(value)) {
    value = String.fromCharCode(value);
  }
  const normalized = String(value || "").replaceAll("\0", "").trim().toUpperCase();
  if (["N", "NORTH", "NORTH LATITUDE"].includes(normalized)) return "N";
  if (["S", "SOUTH", "SOUTH LATITUDE"].includes(normalized)) return "S";
  if (["E", "EAST", "EAST LONGITUDE"].includes(normalized)) return "E";
  if (["W", "WEST", "WEST LONGITUDE"].includes(normalized)) return "W";
  return normalized;
}

function parseExifCoordinate(value, reference, maximum) {
  const parts = dmsParts(value);
  let coordinate;
  if (parts) {
    if (parts.length < 3) return { status: "unparseable", value: null };
    const [degrees, minutes, seconds] = parts.slice(0, 3).map(rationalToNumber);
    if (![degrees, minutes, seconds].every(Number.isFinite) || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) {
      return { status: "unparseable", value: null };
    }
    coordinate = Math.abs(degrees) + minutes / 60 + seconds / 3600;
    if (degrees < 0) coordinate *= -1;
  } else coordinate = rationalToNumber(value);
  if (!Number.isFinite(coordinate)) return { status: "unparseable", value: null };
  const direction = normalizeDirection(reference);
  if (["S", "W"].includes(direction)) coordinate = -Math.abs(coordinate);
  if (["N", "E"].includes(direction)) coordinate = Math.abs(coordinate);
  if (coordinate < -maximum || coordinate > maximum) return { status: "invalid", value: coordinate };
  return { status: "valid", value: coordinate };
}

function coordinateFromCandidates(candidates, reference, maximum) {
  let present = false;
  for (const candidate of candidates) {
    if (candidate == null) continue;
    present = true;
    const parsed = parseExifCoordinate(candidate, reference, maximum);
    if (parsed.status === "valid" || parsed.status === "invalid") return parsed;
  }
  return { status: present ? "unparseable" : "missing", value: null };
}

function extractGpsCoordinates(metadata = {}) {
  const gps = metadata.gps || metadata.GPS || metadata.GPSInfo || {};
  const latitude = coordinateFromCandidates(
    [metadata.latitude, metadata.GPSLatitude, gps.latitude, gps.GPSLatitude],
    metadata.GPSLatitudeRef ?? gps.GPSLatitudeRef, 90);
  const longitude = coordinateFromCandidates(
    [metadata.longitude, metadata.GPSLongitude, gps.longitude, gps.GPSLongitude],
    metadata.GPSLongitudeRef ?? gps.GPSLongitudeRef, 180);
  if (latitude.status === "missing" && longitude.status === "missing") {
    return { status: "missing", latitude: null, longitude: null };
  }
  if (latitude.status === "missing" || longitude.status === "missing") {
    return { status: "unparseable", latitude: null, longitude: null };
  }
  if (latitude.status === "invalid" || longitude.status === "invalid") return { status: "invalid", latitude: latitude.value, longitude: longitude.value };
  if (latitude.status !== "valid" || longitude.status !== "valid") return { status: "unparseable", latitude: null, longitude: null };
  return { status: "valid", latitude: latitude.value, longitude: longitude.value };
}

module.exports = { rationalToNumber, parseExifCoordinate, extractGpsCoordinates };
