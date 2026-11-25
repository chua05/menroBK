const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const { captureTime, manilaDayStart, parsePhotoMetadata, photoContainer } = require("../src/utils/photoMetadata.util");
const { extractImageMetadata, gpsMetadataProblem, validateImageBuffer } = require("../src/utils/imageVerification.util");
const { validatePlantingReport } = require("../src/utils/plantingVerification.util");
const { evaluateSiteLocation } = require("../src/utils/geo.util");

const GPS = { GPSLatitudeRef: "N", GPSLatitude: "12/1 40/1 1234/100", GPSLongitudeRef: "E", GPSLongitude: "123/1 52/1 3000/100" };
const jpeg = (exif) => sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } }).jpeg().withExif(exif).toBuffer();
const tiffOf = (bytes) => { const at = bytes.indexOf("Exif\0\0"); return bytes.subarray(at + 6, at + 2 + bytes.readUInt16BE(at - 2) - 2 + 2 - 2); };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }, u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), Buffer.from(type), body]); };
// A minimal HEIC container (container structure only; no picture data).
function heic(tiff, { method = 0, brands = ["heic", "mif1"], extraBrands = 0, hevc = true } = {}) {
  const ftyp = box("ftyp", Buffer.from(brands[0]), u32(0), Buffer.from([...brands, ...Array(extraBrands).fill("MiHB")].join("")));
  const exif = Buffer.concat([u32(6), Buffer.from("Exif\0\0"), tiff]);
  const build = (offset) => box("meta", u32(0),
    box("iinf", u32(0), u16(1), box("infe", Buffer.from([2, 0, 0, 0]), u16(7), u16(0), Buffer.from("Exif\0"))),
    box("iprp", box("ipco", ...(hevc ? [box("hvcC", Buffer.alloc(4))] : []), box("ispe", u32(0), u32(4032), u32(3024)))),
    box("iloc", Buffer.from([1, 0, 0, 0, 0x44, 0x00]), u16(1), u16(7), u16(method), u16(0), u16(1), u32(offset), u32(exif.length)),
    ...(method === 1 ? [box("idat", exif)] : []));
  const offset = method === 1 ? 0 : ftyp.length + build(0).length + 8;
  return Buffer.concat([ftyp, build(offset), box("mdat", exif)]);
}

test("JPEG, PNG, WebP and HEIC give the same original GPS, accuracy and time", async () => {
  const exif = { IFD0: { Make: "Apple", Model: "iPhone 13" }, IFD2: { DateTimeOriginal: "2026:11:20 08:30:00", OffsetTimeOriginal: "+08:00" },
    IFD3: { ...GPS, GPSHPositioningError: "475/100", GPSDateStamp: "2026:11:20", GPSTimeStamp: "0/1 30/1 0/1" } };
  const source = await jpeg(exif), tiff = tiffOf(source), img = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } });
  const files = { jpeg: source, png: await img().png().withExif(exif).toBuffer(), webp: await img().webp().withExif(exif).toBuffer(), heic: heic(tiff), idat: heic(tiff, { method: 1 }) };
  for (const [name, bytes] of Object.entries(files)) {
    const m = await extractImageMetadata(bytes);
    assert.equal(m.gpsStatus, "valid", name);
    assert.ok(Math.abs(m.latitude - 12.670094) < 1e-5 && Math.abs(m.longitude - 123.875) < 1e-5, name);
    assert.equal(m.gpsAccuracyMeters, 4.75, name);
    assert.equal(m.capturedAt.toISOString(), "2026-11-20T00:30:00.000Z", name);
    assert.deepEqual([m.gpsTimestampUtc, m.captureTimeZone, m.captureTimeContradictory], ["2026-11-20T00:30:00.000Z", "photo-offset", false], name);
  }
  // Newer iPhones list many compatible brands; the header length must not matter.
  assert.equal((await extractImageMetadata(heic(tiff, { extraBrands: 12 }))).gpsStatus, "valid");
});

