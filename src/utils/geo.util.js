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

const isPointInGeoJsonRing = (latitude, longitude, ring) => {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  return isPointInPolygon(
    latitude,
    longitude,
    ring.map((coordinate) => ({
      lat: coordinate?.[1],
      lng: coordinate?.[0],
    }))
  );
};

const isPointInGeoJsonPolygon = (latitude, longitude, coordinates) => {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return false;
  if (!isPointInGeoJsonRing(latitude, longitude, coordinates[0])) return false;
  return !coordinates.slice(1).some((hole) =>
    isPointInGeoJsonRing(latitude, longitude, hole)
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

module.exports = {
  calculateDistanceMeters,
  isPointInPolygon,
  isPointInGeoJsonFeatureCollection,
};
