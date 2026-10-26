const EARTH_RADIUS_METERS = 6371000;

const degreesToRadians = (degrees) => {
  return degrees * (Math.PI / 180);
};

const calculateDistanceMeters = (
  latitude1,
  longitude1,
  latitude2,
  longitude2
) => {
  const lat1 = degreesToRadians(latitude1);
  const lat2 = degreesToRadians(latitude2);

  const latitudeDifference =
    degreesToRadians(latitude2 - latitude1);

  const longitudeDifference =
    degreesToRadians(longitude2 - longitude1);

  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(longitudeDifference / 2) ** 2;

  const angularDistance =
    2 *
    Math.atan2(
      Math.sqrt(haversine),
      Math.sqrt(1 - haversine)
    );

  return EARTH_RADIUS_METERS * angularDistance;
};

const isPointInPolygon = (latitude, longitude, polygon) => {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = Number(polygon[i]?.lat);
    const xi = Number(polygon[i]?.lng);
    const yj = Number(polygon[j]?.lat);
    const xj = Number(polygon[j]?.lng);
    if (![xi, yi, xj, yj].every(Number.isFinite)) return false;
    const intersects = yi > latitude !== yj > latitude &&
      longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

const pointLocationInGeoJsonRing = (latitude, longitude, ring) => {
  if (!Array.isArray(ring) || ring.length < 3) return "outside";
  const x = Number(longitude);
  const y = Number(latitude);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = Number(ring[j]?.[0]);
    const ay = Number(ring[j]?.[1]);
    const bx = Number(ring[i]?.[0]);
    const by = Number(ring[i]?.[1]);
    if (![ax, ay, bx, by].every(Number.isFinite)) return "outside";
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    const scale = Math.max(1, Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by));
    if (Math.abs(cross) <= Number.EPSILON * scale * 16 &&
        x >= Math.min(ax, bx) && x <= Math.max(ax, bx) &&
        y >= Math.min(ay, by) && y <= Math.max(ay, by)) return "edge";
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
  }
  return inside ? "inside" : "outside";
};

const isPointInGeoJsonPolygon = (latitude, longitude, coordinates) => {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return false;
  const outer = pointLocationInGeoJsonRing(latitude, longitude, coordinates[0]);
  if (outer === "outside") return false;
  return !coordinates.slice(1).some((hole) =>
    pointLocationInGeoJsonRing(latitude, longitude, hole) === "inside"
  );
};

const isPointInGeoJsonGeometry = (latitude, longitude, geometry) => {
  if (geometry?.type === "Polygon") {
    return isPointInGeoJsonPolygon(latitude, longitude, geometry.coordinates);
  }
  if (geometry?.type === "MultiPolygon") {
    return geometry.coordinates.some((polygon) =>
      isPointInGeoJsonPolygon(latitude, longitude, polygon)
    );
  }
  return false;
};

const isPointInGeoJsonFeatureCollection = (latitude, longitude, geoJson) => {
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude)) ||
      geoJson?.type !== "FeatureCollection" || !Array.isArray(geoJson.features)) {
    return false;
  }
  return geoJson.features.some((feature) =>
    isPointInGeoJsonGeometry(Number(latitude), Number(longitude), feature?.geometry)
  );
};

const getContainingGeoJsonFeatures = (latitude, longitude, geoJson) => {
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude)) ||
      geoJson?.type !== "FeatureCollection" || !Array.isArray(geoJson.features)) {
    return [];
  }
  return geoJson.features.filter((feature) =>
    isPointInGeoJsonGeometry(Number(latitude), Number(longitude), feature?.geometry)
  );
};

module.exports = {
  calculateDistanceMeters,
  isPointInPolygon,
  getContainingGeoJsonFeatures,
  isPointInGeoJsonGeometry,
  isPointInGeoJsonFeatureCollection,
};