test("missing, removed, invalid, unreadable and malformed metadata are told apart", async () => {
  const code = async (bytes) => gpsMetadataProblem(await extractImageMetadata(bytes))?.code ?? null;
  assert.equal(await code(await jpeg({ IFD0: { Make: "Test" } })), "PHOTO_GPS_MISSING");
  assert.equal(await code(await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).jpeg().toBuffer()), "PHOTO_GPS_MISSING");
  assert.equal(await code(await jpeg({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "0/0 0/0 0/0", GPSLongitudeRef: "E", GPSLongitude: "0/0 0/0 0/0" } })), "PHOTO_GPS_REMOVED");
  assert.equal(await code(await jpeg({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "0/1 0/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "0/1 0/1 0/1" } })), "PHOTO_GPS_REMOVED");
  assert.equal(await code(await jpeg({ IFD3: { ...GPS, GPSLatitude: "95/1 0/1 0/1" } })), "PHOTO_GPS_INVALID");
  assert.equal(await code(await jpeg({ IFD3: { ...GPS, GPSLatitude: "12/1 75/1 0/1" } })), "PHOTO_GPS_UNREADABLE");
  const broken = Buffer.from(await jpeg({ IFD3: GPS })); broken.write("XX", broken.indexOf("Exif\0\0") + 6);
  assert.equal(await code(broken), "PHOTO_METADATA_UNREADABLE");
  assert.equal(await code(heic(Buffer.from("not a tiff block"))), "PHOTO_METADATA_UNREADABLE");
  const noAccuracy = await extractImageMetadata(await jpeg({ IFD3: GPS }));
  assert.deepEqual([noAccuracy.gpsStatus, noAccuracy.gpsAccuracyMeters], ["valid", null], "unknown accuracy is never zero");
  assert.equal((await extractImageMetadata(await jpeg({ IFD3: { ...GPS, GPSHPositioningError: "0/1" } }))).gpsAccuracyMeters, null);
  // Re-encoding drops the metadata: it is reported as missing, not as valid.
  assert.equal(await code(await sharp(await jpeg({ IFD3: GPS })).jpeg().toBuffer()), "PHOTO_GPS_MISSING");
});

test("truncated and hostile files never crash or hang the parser", async () => {
  const valid = heic(tiffOf(await jpeg({ IFD3: GPS })));
  for (let end = 0; end < valid.length; end += 7) assert.doesNotThrow(() => parsePhotoMetadata(valid.subarray(0, end)));
  for (let at = 8; at < valid.length; at += 3) { const bytes = Buffer.from(valid); bytes[at] = 0xff; assert.doesNotThrow(() => captureTime(parsePhotoMetadata(bytes))); }
});

test("HEIC is accepted only where planting evidence asks for it, and AVIF or a container without HEVC never is", async () => {
  const bytes = heic(tiffOf(await jpeg({ IFD3: GPS })));
  assert.deepEqual(await validateImageBuffer(bytes, { allowHeic: true }), { width: 4032, height: 3024, format: "heic" });
  await assert.rejects(validateImageBuffer(bytes), /not a valid image/);
  await assert.rejects(validateImageBuffer(heic(Buffer.alloc(16), { hevc: false }), { allowHeic: true }), /not a valid image/);
  assert.equal(photoContainer(heic(Buffer.alloc(16), { brands: ["avif", "mif1"] })), null);
  assert.equal(photoContainer(Buffer.from("not an image at all")), null);
});

test("capture time: own offset, Philippine fallback, UTC GPS clock, midnight, future, invalid and contradictory", () => {
  const at = (dateTimeOriginal, offset = "", timestampUtc = null) => captureTime({ dateTimeOriginal, offset, gps: { timestampUtc } });
  assert.equal(at("2026:11:20 00:10:00").capturedAt.toISOString(), "2026-11-19T16:10:00.000Z");
  assert.equal(at("2026:11:20 00:10:00").zone, "Asia/Manila");
  assert.equal(at("2026:11:19 16:10:00", "+00:00").capturedAt.toISOString(), "2026-11-19T16:10:00.000Z");
  assert.equal(at("2026:11:20 01:10:00", "+09:00").capturedAt.toISOString(), "2026-11-19T16:10:00.000Z");
  assert.equal(at("2026:11:20 08:00:00", "nonsense").zone, "Asia/Manila");
  for (const value of ["", "0000:00:00 00:00:00", "    :  :     :  :  "]) assert.equal(at(value).status, "missing");
  for (const value of ["2026:02:30 08:00:00", "2026:11:20 25:00:00", "soon", "0001:01:01 00:00:00"]) assert.equal(at(value).status, "invalid");
  assert.equal(at("2026:11:20 08:00:00", "", "2026-11-20T00:00:05.000Z").contradictory, false);
  assert.equal(at("2026:11:20 08:00:00", "", "2026-11-25T00:00:00.000Z").contradictory, true);
  const flags = (metadata) => validatePlantingReport({ submittedLatitude: 1, submittedLongitude: 1, plantingDate: "2026-11-20", metadata: { latitude: 1, longitude: 1, ...metadata } }).suspiciousFlags;
  const now = Date.now;
  assert.deepEqual(flags({ capturedAt: null, captureTimeStatus: "invalid" }), ["INVALID_IMAGE_TIMESTAMP"]);
  assert.deepEqual(flags({ capturedAt: null, captureTimeStatus: "missing" }), ["TIMESTAMP_METADATA_MISSING"]);
  assert.ok(flags({ capturedAt: new Date(now() + 3600000) }).includes("FUTURE_IMAGE_TIMESTAMP"));
  assert.equal(manilaDayStart("2026-11-20").toISOString(), "2026-11-19T16:00:00.000Z");
});

test("the planting-day check does not depend on the server's time zone", () => {
  const script = `const {validatePlantingReport:v}=require(${JSON.stringify(path.resolve("src/utils/plantingVerification.util.js"))}),{captureTime:c}=require(${JSON.stringify(path.resolve("src/utils/photoMetadata.util.js"))});
    const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Manila"}).format(new Date(Date.now()-60000)),hm=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Manila",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(Date.now()-60000));
    const m=(d,t)=>({latitude:1,longitude:1,capturedAt:c({dateTimeOriginal:d.replaceAll("-",":")+" "+t}).capturedAt});
    const f=(d,t,p)=>v({submittedLatitude:1,submittedLongitude:1,plantingDate:p,metadata:m(d,t)}).suspiciousFlags;
    console.log(JSON.stringify([f(day,hm,day),f("2026-11-20","23:59:59","2026-11-20"),f("2026-11-20","00:00:01","2026-11-20"),f("2026-11-21","00:30:00","2026-11-20")]));`;
  const results = ["UTC", "Asia/Manila", "America/Los_Angeles"].map((TZ) => execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ }, encoding: "utf8" }).trim());
  for (const result of results) assert.equal(result, JSON.stringify([[], [], [], ["TIMESTAMP_MISMATCH"]]));
});

