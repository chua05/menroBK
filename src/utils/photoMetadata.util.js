// Reads the original metadata of one photo from its untouched bytes (JPEG, HEIC/HEIF, PNG, WebP). Nothing is converted, guessed
// or taken from the file name or the device. The frontend uses the same logic (src/utils/photoMetadata.js); this copy decides.
const { extractGpsCoordinates } = require("./exifGps.util");

const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
const MAX_BOXES = 4096;
const MANILA_OFFSET_MINUTES = 8 * 60;
const CONTRADICTION_MS = 24 * 60 * 60 * 1000;

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const text = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, Math.min(start + length, bytes.length)));
const malformed = () => new Error("MALFORMED_METADATA");

// --- Containers -------------------------------------------------------------------------------------------------------------
function ftypBrands(bytes) {
  if (bytes.length < 16 || text(bytes, 4, 4) !== "ftyp") return null;
  const size = viewOf(bytes).getUint32(0);
  if (size < 16 || size > bytes.length || size > 1024) return null;
  const brands = [text(bytes, 8, 4)];
  for (let at = 16; at + 4 <= size; at += 4) brands.push(text(bytes, at, 4));
  return brands;
}
function photoContainer(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && text(bytes, 1, 3) === "PNG") return "png";
  if (bytes.length >= 12 && text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 4) === "WEBP") return "webp";
  const brands = ftypBrands(bytes);
  // "mif1" alone is generic HEIF; AVIF also lists it and is not supported.
  if (brands && !brands.includes("avif") && !brands.includes("avis") && brands.some((brand) => HEIC_BRANDS.has(brand))) return "heic";
  return null;
}

function jpegBlocks(bytes) {
  const blocks = { tiffs: [], xmp: "" }, view = viewOf(bytes);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = view.getUint16(at + 2), start = at + 4, end = at + 2 + length;
    if (length < 2 || end > bytes.length) break;
    if (marker === 0xe1 && text(bytes, start, 6) === "Exif\0\0") blocks.tiffs.push(bytes.subarray(start + 6, end));
    else if (marker === 0xe1 && text(bytes, start, 29) === "http://ns.adobe.com/xap/1.0/\0") blocks.xmp += text(bytes, start + 29, end - start - 29);
    at = end;
  }
  return blocks;
}
function pngBlocks(bytes) {
  const blocks = { tiffs: [], xmp: "" }, view = viewOf(bytes);
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = view.getUint32(at), type = text(bytes, at + 4, 4);
    if (at + 12 + length > bytes.length) break;
    if (type === "eXIf") blocks.tiffs.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  return blocks;
}
function webpBlocks(bytes) {
  const blocks = { tiffs: [], xmp: "" }, view = viewOf(bytes);
  for (let at = 12; at + 8 <= bytes.length;) {
    const type = text(bytes, at, 4), length = view.getUint32(at + 4, true), start = at + 8, end = start + length;
    if (end > bytes.length) break;
    if (type === "EXIF") blocks.tiffs.push(bytes.subarray(text(bytes, start, 6) === "Exif\0\0" ? start + 6 : start, end));
    else if (type === "XMP ") blocks.xmp += text(bytes, start, length);
    at = end + (length % 2);
  }
  return blocks;
}

