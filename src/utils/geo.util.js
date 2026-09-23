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

module.exports = {
  calculateDistanceMeters,
  isPointInPolygon,
};