test("site location: radius, polygon forms and edges, 50 m fallback, and a nearby place in the same barangay stays outside", () => {
  const center = { latitude: 12.67, longitude: 123.87 };
  const square = [[123.869, 12.669], [123.871, 12.669], [123.871, 12.671], [123.869, 12.671], [123.869, 12.669]];
  const list = square.slice(0, 4).map(([lng, lat]) => ({ lat, lng }));
  const hole = [[123.8698, 12.6698], [123.8702, 12.6698], [123.8702, 12.6702], [123.8698, 12.6702], [123.8698, 12.6698]];
  for (const polygon of [list, { type: "Polygon", coordinates: [square] }, { type: "MultiPolygon", coordinates: [[square]] }]) {
    assert.deepEqual([evaluateSiteLocation({ ...center, polygon }, 12.6705, 123.8705).inside, evaluateSiteLocation({ ...center, polygon }, 12.6705, 123.8705).boundaryRule], [true, "site-polygon"]);
    assert.equal(evaluateSiteLocation({ ...center, polygon }, 12.671, 123.87).inside, true, "the boundary line is inside");
    assert.equal(evaluateSiteLocation({ ...center, polygon }, 12.675, 123.87).inside, false, "same barangay, outside the site");
  }
  assert.equal(evaluateSiteLocation({ ...center, polygon: { type: "Polygon", coordinates: [square, hole] } }, 12.67, 123.87).inside, false);
  assert.equal(evaluateSiteLocation({ ...center, polygon: { type: "Polygon", coordinates: [square.map(([a, b]) => [b, a])] } }, 12.67, 123.87).inside, false, "swapped coordinates are not accepted");
  // A badly marked centre is not repaired: the polygon, when it applies, still decides, and the radius is never widened.
  assert.equal(evaluateSiteLocation({ latitude: 12.68, longitude: 123.88, polygon: list }, 12.67, 123.87).inside, true);
  assert.deepEqual([evaluateSiteLocation({ ...center, coverageRadiusMeters: 100 }, 12.6708, 123.87).inside, evaluateSiteLocation({ ...center, coverageRadiusMeters: 100 }, 12.6712, 123.87).inside], [true, false]);
  assert.deepEqual([evaluateSiteLocation(center, 12.6704, 123.87).inside, evaluateSiteLocation(center, 12.6706, 123.87).inside], [true, false]);
  for (const polygon of [null, [], [null, {}, {}], { type: "Point", coordinates: [1, 2] }]) assert.equal(evaluateSiteLocation({ ...center, polygon }, 12.675, 123.87).inside, false);
});

