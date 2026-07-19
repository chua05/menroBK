const {
  calculateDistanceMeters,
} = require("./geo.util");

const GPS_TOLERANCE_METERS = 20;

const DAY_IN_MILLISECONDS =
  24 * 60 * 60 * 1000;

const validatePlantingReport = ({
  submittedLatitude,
  submittedLongitude,
  plantingDate,
  metadata,
}) => {
  const suspiciousFlags = [];

  const gpsMetadataPresent =
    metadata.latitude !== null &&
    metadata.longitude !== null;

  const timestampMetadataPresent =
    metadata.capturedAt !== null;

  let gpsDistanceMeters = null;
  let gpsValid = false;
  let timestampValid = false;

  // GPS VALIDATION
  if (gpsMetadataPresent) {
    gpsDistanceMeters =
      calculateDistanceMeters(
        submittedLatitude,
        submittedLongitude,
        metadata.latitude,
        metadata.longitude
      );

    gpsValid =
      gpsDistanceMeters <= GPS_TOLERANCE_METERS;

    if (!gpsValid) {
      suspiciousFlags.push("GPS_MISMATCH");
    }
  } else {
    suspiciousFlags.push(
      "GPS_METADATA_MISSING"
    );
  }

  // TIMESTAMP VALIDATION
  if (timestampMetadataPresent) {
    const capturedDate =
      new Date(metadata.capturedAt);

    const declaredPlantingDate =
      new Date(`${plantingDate}T00:00:00`);

    const currentDate = new Date();

    if (
      Number.isNaN(capturedDate.getTime()) ||
      Number.isNaN(
        declaredPlantingDate.getTime()
      )
    ) {
      suspiciousFlags.push(
        "INVALID_IMAGE_TIMESTAMP"
      );
    } else {
      const dateDifference =
        Math.abs(
          capturedDate.getTime() -
            declaredPlantingDate.getTime()
        );

      timestampValid =
        dateDifference <=
          DAY_IN_MILLISECONDS &&
        capturedDate <= currentDate;

      if (capturedDate > currentDate) {
        suspiciousFlags.push(
          "FUTURE_IMAGE_TIMESTAMP"
        );
      } else if (!timestampValid) {
        suspiciousFlags.push(
          "TIMESTAMP_MISMATCH"
        );
      }
    }
  } else {
    suspiciousFlags.push(
      "TIMESTAMP_METADATA_MISSING"
    );
  }

  const automatedStatus =
    suspiciousFlags.length === 0
      ? "Passed Automated Check"
      : "Flagged";

  return {
    gpsMetadataPresent,
    timestampMetadataPresent,
    gpsDistanceMeters,
    gpsValid,
    timestampValid,
    suspiciousFlags,
    automatedStatus,
  };
};

module.exports = {
  validatePlantingReport,
  GPS_TOLERANCE_METERS,
};