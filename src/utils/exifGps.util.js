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
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value);
  if (value && typeof value === "object" && (value.degrees !== undefined || value.degree !== undefined)) {
    return [value.degrees ?? value.degree, value.minutes ?? value.minute ?? 0, value.seconds ?? value.second ?? 0];
  }
  if (typeof value === "string" && value.includes(",")) return value.split(",");
  return null;
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
  const direction = String(reference || "").trim().toUpperCase();
  if (["S", "W"].includes(direction)) coordinate = -Math.abs(coordinate);
  if (["N", "E"].includes(direction)) coordinate = Math.abs(coordinate);
  if (coordinate < -maximum || coordinate > maximum) return { status: "invalid", value: coordinate };
  return { status: "valid", value: coordinate };
}

function extractGpsCoordinates(metadata = {}) {
  const rawLatitude = metadata.latitude ?? metadata.GPSLatitude;
  const rawLongitude = metadata.longitude ?? metadata.GPSLongitude;
  if (rawLatitude == null && rawLongitude == null) return { status: "missing", latitude: null, longitude: null };
  if (rawLatitude == null || rawLongitude == null) return { status: "unparseable", latitude: null, longitude: null };
  const latitude = parseExifCoordinate(rawLatitude, metadata.GPSLatitudeRef, 90);
  const longitude = parseExifCoordinate(rawLongitude, metadata.GPSLongitudeRef, 180);
  if (latitude.status === "invalid" || longitude.status === "invalid") return { status: "invalid", latitude: latitude.value, longitude: longitude.value };
  if (latitude.status !== "valid" || longitude.status !== "valid") return { status: "unparseable", latitude: null, longitude: null };
  return { status: "valid", latitude: latitude.value, longitude: longitude.value };
}

module.exports = { rationalToNumber, parseExifCoordinate, extractGpsCoordinates };