test("original iPhone, Samsung and Pixel files (see tests/fixtures/real-photos)", async () => {
  const root = path.join(__dirname, "fixtures", "real-photos"), expected = JSON.parse(fs.readFileSync(path.join(root, "expected.json"), "utf8"));
  assert.equal(Object.keys(expected).length, 5);
  for (const [file, row] of Object.entries(expected)) {
    const bytes = require("node:zlib").gunzipSync(fs.readFileSync(path.join(root, `${file}.gz`))), m = await extractImageMetadata(bytes);
    assert.equal(m.gpsStatus, row.gps ? "valid" : "missing", file);
    if (row.gps) assert.ok(Math.abs(m.latitude - row.gps[0]) < 1e-6 && Math.abs(m.longitude - row.gps[1]) < 1e-6, file);
    assert.equal(m.gpsAccuracyMeters === null ? null : Number(m.gpsAccuracyMeters.toFixed(3)), row.accuracyMeters, file);
    assert.equal(m.capturedAt?.toISOString() ?? null, row.capturedAt, file);
    assert.equal(m.deviceModel, row.model, file);
    assert.equal((await validateImageBuffer(bytes, { allowHeic: true })).format, row.format, file);
  }
});

test("a crafted HEIC location table or EXIF directory is refused quickly", () => {
  const meta = (iloc) => Buffer.concat([box("ftyp", Buffer.from("heic"), u32(0), Buffer.from("heicmif1")), box("meta", u32(0), iloc)]);
  const started = Date.now();
  // 4096 items, each claiming 65535 zero-size extents.
  const items = Buffer.concat(Array.from({ length: 4096 }, (_, id) => Buffer.concat([u16(id + 1), u16(0), u16(0), u16(65535)])));
  assert.equal(parsePhotoMetadata(meta(box("iloc", Buffer.from([1, 0, 0, 0, 0x00, 0x00]), u16(4096), items))).metadataStatus, "malformed");
  const tiff = Buffer.alloc(8 + 2 + 12 * 1024); tiff.write("MM\0*", 0, "latin1"); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(1024, 8);
  for (let i = 0; i < 1024; i += 1) { const at = 10 + i * 12; tiff.writeUInt16BE(0x100 + i, at); tiff.writeUInt16BE(3, at + 2); tiff.writeUInt32BE(65535, at + 4); tiff.writeUInt32BE(8, at + 8); }
  assert.doesNotThrow(() => parsePhotoMetadata(heic(tiff)));
  assert.ok(Date.now() - started < 1500, "bounded work");
});
