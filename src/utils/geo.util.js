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

module.exports = {
  calculateDistanceMeters,
};