function* boxes(bytes, start, end) {
  const view = viewOf(bytes);
  let count = 0;
  for (let at = start; at + 8 <= end;) {
    if ((count += 1) > MAX_BOXES) throw malformed();
    let size = view.getUint32(at), header = 8;
    if (size === 1) {
      if (at + 16 > end || view.getUint32(at + 8) !== 0) throw malformed();
      size = view.getUint32(at + 12); header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw malformed();
    yield { type: text(bytes, at + 4, 4), start: at + header, end: at + size };
    at += size;
  }
}
const sized = (view, at, size) => {
  if (size === 0) return 0;
  if (size === 4) return view.getUint32(at);
  if (size === 8) { if (view.getUint32(at) !== 0) throw malformed(); return view.getUint32(at + 4); }
  throw malformed();
};
function heicBlocks(bytes) {
  const blocks = { tiffs: [], xmp: "", width: 0, height: 0, hasHevc: false }, view = viewOf(bytes);
  let meta = null;
  for (const box of boxes(bytes, 0, bytes.length)) if (box.type === "meta") { meta = box; break; }
  if (!meta) throw malformed();
  const items = new Map(), locations = new Map();
  let idat = null;
  for (const box of boxes(bytes, meta.start + 4, meta.end)) {
    if (box.type === "idat") idat = box;
    else if (box.type === "iinf") {
      const start = box.start + (bytes[box.start] === 0 ? 6 : 8);
      for (const entry of boxes(bytes, start, box.end)) {
        if (entry.type !== "infe" || bytes[entry.start] < 2) continue;
        const wide = bytes[entry.start] >= 3, id = wide ? view.getUint32(entry.start + 4) : view.getUint16(entry.start + 4);
        items.set(id, text(bytes, entry.start + (wide ? 10 : 8), 4));
      }
    } else if (box.type === "iloc") {
      const version = bytes[box.start];
      if (version > 2) throw malformed();
      const offsetSize = bytes[box.start + 4] >> 4, lengthSize = bytes[box.start + 4] & 15;
      const baseSize = bytes[box.start + 5] >> 4, indexSize = version ? bytes[box.start + 5] & 15 : 0;
      let at = box.start + 6;
      const count = version < 2 ? view.getUint16(at) : view.getUint32(at);
      at += version < 2 ? 2 : 4;
      if (count > MAX_BOXES) throw malformed();
      let extentTotal = 0;
      for (let index = 0; index < count; index += 1) {
        if (at + 6 > box.end) throw malformed();
        const id = version < 2 ? view.getUint16(at) : view.getUint32(at);
        at += version < 2 ? 2 : 4;
        const method = version ? view.getUint16(at) & 15 : 0;
        at += version ? 2 : 0;
        at += 2; // data reference index: always this file
        const base = sized(view, at, baseSize); at += baseSize;
        const extents = view.getUint16(at); at += 2;
        // Every extent takes bytes, and the whole table is bounded, so a crafted header cannot loop for long.
        if ((extentTotal += extents) > MAX_BOXES || (extents && indexSize + offsetSize + lengthSize === 0)) throw malformed();
        const parts = [];
        for (let part = 0; part < extents; part += 1) {
          at += indexSize;
          const offset = sized(view, at, offsetSize); at += offsetSize;
          const length = sized(view, at, lengthSize); at += lengthSize;
          if (at > box.end) throw malformed();
          parts.push({ offset: base + offset, length });
        }
        locations.set(id, { method, parts });
      }
    } else if (box.type === "iprp") {
      for (const child of boxes(bytes, box.start, box.end)) {
        if (child.type !== "ipco") continue;
        for (const property of boxes(bytes, child.start, child.end)) {
          if (property.type === "hvcC") blocks.hasHevc = true;
          if (property.type === "ispe" && property.end - property.start >= 12) {
            const width = view.getUint32(property.start + 4), height = view.getUint32(property.start + 8);
            if (width * height > blocks.width * blocks.height) { blocks.width = width; blocks.height = height; }
          }
        }
      }
    }
  }
  for (const [id, type] of items) {
    if (type !== "Exif") continue;
    const location = locations.get(id);
    if (!location || location.method > 1 || (location.method === 1 && !idat)) throw malformed();
    const origin = location.method === 1 ? idat.start : 0;
    const total = location.parts.reduce((sum, part) => sum + part.length, 0);
    if (!total || total > 4 * 1024 * 1024) throw malformed();
    const data = new Uint8Array(total);
    let at = 0;
    for (const part of location.parts) {
      const from = origin + part.offset;
      if (from + part.length > bytes.length) throw malformed();
      data.set(bytes.subarray(from, from + part.length), at); at += part.length;
    }
    if (total < 12) throw malformed();
    const skip = 4 + viewOf(data).getUint32(0);
    if (skip + 8 > total) throw malformed();
    blocks.tiffs.push(data.subarray(skip));
  }
  return blocks;
}

// --- TIFF -------------------------------------------------------------------------------------------------------------------
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
function tiffReader(tiff) {
  const view = viewOf(tiff), order = text(tiff, 0, 2), little = order === "II";
  if ((!little && order !== "MM") || tiff.length < 8 || view.getUint16(2, little) !== 42) throw malformed();
  const value = (type, at) => {
    if (type === 1 || type === 7) return tiff[at];
    if (type === 3) return view.getUint16(at, little);
    if (type === 4) return view.getUint32(at, little);
    if (type === 9) return view.getInt32(at, little);
    const signed = type === 10, read = signed ? "getInt32" : "getUint32";
    return [view[read](at, little), view[read](at + 4, little)];
  };
  const directory = (offset) => {
    const tags = new Map();
    if (!offset || offset + 2 > tiff.length) throw malformed();
    const count = view.getUint16(offset, little);
    if (count > 1024) throw malformed();
    for (let index = 0; index < count; index += 1) {
      const at = offset + 2 + index * 12;
      if (at + 12 > tiff.length) break;
      const tag = view.getUint16(at, little), type = view.getUint16(at + 2, little), amount = view.getUint32(at + 4, little), size = TYPE_SIZE[type];
      // Text may be long; numbers are a few values per tag.
      if (!size || amount > (type === 2 ? 65536 : 1024)) continue;
      const length = size * amount, from = length <= 4 ? at + 8 : view.getUint32(at + 8, little);
      if (from + length > tiff.length) { tags.set(tag, { unreadable: true }); continue; }
      tags.set(tag, type === 2 ? text(tiff, from, amount).split("\0")[0].trim()
        : Array.from({ length: amount }, (_, part) => value(type, from + part * size)));
    }
    return tags;
  };
  return { first: view.getUint32(4, little), directory };
}
const string = (tags, tag) => (typeof tags?.get(tag) === "string" ? tags.get(tag) : "");
const numbers = (tags, tag) => (Array.isArray(tags?.get(tag)) ? tags.get(tag) : null);
const ratio = (part) => (Array.isArray(part) ? (part[1] ? part[0] / part[1] : NaN) : part);

function gpsFrom(tags) {
  const result = { status: "missing", latitude: null, longitude: null, accuracyMeters: null, timestampUtc: null };
  const latitude = tags.get(2), longitude = tags.get(4);
  if (latitude === undefined && longitude === undefined) return result;
  if (!Array.isArray(latitude) || !Array.isArray(longitude)) return { ...result, status: "unparseable" };
  const lat = latitude.map(ratio), lng = longitude.map(ratio);
  // Phones that withhold the location leave the tags but blank their values (0/0, or exactly 0, 0).
  const blank = [...latitude, ...longitude].every((part) => Array.isArray(part) && part[0] === 0 && part[1] === 0);
  if (blank || [...lat, ...lng].every((part) => part === 0)) return { ...result, removed: true };
  const position = extractGpsCoordinates({ GPSLatitude: lat, GPSLatitudeRef: string(tags, 1), GPSLongitude: lng, GPSLongitudeRef: string(tags, 3) });
  const accuracy = ratio(numbers(tags, 31)?.[0]), day = /^(\d{4}):(\d{2}):(\d{2})$/.exec(string(tags, 29)), time = numbers(tags, 7)?.map(ratio);
  const instant = day && time?.length === 3 && time.every(Number.isFinite)
    ? Date.UTC(+day[1], day[2] - 1, +day[3], time[0], time[1], Math.floor(time[2])) : NaN;
  return { ...result, ...position, accuracyMeters: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : null,
    timestampUtc: Number.isFinite(instant) ? new Date(instant).toISOString() : null };
}
function xmpGps(xmp) {
  const read = (name) => new RegExp(`exif:${name}(?:="|>)\\s*(\\d{1,3}),(\\d{1,2}(?:\\.\\d+)?)(?:,(\\d{1,2}(?:\\.\\d+)?))?([NSEW])`).exec(xmp);
  const lat = read("GPSLatitude"), lng = read("GPSLongitude");
  if (!lat || !lng) return null;
  const whole = (match) => [Number(match[1]), Math.floor(Number(match[2])), (Number(match[2]) % 1) * 60 + Number(match[3] || 0)];
  return { status: "missing", accuracyMeters: null, timestampUtc: null,
    ...extractGpsCoordinates({ GPSLatitude: whole(lat), GPSLatitudeRef: lat[4], GPSLongitude: whole(lng), GPSLongitudeRef: lng[4] }) };
}

function parsePhotoMetadata(input) {
  const bytes = new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength ?? input.length);
  const container = photoContainer(bytes);
  const result = { container, width: 0, height: 0, metadataStatus: "none", make: "", model: "", software: "", orientation: null,
    dateTimeOriginal: "", offset: "", gps: { status: "missing", latitude: null, longitude: null, accuracyMeters: null, timestampUtc: null } };
  if (!container) return { ...result, metadataStatus: "unsupported" };
  let blocks;
  try { blocks = { jpeg: jpegBlocks, png: pngBlocks, webp: webpBlocks, heic: heicBlocks }[container](bytes); }
  catch { return { ...result, metadataStatus: "malformed", gps: { ...result.gps, status: "unparseable" } }; }
  Object.assign(result, { width: blocks.width || 0, height: blocks.height || 0, ...(container === "heic" ? { hasHevc: blocks.hasHevc } : {}) });
  let failed = false;
  for (const tiff of blocks.tiffs) {
    try {
      const reader = tiffReader(tiff), main = reader.directory(reader.first);
      const exifAt = numbers(main, 0x8769)?.[0], gpsAt = numbers(main, 0x8825)?.[0];
      let exif = null;
      try { if (exifAt) exif = reader.directory(exifAt); } catch { failed = true; }
      let gps = null;
      try { if (gpsAt) gps = gpsFrom(reader.directory(gpsAt)); } catch { gps = { ...result.gps, status: "unparseable" }; }
      if (result.metadataStatus !== "ok") {
        Object.assign(result, { metadataStatus: "ok", make: string(main, 0x010f), model: string(main, 0x0110), software: string(main, 0x0131),
          orientation: numbers(main, 0x0112)?.[0] ?? null,
          dateTimeOriginal: string(exif, 0x9003) || string(exif, 0x9004),
          offset: string(exif, 0x9011) || string(exif, 0x9012) || string(exif, 0x9010) });
      }
      if (gps && result.gps.status !== "valid" && (gps.status !== "missing" || gps.removed)) result.gps = gps;
    } catch { failed = true; }
  }
  if (result.metadataStatus === "none" && failed) {
    result.metadataStatus = "malformed";
    result.gps = { ...result.gps, status: "unparseable" };
  }
  if (result.gps.status === "missing" && !result.gps.removed && blocks.xmp) result.gps = xmpGps(blocks.xmp) || result.gps;
  return result;
}

// Capture time: the photo's own offset when it has one; a time without a zone is Philippine time (the approved fallback). GPS time
// is UTC, is never used as the capture time, and only shows a contradiction of more than a day.
function captureTime(metadata) {
  const raw = String(metadata?.dateTimeOriginal || "").trim();
  if (!raw || /^[\s:0]+$/.test(raw)) return { status: "missing", capturedAt: null, zone: "" };
  const parts = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  const values = parts?.slice(1).map(Number);
  const local = values ? Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5]) : NaN;
  const check = new Date(local);
  if (!values || values[0] < 1990 || [check.getUTCFullYear(), check.getUTCMonth() + 1, check.getUTCDate(), check.getUTCHours(), check.getUTCMinutes(), check.getUTCSeconds()]
    .some((part, index) => part !== values[index])) return { status: "invalid", capturedAt: null, zone: "" };
  const zone = /^([+-])(\d{2}):?(\d{2})$/.exec(String(metadata.offset || "").trim());
  const minutes = zone && Number(zone[2]) <= 14 && Number(zone[3]) < 60 ? (Number(zone[2]) * 60 + Number(zone[3])) * (zone[1] === "-" ? -1 : 1) : null;
  const capturedAt = new Date(local - (minutes ?? MANILA_OFFSET_MINUTES) * 60000);
  const gpsTime = Date.parse(metadata?.gps?.timestampUtc || "");
  return { status: "valid", capturedAt, zone: minutes === null ? "Asia/Manila" : "photo-offset",
    contradictory: Number.isFinite(gpsTime) && Math.abs(gpsTime - capturedAt.getTime()) > CONTRADICTION_MS };
}
// The planting date is a Philippine calendar day, whatever the server's or device's own time zone.
const manilaDayStart = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? new Date(`${date}T00:00:00+08:00`) : new Date(NaN));

module.exports = { captureTime, manilaDayStart, parsePhotoMetadata, photoContainer };
